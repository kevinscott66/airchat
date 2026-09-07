import { checkOnlineWrite } from './cachePolicy';
import { pullSyncMutations, pushSyncMutations } from './syncApi';
import type { KeyPairBytes } from '../crypto/keyManager';
import { log } from '../logger';
import { getSyncState, saveSyncState, validSyncCursor } from '../storage/local';
import type { SyncMutation, SyncPullResponse, SyncPushResponse } from './syncProtocol';

export type SyncProjection = (mutation: SyncMutation) => Promise<void>;

export type AccountSyncOptions = {
  mnemonic: string;
  pair: KeyPairBytes;
  ownerProfileId: number;
  pendingMutations?: SyncMutation[];
  applyMutation: SyncProjection;
  afterProjection?: () => Promise<void>;
  onPushAccepted?: (response: SyncPushResponse, mutations: readonly SyncMutation[]) => Promise<void>;
  /** Called when the server's copy of this account was created anew. */
  onServerReset?: () => Promise<void>;
  limit?: number;
  /** Becomes false when the active profile is wiped or switched. */
  shouldContinue?: () => boolean;
};

export type AccountSyncResult = {
  status: 'synced' | 'offline' | 'reset';
  pushed: SyncPushResponse | null;
  pulled: SyncPullResponse | null;
};

const locks = new Map<number, Promise<AccountSyncResult>>();

/**
 * Сколько раз одна строка может уронить проход, прежде чем её пропустят
 * (v4.32.617).
 *
 * Курсор двигается только после того, как ВСЯ пачка спроецирована, — и это
 * правильно: иначе сбой посреди пачки терял бы данные. Но у правила была
 * обратная сторона. Проекция бросает исключение не только на временной беде
 * (база занята, места нет): она бросает и на неисправимом — конверт,
 * зашифрованный другим ключом, строка сообщения, которая не проходит
 * проверку, tombstone комментария без разделителя. Такую строку сервер отдаёт
 * снова и снова, проход падает на ней снова и снова, курсор не двигается
 * НИКОГДА — и вместе с ней встаёт весь аккаунт: ни сообщений, ни групп, ни
 * ленты. Наружу при этом уходит одна строка `live_sync_failed` в журнал,
 * пользователю не видно ничего.
 *
 * Поэтому: первые попытки ведут себя как раньше (курсор стоит, строка будет
 * повторена), а после третьей строка пропускается, курсор идёт дальше, и в
 * журнал уходит отдельное событие. Сущность при этом остаётся неприменённой,
 * но её «голова» не обновляется — следующая ревизия той же сущности приедет
 * и встанет на место как обычно.
 */
const POISON_MAX_ATTEMPTS = 3;

/** Потолок на счётчики: карта живёт в памяти и растёт от чужих данных. */
const POISON_MAX_TRACKED = 256;

/** Сколько раз подряд конкретная строка роняла проекцию. Живёт до перезапуска. */
const poisonAttempts = new Map<string, number>();

function poisonKey(ownerProfileId: number, mutationId: string): string {
  return `${ownerProfileId}\u0000${mutationId}`;
}

/**
 * Годится ли пришедшая строка к проекции (v4.32.523).
 *
 * Запрашивали мы один профиль, но что вернёт сервер — его дело, и до этой
 * проверки не спрашивал никто. Строка с чужим `ownerProfileId` проецировалась
 * как есть: удаление уходило в `deleteSyncEntity` с этим самым чужим номером,
 * то есть сервер мог стереть данные СОСЕДНЕГО аккаунта на телефоне — того,
 * который сейчас даже не открыт. Номер ревизии проверяем здесь же: на нём
 * держится защита от отката, а дробное или отрицательное значение ломает
 * сравнение «новее ли пришедшее».
 *
 * Негодная строка пропускается, а не роняет разбор: иначе сервер одной такой
 * записью останавливал бы курсор навсегда.
 */
function isDeliverable(mutation: SyncMutation, ownerProfileId: number): boolean {
  return mutation.ownerProfileId === ownerProfileId
    && Number.isSafeInteger(mutation.revision) && mutation.revision >= 1
    && Number.isSafeInteger(mutation.updatedAt) && mutation.updatedAt >= 0;
}

/**
 * Сервер завёл копию этого аккаунта заново (v4.32.595).
 *
 * `serverEpoch` сохраняли с первого дня, но ни разу не сравнивали, и потеря
 * серверной копии проходила молча: локальные «головы» уверены, что всё уже
 * отправлено, сервер про эти записи не знает — и не узнает никогда, потому
 * что собирать их заново некому. Теперь метка меняется и при пересоздании
 * строки аккаунта (см. accountEpoch на сервере), а расхождение здесь
 * означает ровно одно: выгружать надо всё заново. Головы сбрасывает
 * вызывающий, курсор обнуляется тут же, а проход возвращает `reset`, чтобы
 * следующий собрал отправку с чистого листа.
 */
