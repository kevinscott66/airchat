/**
 * Одно соединение с базой на всё приложение — и на все вкладки браузера.
 *
 * v4.32.581. Прежде вторая вкладка AirChat не запускалась: OPFS отдаёт
 * `FileSystemSyncAccessHandle` на файл ровно один раз на происхождение, и
 * expo-sqlite падал на открытии. Экран запуска честно объяснял причину и
 * просил закрыть остальные вкладки — но просить об этом человека неправильно.
 *
 * Соединение осталось одним, сменился только его владелец: не вкладка, а
 * приложение. Одна вкладка держит соединение и выполняет операторы остальных,
 * остальные обращаются к ней. Держатель выбирается Web Locks — тем же
 * механизмом, которым браузер разнимает вкладки во всех подобных случаях, — и
 * когда держатель закрывается, блокировка достаётся следующей вкладке: та
 * открывает базу и продолжает, не перезагружая страницу.
 *
 * На телефоне вкладок нет и разговаривать не с кем — там остаётся только
 * очередь операторов (см. sqlGate), которая одинаково нужна на всех
 * платформах.
 *
 * Границы: соединение отдаётся под видом `SQLite.SQLiteDatabase`, но это
 * обёртка, а не сама база. Она умеет ровно то, чем пользуется хранилище —
 * runAsync, getAllAsync, getFirstAsync, execAsync, withTransactionAsync,
 * closeAsync. Если понадобится что-то ещё, добавлять надо сюда, а не обходить
 * обёртку: в обход неё оператор уйдёт мимо очереди, а в чужой вкладке — в
 * никуда.
 */
import { Platform } from 'react-native';
import type * as SQLite from 'expo-sqlite';

import { log } from '../logger';
import {
  LeaseCaller,
  LeaseRetryable,
  serveLeaseRequest,
  type LeaseMessage,
  type LeaseOp,
} from './dbLeaseProtocol';
import { SqlGate, txnEffect } from './sqlGate';

/**
 * Имена канала и блокировки — на каждую базу свои.
 *
 * Баз у приложения несколько: переписка, лента каждого профиля, кэш IPFS,
 * справочник ретрансляторов. Файл у каждой отдельный, и занимает его OPFS тоже
 * отдельно, поэтому и держатель у каждой свой: вкладка может держать одну базу
 * и обращаться к соседней вкладке за другой.
 */
const channelFor = (name: string): string => `airchat-db-lease:${name}`;
const lockFor = (name: string): string => `airchat-db-owner:${name}`;

