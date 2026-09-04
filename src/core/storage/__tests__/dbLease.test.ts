/**
 * v4.32.581 — две вкладки на одном соединении.
 *
 * Проверяется то самое, из-за чего вторая вкладка раньше не запускалась:
 * база открывается ровно один раз, вторая вкладка работает через первую, а
 * когда первая закрывается — вторая забирает базу себе и продолжает.
 *
 * Браузера здесь нет: Web Locks и BroadcastChannel подменены, база — список в
 * памяти. Подменять их честно, потому что проверяется не браузер, а наша
 * раскладка ролей поверх него.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

/** Канал: доставляет всем, кроме отправителя, как настоящий. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  close(): void {
    FakeChannel.all = FakeChannel.all.filter((c) => c !== this);
  }
  postMessage(data: unknown): void {
    const copy = JSON.parse(JSON.stringify(data)) as unknown;
    for (const c of FakeChannel.all) {
      if (c !== this && c.name === this.name) setImmediate(() => c.onmessage?.({ data: copy }));
    }
  }
}

/** Блокировка: одна на имя, очередь в порядке обращения. */
class FakeLocks {
  private held = new Map<string, { release: () => void }>();
  private queue = new Map<string, Array<() => void>>();

  request(
    name: string,
    opts: { ifAvailable?: boolean },
    cb: (lock: unknown) => Promise<unknown>
  ): Promise<unknown> {
    const grant = (): Promise<unknown> => {
      const entry = { release: () => this.next(name) };
      this.held.set(name, entry);
      return Promise.resolve(cb({ name })).finally(() => {
        if (this.held.get(name) === entry) {
          this.held.delete(name);
          this.next(name);
        }
      });
    };
    if (!this.held.has(name)) return grant();
    if (opts.ifAvailable) return Promise.resolve(cb(null));
    return new Promise((resolve) => {
      const q = this.queue.get(name) ?? [];
      q.push(() => resolve(grant()));
      this.queue.set(name, q);
    });
  }

  /** Вкладка закрылась: блокировка уходит следующему в очереди. */
  drop(name: string): void {
    this.held.delete(name);
    this.next(name);
  }

  private next(name: string): void {
    const q = this.queue.get(name);
    const w = q?.shift();
    if (w) w();
  }
}

/** База: хранит строки, считает открытия и умеет транзакцию. */
function makeFakeDb(state: { opens: number }) {
  state.opens += 1;
  const rows: Array<{ k: string; v: string }> = [];
  let snapshot: typeof rows | null = null;
  const db = {
    runAsync: async (sql: string, params: unknown[] = []) => {
      if (/^INSERT/i.test(sql)) rows.push({ k: String(params[0]), v: String(params[1]) });
      return { lastInsertRowId: rows.length, changes: 1 };
    },
    getAllAsync: async () => rows.map((r) => ({ ...r })),
    getFirstAsync: async () => (rows.length ? { ...rows[rows.length - 1] } : null),
    execAsync: async (sql: string) => {
      if (/^BEGIN/i.test(sql)) snapshot = rows.map((r) => ({ ...r }));
      if (/^ROLLBACK/i.test(sql) && snapshot) rows.splice(0, rows.length, ...snapshot);
      if (/^(COMMIT|ROLLBACK)/i.test(sql)) snapshot = null;
    },
    closeAsync: async () => undefined,
  };
  return db;
}

type Opened = Awaited<ReturnType<typeof loadTab>>;

/** Отдельная вкладка = отдельный экземпляр модуля со своей меткой. */
async function loadTab(open: () => Promise<unknown>): Promise<{
  db: {
    runAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
    getAllAsync: (sql: string) => Promise<Array<{ k: string; v: string }>>;
    execAsync: (sql: string) => Promise<void>;
    withTransactionAsync: (t: () => Promise<void>) => Promise<void>;
  };
}> {
  let mod!: typeof import('../dbLease');
  jest.isolateModules(() => {
    mod = require('../dbLease') as typeof import('../dbLease');
  });
  const db = (await mod.openLeasedDatabase('kv.db', open as never)) as unknown as Opened['db'];
  return { db };
}