async function detectServerReset(
  options: AccountSyncOptions,
  known: string | null,
  reported: string,
): Promise<boolean> {
  if (!known || known === reported) return false;
  log.warn('sync_server_reset', { ownerProfileId: options.ownerProfileId });
  if (options.onServerReset) await options.onServerReset();
  await saveSyncState(options.ownerProfileId, { cursor: null, serverEpoch: reported });
  return true;
}

async function runSync(options: AccountSyncOptions): Promise<AccountSyncResult> {
  if (options.shouldContinue && !options.shouldContinue()) {
    return { status: 'offline', pushed: null, pulled: null };
  }
  const online = await checkOnlineWrite();
  if (!online.ok) return { status: 'offline', pushed: null, pulled: null };

  const state = await getSyncState(options.ownerProfileId);
  let pushed: SyncPushResponse | null = null;
  if (options.pendingMutations && options.pendingMutations.length > 0) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'offline', pushed: null, pulled: null };
    }
    pushed = await pushSyncMutations(options.mnemonic, options.pair, options.pendingMutations);
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'offline', pushed, pulled: null };
    }
    if (await detectServerReset(options, state.serverEpoch, pushed.serverEpoch)) {
      return { status: 'reset', pushed, pulled: null };
    }
    await saveSyncState(options.ownerProfileId, {
      serverEpoch: pushed.serverEpoch,
      lastPushAt: Date.now(),
    });
    if (options.onPushAccepted) {
      await options.onPushAccepted(pushed, options.pendingMutations);
    }
  }

  const pulled = await pullSyncMutations(
    options.mnemonic,
    options.pair,
    state.cursor,
    options.ownerProfileId,
    Math.min(Math.max(options.limit ?? 100, 1), 100),
  );

  // v4.32.619: форма курсора проверяется ДО проекции. Тем же правилом его
  // отвергает saveSyncState — но уже после того, как весь пакет применён:
  // курсор не двигался, следующая синхронизация приносила тот же пакет, и так
  // без конца. Честный сервер шлёт десятичное число всегда; сломанный или
  // враждебный — единственный, кто сюда попадёт, и ему отказывают до того, как
  // хоть одна строка легла в базу.
  if (!validSyncCursor(pulled.nextCursor)) {
    log.warn('sync_pull_cursor_invalid', { cursor: String(pulled.nextCursor).slice(0, 64) });
    throw new Error('Сервер вернул некорректный курсор синхронизации.');
  }

  // Cursor advances only after every row has been projected locally. A crash
  // or decryption error therefore causes a safe replay instead of data loss.
  for (const mutation of pulled.mutations) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'offline', pushed, pulled: null };
    }
    if (!isDeliverable(mutation, options.ownerProfileId)) {
      log.warn('sync_pull_row_rejected', {
        entityKind: mutation.entityKind,
        expected: options.ownerProfileId,
        got: mutation.ownerProfileId,
        revision: mutation.revision,
      });
      continue;
    }
    const attemptKey = poisonKey(options.ownerProfileId, mutation.mutationId);
    try {
      await options.applyMutation(mutation);
      poisonAttempts.delete(attemptKey);
    } catch (e) {
      const attempts = (poisonAttempts.get(attemptKey) ?? 0) + 1;
      if (attempts < POISON_MAX_ATTEMPTS) {
        // Счётчики — эвристика, а не состояние: при переполнении сбрасываем
        // всю карту, и худшее следствие — несколько лишних попыток.
        if (poisonAttempts.size >= POISON_MAX_TRACKED) poisonAttempts.clear();
        poisonAttempts.set(attemptKey, attempts);
        throw e;
      }
      poisonAttempts.delete(attemptKey);
      log.warn('sync_pull_row_poisoned', {
        entityKind: mutation.entityKind,
        ownerProfileId: mutation.ownerProfileId,
        revision: mutation.revision,
        attempts,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (options.shouldContinue && !options.shouldContinue()) {
    return { status: 'offline', pushed, pulled: null };
  }
  if (options.afterProjection) await options.afterProjection();
  if (await detectServerReset(options, state.serverEpoch, pulled.serverEpoch)) {
    return { status: 'reset', pushed, pulled };
  }
  await saveSyncState(options.ownerProfileId, {
    cursor: pulled.nextCursor,
    serverEpoch: pulled.serverEpoch,
    lastPullAt: Date.now(),
  });
  return { status: 'synced', pushed, pulled };
}

/** Serialize sync per profile so two reconnect events cannot race the cursor. */
export function syncAccountOnce(options: AccountSyncOptions): Promise<AccountSyncResult> {
  const previous = locks.get(options.ownerProfileId) ?? Promise.resolve({
    status: 'synced' as const,
    pushed: null,
    pulled: null,
  });
  const current = previous.catch(() => ({
    status: 'synced' as const,
    pushed: null,
    pulled: null,
  })).then(() => runSync(options));
  locks.set(options.ownerProfileId, current);
  return current.finally(() => {
    if (locks.get(options.ownerProfileId) === current) locks.delete(options.ownerProfileId);
  });
}