/** Метка этой вкладки. Совпадений можно не бояться: случайных бит хватает. */
const SELF = `t${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/**
 * Уже выданные аренды — по имени базы.
 *
 * Нужен не ради экономии: блокировку вкладка держит до конца своей жизни, и
 * вторая аренда той же базы в той же вкладке встала бы в очередь за первой,
 * то есть за самой собой. Повторное открытие (после closeLocalDatabase на
 * выходе из профиля) обязано получить ту же аренду или начать с чистого
 * листа — но не ждать себя.
 */
const leases = new Map<string, Promise<Leased>>();

/**
 * Аренда, из которой каждый желающий берёт собственную обёртку.
 *
 * v4.32.582: раньше `openLeasedDatabase` отдавала всем одну и ту же обёртку, а
 * та закрывала аренду целиком. Держателей у одной базы бывает несколько —
 * например, две FeedStorage одного профиля живут рядом при переключении
 * контекста и при уборке ленты удалённого аккаунта. Первый же `close()` рвал
 * соединение и второму: его `db` оставался не-null, и каждый следующий запрос
 * падал с `db_lease_no_owner`. Лента открывалась и тут же сообщала, что база
 * занята. Теперь обёртка своя у каждого, а настоящее закрытие — по последнему.
 */
type Leased = { checkout: () => Db };

type Db = SQLite.SQLiteDatabase;
type RunResult = SQLite.SQLiteRunResult;

/** Умеет ли браузер разнимать вкладки. */
function hasLeaseSupport(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function' &&
    typeof BroadcastChannel === 'function'
  );
}

type Lease = {
  /** Открытая здесь база; null — держатель в другой вкладке. */
  local: Db | null;
  caller: LeaseCaller | null;
  /**
   * Роль меняется: блокировка уже наша, а база ещё открывается.
   *
   * Открытие включает миграции и на первом запуске занимает секунды. Всё это
   * время отвечать некому: соединения ещё нет, а прежний держатель закрылся.
   * Барьер существует, чтобы никто — ни эта вкладка, ни соседняя — не получил
   * за это время отказ по сроку там, где надо было просто подождать.
   */
  settling: Promise<void> | null;
};

/**
 * Общий вход: и держатель, и проситель зовут одно и то же.
 *
 * Держатель прогоняет оператор через очередь, проситель — через канал (а в
 * чужой вкладке он попадёт в ту же очередь). Роль может смениться прямо
 * посреди работы, поэтому она проверяется на каждом операторе, а не один раз.
 */
async function perform<T>(state: Lease, gate: SqlGate, op: LeaseOp): Promise<T> {
  const effect = op.kind === 'exec' ? txnEffect(op.sql) : 'none';
  if (state.settling) await state.settling.catch(() => undefined);
  if (state.local) {
    const dbh = state.local;
    return gate.submit(SELF, effect, () => runOn(dbh, op)) as Promise<T>;
  }
  if (!state.caller) throw new Error('db_lease_no_owner');
  try {
    return await state.caller.call<T>(op);
  } catch (e) {
    // Держатель ушёл ровно на этом операторе. Роль к этому моменту могла уже
    // перейти сюда — тогда повтор выполнится здесь же, и человек ничего не
    // заметит. Повтор ровно один: второй отказ подряд — это не смена
    // держателя, а настоящая беда.
    if (!(e instanceof LeaseRetryable)) throw e;
    if (state.settling) await state.settling.catch(() => undefined);
    if (state.local) {
      const dbh = state.local;
      return gate.submit(SELF, effect, () => runOn(dbh, op)) as Promise<T>;
    }
    if (!state.caller) throw e;
    return state.caller.call<T>(op);
  }
}

function runOn(dbh: Db, op: LeaseOp): Promise<unknown> {
  switch (op.kind) {
    case 'run':
      return dbh.runAsync(op.sql, op.params as never);
    case 'all':
      return dbh.getAllAsync(op.sql, op.params as never);
    case 'first':
      return dbh.getFirstAsync(op.sql, op.params as never);
    case 'exec':
      return dbh.execAsync(op.sql);
  }
}

/** Разложить необязательный хвост вызова в список параметров. */
const args = (params: unknown[]): unknown[] =>
  params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;

function makeFacade(state: Lease, gate: SqlGate, onClose: () => Promise<void>): Db {
  const facade = {
    runAsync: (sql: string, ...params: unknown[]): Promise<RunResult> =>
      perform<RunResult>(state, gate, { kind: 'run', sql, params: args(params) }),
    getAllAsync: (sql: string, ...params: unknown[]): Promise<unknown[]> =>
      perform<unknown[]>(state, gate, { kind: 'all', sql, params: args(params) }),
    getFirstAsync: (sql: string, ...params: unknown[]): Promise<unknown> =>
      perform<unknown>(state, gate, { kind: 'first', sql, params: args(params) }),
    execAsync: (sql: string): Promise<void> =>
      perform<void>(state, gate, { kind: 'exec', sql }),
    /**
     * Своя реализация, а не вызов родной.
     *
     * Родная выполнила бы BEGIN и COMMIT мимо обёртки — очередь не узнала бы,
     * что транзакция открыта, и пустила бы внутрь неё чужие операторы.
     */
    withTransactionAsync: async (task: () => Promise<void>): Promise<void> => {
      await facade.execAsync('BEGIN');
      try {
        await task();
        await facade.execAsync('COMMIT');
      } catch (e) {
        try {
          await facade.execAsync('ROLLBACK');
        } catch {
          /* Откатывать нечего: соединение уже сказало всё, что могло. */
        }
        throw e;
      }
    },
    closeAsync: onClose,
  };
  // Обёртка покрывает то, чем пользуется хранилище, а не весь SQLiteDatabase:
  // см. границы в шапке модуля.
  return facade as unknown as Db;
}

/**
 * Открыть базу с учётом остальных вкладок.
 *
 * `openReal` вызывается только у держателя и только один раз за роль.
 */
export function openLeasedDatabase(name: string, openReal: () => Promise<Db>): Promise<Db> {
  let lease = leases.get(name);
  if (!lease) {
    lease = openLease(name, openReal);
    leases.set(name, lease);
    // Не открылась — запоминать нечего: следующая попытка должна начаться заново.
    const fresh = lease;
    void fresh.catch(() => {
      if (leases.get(name) === fresh) leases.delete(name);
    });
  }
  return lease.then((l) => l.checkout());
}

async function openLease(name: string, openReal: () => Promise<Db>): Promise<Leased> {
  const gate = new SqlGate(undefined, (owner) =>
    log.warn('db_lease_txn_abandoned', { db: name, owner: owner.slice(0, 8) })
  );
  const state: Lease = { local: null, caller: null, settling: null };

  let closed = false;
  const forget = (): void => {
    closed = true;
    leases.delete(name);
  };

  /**
   * Раздать обёртки и закрыть базу по последней отданной.
   *
   * Пересчёт ведётся по обёрткам, а не по вызовам `close()`: повторное закрытие
   * одной и той же обёртки не должно уводить счётчик в минус и рвать соединение
   * под чужой работой.
   */
  const share = (realClose: () => Promise<void>): Leased => {
    let holders = 0;
    return {
      checkout: (): Db => {
        holders += 1;
        let released = false;
        return makeFacade(state, gate, async () => {
          if (released) return;
          released = true;
          holders -= 1;
          if (holders > 0) return;
          await realClose();
        });
      },
    };
  };

  if (!hasLeaseSupport()) {
    state.local = await openReal();
    return share(async () => {
      forget();
      const own = state.local;
      state.local = null;
      await own?.closeAsync();
    });
  }

  const channel = new BroadcastChannel(channelFor(name));
  const post = (m: LeaseMessage): void => channel.postMessage(m);
  state.caller = new LeaseCaller(SELF, post);
  let epoch = 0;

  let owning = false;
  /** Отпустить блокировку текущего владения. Пересоздаётся на каждое владение. */
  let releaseLock: (() => void) | null = null;

  const becomeOwner = async (): Promise<void> => {
    // Очередь за блокировкой могла достояться уже после закрытия аренды:
    // открывать базу такой вкладке незачем, а держать файл — вредно.
    if (closed) return;
    let settled: () => void = () => {};
    let broke: (e: unknown) => void = () => {};
    state.settling = new Promise<void>((res, rej) => {
      settled = res;
      broke = rej;
    });
    // Барьер ждут через `.catch`, но и у самого обещания должен быть хозяин:
    // без этого отказ открытия улетел бы необработанным.
    state.settling.catch(() => undefined);
    owning = true;
    try {
      state.local = await openReal();
    } catch (e) {
      owning = false;
      broke(e);
      state.settling = null;
      throw e;
    }
    state.settling = null;
    settled();
    state.caller?.abortAll('db_lease_owner_changed');
    post({ t: 'lead', epoch: ++epoch });
    log.info('db_lease_owner_here', { db: name, tab: SELF.slice(0, 8) });
  };

  const serve = async (m: LeaseMessage & { t: 'req' }): Promise<void> => {
    if (state.settling) await state.settling.catch(() => undefined);
    const dbh = state.local;
    if (!dbh) return;
    await serveLeaseRequest(
      m,
      (owner, op) =>
        gate.submit(owner, op.kind === 'exec' ? txnEffect(op.sql) : 'none', () => runOn(dbh, op)),
      post
    );
  };

  channel.onmessage = (ev: MessageEvent<LeaseMessage>) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (state.caller?.accept(m)) return;
    if (owning) {
      // Отвечает тот, у кого блокировка, — даже если база ещё открывается:
      // запрос дождётся барьера, а не истечёт по сроку.
      if (m.t === 'req') {
        void serve(m);
        return;
      }
      // Вкладка ушла, не закрыв транзакцию: снять затвор сразу, не дожидаясь
      // срока — иначе база стояла бы запертой ради того, кого уже нет.
      if (m.t === 'bye') gate.release(m.owner);
      // Уступает только спрятанный: видимый держатель никому ничего не должен,
      // и два видимых окна не перебрасывают базу друг другу.
      if (m.t === 'yield' && typeof document !== 'undefined' && document.hidden) void stepDown();
      return;
    }
    // Держатель сменился: незавершённые запросы ушли в никуда.
    if (m.t === 'lead') state.caller?.abortAll('db_lease_owner_changed');
  };

  /**
   * Забрать блокировку и не отпускать её до конца жизни вкладки.
   *
   * Обещание разрешается, как только роль ясна, — а сама блокировка держится
   * дальше: обработчик не завершается никогда, и браузер отдаёт её следующей
   * вкладке только когда эта закроется.
   */
  const hold = (opts: LockOptions): Promise<boolean> =>
    new Promise<boolean>((decided, failed) => {
      void navigator.locks
        .request(lockFor(name), opts, async (lock) => {
          if (!lock) {
            decided(false);
            return;
          }
          const gone = new Promise<void>((r) => {
            releaseLock = r;
          });
          try {
            await becomeOwner();
            if (closed) return;
          } catch (e) {
            // База не открылась вовсе — это не «занято другой вкладкой», а
            // настоящий отказ хранилища, и разбирать его экрану запуска.
            failed(e);
            return;
          }
          decided(true);
          // Блокировка держится до закрытия вкладки — или до того, как
          // соединение отдадут явно: на выходе из профиля и когда база
          // переезжает к видимой вкладке.
          await gone;
        })
        .catch(failed);
    });

  const got = await hold({ ifAvailable: true });
  if (!got && !state.local) {
    // Соединение у другой вкладки. Встаём в очередь: когда та закроется,
    // блокировка достанется нам, и база откроется здесь без перезагрузки.
    void hold({}).catch((e: unknown) => {
      log.warn('db_lease_takeover_failed', {
        db: name,
        err: e instanceof Error ? e.message : String(e),
      });
    });
    log.info('db_lease_owner_elsewhere', { db: name, tab: SELF.slice(0, 8) });
  }

  /**
   * Отдать соединение: закрыть базу и отпустить блокировку, снова встав в
   * очередь. Вкладка при этом не перестаёт работать — она становится
   * просителем и продолжает через нового держателя.
   */
  const stepDown = async (): Promise<void> => {
    if (!owning || closed || !state.local) return;
    const own = state.local;
    owning = false;
    state.local = null;
    // Дать доработать тому, что уже в очереди: пустой оператор встаёт за ними
    // и дожидается своей очереди, а закрывать базу под чужим запросом нельзя.
    try {
      await gate.submit(SELF, 'none', async () => undefined);
      await own.closeAsync();
    } catch (e) {
      log.warn('db_lease_step_down_failed', {
        db: name,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    releaseLock?.();
    releaseLock = null;
    log.info('db_lease_handed_over', { db: name, tab: SELF.slice(0, 8) });
    void hold({}).catch(() => undefined);
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || owning || closed) return;
      post({ t: 'yield', from: SELF });
    });
  }

  if (typeof addEventListener === 'function') {
    // pagehide, а не beforeunload: Safari на iPhone второй не шлёт вовсе.
    addEventListener('pagehide', () => {
      try {
        post({ t: 'bye', owner: SELF });
      } catch {
        /* Канал уже закрыт вместе со страницей — прощаться не обязательно. */
      }
    });
  }

  return share(async () => {
    forget();
    // Закрывает только держатель: у просителя своего соединения нет, а чужое
    // закрывать нельзя — им пользуются другие вкладки.
    const own = state.local;
    state.local = null;
    owning = false;
    state.caller?.abortAll('db_lease_closed');
    state.caller = null;
    if (own) await own.closeAsync();
    // Сперва закрыли, потом отпустили: иначе соседняя вкладка успела бы
    // получить блокировку на ещё не отданный файл.
    releaseLock?.();
    releaseLock = null;
    channel.close();
  });
}