describe('аренда соединения между вкладками', () => {
  let locks: FakeLocks;
  let state: { opens: number };

  beforeEach(() => {
    FakeChannel.all = [];
    locks = new FakeLocks();
    state = { opens: 0 };
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
    (globalThis as { navigator?: unknown }).navigator = { locks };
    (globalThis as { addEventListener?: unknown }).addEventListener = () => undefined;
  });

  const open = async (): Promise<unknown> => makeFakeDb(state);

  it('вторая вкладка запускается, а база открывается один раз', async () => {
    const one = await loadTab(open);
    const two = await loadTab(open);
    expect(state.opens).toBe(1);

    await two.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['из второй', '1']);
    await tick();

    // Запись второй вкладки видна первой: соединение общее.
    expect(await one.db.getAllAsync('SELECT * FROM kv')).toEqual([{ k: 'из второй', v: '1' }]);
  });

  it('обе вкладки читают то, что записала любая из них', async () => {
    const one = await loadTab(open);
    const two = await loadTab(open);

    await one.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['a', '1']);
    await two.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['b', '2']);

    expect(await two.db.getAllAsync('SELECT * FROM kv')).toHaveLength(2);
    expect(await one.db.getAllAsync('SELECT * FROM kv')).toHaveLength(2);
  });

  it('закрытие держателя передаёт базу второй вкладке без перезагрузки', async () => {
    const one = await loadTab(open);
    const two = await loadTab(open);
    await one.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['до', '1']);

    // Первую вкладку закрыли: блокировка освободилась.
    locks.drop('airchat-db-owner:kv.db');
    await tick(10);
    expect(state.opens).toBe(2);

    await two.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['после', '2']);
    const rows = await two.db.getAllAsync('SELECT * FROM kv');
    expect(rows.map((r) => r.k)).toEqual(['после']);
  });

  it('повторное открытие в той же вкладке не встаёт в очередь за собой', async () => {
    // Блокировку вкладка держит до конца жизни. Без учёта уже выданных аренд
    // второе открытие ждало бы освобождения блокировки, которую держит оно же.
    let mod!: typeof import('../dbLease');
    jest.isolateModules(() => {
      mod = require('../dbLease') as typeof import('../dbLease');
    });
    const first = await mod.openLeasedDatabase('kv.db', open as never);
    const second = (await Promise.race([
      mod.openLeasedDatabase('kv.db', open as never),
      new Promise((_, rej) => setTimeout(() => rej(new Error('зависло')), 200)),
    ])) as unknown as Opened['db'];
    expect(state.opens).toBe(1);
    // Соединение общее, а обёртки разные: закрытие одной не касается другой.
    expect(second).not.toBe(first);
    await second.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['общая', '1']);
    expect(await (first as unknown as Opened['db']).getAllAsync('SELECT * FROM kv')).toHaveLength(1);
  });

  it('закрытие одного держателя не рвёт соединение второму', async () => {
    // v4.32.582: две FeedStorage одного профиля живут рядом — при смене
    // контекста и при уборке ленты удалённого аккаунта. Раньше обёртка была
    // одна на всех, и первый же close() убивал аренду: у второго держателя
    // `db` оставался не-null, и каждый запрос падал с db_lease_no_owner —
    // лента открывалась и тут же писала, что база занята.
    let mod!: typeof import('../dbLease');
    jest.isolateModules(() => {
      mod = require('../dbLease') as typeof import('../dbLease');
    });
    const a = (await mod.openLeasedDatabase('kv.db', open as never)) as unknown as Opened['db'] & {
      closeAsync: () => Promise<void>;
    };
    const b = (await mod.openLeasedDatabase('kv.db', open as never)) as unknown as Opened['db'];
    expect(state.opens).toBe(1);

    await a.closeAsync();
    await tick(6);

    await b.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['жив', '1']);
    expect(await b.getAllAsync('SELECT * FROM kv')).toHaveLength(1);
    // Настоящее закрытие не состоялось: база всё та же, переоткрытий не было.
    expect(state.opens).toBe(1);
  });

  it('повторное закрытие одной обёртки не роняет счётчик держателей', async () => {
    let mod!: typeof import('../dbLease');
    jest.isolateModules(() => {
      mod = require('../dbLease') as typeof import('../dbLease');
    });
    const a = (await mod.openLeasedDatabase('kv.db', open as never)) as unknown as {
      closeAsync: () => Promise<void>;
    };
    const b = (await mod.openLeasedDatabase('kv.db', open as never)) as unknown as Opened['db'];
    await a.closeAsync();
    await a.closeAsync();
    await tick(6);
    await b.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['жив', '1']);
    expect(await b.getAllAsync('SELECT * FROM kv')).toHaveLength(1);
  });

  it('закрытая база отдаётся соседней вкладке, а следующее открытие начинается заново', async () => {
    let mod!: typeof import('../dbLease');
    jest.isolateModules(() => {
      mod = require('../dbLease') as typeof import('../dbLease');
    });
    const owner = (await mod.openLeasedDatabase('kv.db', open as never)) as unknown as {
      closeAsync: () => Promise<void>;
    };
    const neighbour = await loadTab(open);
    expect(state.opens).toBe(1);

    // Выход из профиля закрывает базу — блокировка должна уйти, а не остаться
    // висеть на закрытом соединении.
    await owner.closeAsync();
    await tick(10);
    expect(state.opens).toBe(2);
    await neighbour.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['сосед', '1']);
    expect(await neighbour.db.getAllAsync('SELECT * FROM kv')).toHaveLength(1);

    // Тот же модуль открывает базу заново — уже как проситель у соседа.
    const again = await Promise.race([
      mod.openLeasedDatabase('kv.db', open as never),
      new Promise((_, rej) => setTimeout(() => rej(new Error('зависло')), 300)),
    ]);
    expect(again).not.toBe(owner);
    expect(state.opens).toBe(2);
  });

  it('транзакция одной вкладки не подхватывает запись другой', async () => {
    const one = await loadTab(open);
    const two = await loadTab(open);

    let outsiderDone = false;
    const outsider = two.db
      .runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['чужая', 'x'])
      .then(() => {
        outsiderDone = true;
      });

    await expect(
      one.db.withTransactionAsync(async () => {
        await one.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?)', ['своя', 'y']);
        await tick();
        // Пока транзакция открыта, чужая запись ждёт снаружи.
        expect(outsiderDone).toBe(false);
        throw new Error('передумали');
      })
    ).rejects.toThrow('передумали');

    await outsider;
    // Откат унёс только свою запись. Чужая — на месте.
    expect((await one.db.getAllAsync('SELECT * FROM kv')).map((r) => r.k)).toEqual(['чужая']);
  });
});
