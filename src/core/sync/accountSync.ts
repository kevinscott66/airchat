import { NO_SYNC_STUCK } from './syncStuckReport';
import { recordSyncStuck } from './syncStuckState';
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
  /** Reserved compatibility counter. Failed projections are retained for retry. */
  poisoned: number;
  /** Pull recovered a rejected push; remaining mutations still need another pass. */
  pushConflict?: boolean;
};

const locks = new Map<number, Promise<AccountSyncResult>>();

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
  /** Строки, которые этот заход выбросил как неисправимые. */
  const poisoned = 0;
  if (options.shouldContinue && !options.shouldContinue()) {
    return { status: 'offline', pushed: null, pulled: null, poisoned };
  }
  const online = await checkOnlineWrite();
  if (!online.ok) return { status: 'offline', pushed: null, pulled: null, poisoned };

  const state = await getSyncState(options.ownerProfileId);
  let pushed: SyncPushResponse | null = null;
  let pushConflict = false;
  if (options.pendingMutations && options.pendingMutations.length > 0) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'offline', pushed: null, pulled: null, poisoned };
    }
    try {
      pushed = await pushSyncMutations(options.mnemonic, options.pair, options.pendingMutations);
    } catch (error) {
      const failure = error as { status?: unknown; code?: unknown } | null;
      if (failure?.status !== 409 || failure.code !== 'sync_mutation_conflict') throw error;
      // An accepted push whose response was lost is re-encrypted with a new
      // nonce on retry. Do not acknowledge those different bytes; recover the
      // server's authenticated snapshot via the normal pull/projection path.
      pushConflict = true;
      log.info('sync_push_conflict_recover_pull', { ownerProfileId: options.ownerProfileId });
    }
    if (pushed) {
      // v4.32.624: форма ответа на отправку проверяется ДО того, как по нему
      // что-то решают. Ниже оба списка перебирают и меряют без оглядки на то,
      // списки ли это: сервер, приславший вместо массива null, ронял проход
      // английским TypeError из середины saveSyncEntityHeads — то есть уже
      // после saveSyncState, с наполовину применённым ответом. Тем же правилом
      // и по той же причине отвергается непонятный курсор в ветке приёма ниже.
      if (!Array.isArray(pushed.acceptedMutationIds) || !Array.isArray(pushed.rejectedMutationIds)) {
        log.warn('sync_push_shape_invalid', {
          accepted: typeof pushed.acceptedMutationIds,
          rejected: typeof pushed.rejectedMutationIds,
        });
        throw new Error('Сервер вернул некорректный ответ синхронизации.');
      }
      if (options.shouldContinue && !options.shouldContinue()) {
        return { status: 'offline', pushed, pulled: null, poisoned };
      }
      if (await detectServerReset(options, state.serverEpoch, pushed.serverEpoch)) {
        return { status: 'reset', pushed, pulled: null, poisoned };
      }
      await saveSyncState(options.ownerProfileId, {
        serverEpoch: pushed.serverEpoch,
        lastPushAt: Date.now(),
      });
      if (options.onPushAccepted) {
        await options.onPushAccepted(pushed, options.pendingMutations);
      }
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
  // v4.32.624: курсор проверялся, а сам пакет — нет. Каждую строку в нём
  // разбирает isDeliverable, но до неё дело не доходило: не-массив ронял
  // перебор ниже английским TypeError, и человек вместо честного «сервер
  // ответил не по протоколу» видел общий запасной текст.
  if (!Array.isArray(pulled.mutations)) {
    log.warn('sync_pull_shape_invalid', { got: typeof pulled.mutations });
    throw new Error('Сервер вернул некорректный ответ синхронизации.');
  }

  // Cursor advances only after every row has been projected locally. A crash
  // or decryption error therefore causes a safe replay instead of data loss.
  for (const mutation of pulled.mutations) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'offline', pushed, pulled: null, poisoned };
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
    // A successful probe of local.db cannot prove that the feed database,
    // media store or encryption key is available. Never acknowledge failed
    // projections: retaining the cursor makes every failure retryable.
    try {
      await options.applyMutation(mutation);
    } catch (error) {
      if (!options.shouldContinue || options.shouldContinue()) {
        recordSyncStuck({ ...NO_SYNC_STUCK, poisoned: 1 });
      }
      throw error;
    }
  }
  if (options.shouldContinue && !options.shouldContinue()) {
    return { status: 'offline', pushed, pulled: null, poisoned };
  }
  if (options.afterProjection) await options.afterProjection();
  if (await detectServerReset(options, state.serverEpoch, pulled.serverEpoch)) {
    return { status: 'reset', pushed, pulled, poisoned };
  }
  await saveSyncState(options.ownerProfileId, {
    cursor: pulled.nextCursor,
    serverEpoch: pulled.serverEpoch,
    lastPullAt: Date.now(),
  });
  return { status: 'synced', pushed, pulled, poisoned, ...(pushConflict ? { pushConflict: true } : {}) };
}

/** Serialize sync per profile so two reconnect events cannot race the cursor. */
export function syncAccountOnce(options: AccountSyncOptions): Promise<AccountSyncResult> {
  const previous = locks.get(options.ownerProfileId) ?? Promise.resolve({
    status: 'synced' as const,
    pushed: null,
    pulled: null,
    poisoned: 0,
  });
  const current = previous.catch(() => ({
    status: 'synced' as const,
    pushed: null,
    pulled: null,
    poisoned: 0,
  })).then(() => runSync(options));
  locks.set(options.ownerProfileId, current);
  return current.finally(() => {
    if (locks.get(options.ownerProfileId) === current) locks.delete(options.ownerProfileId);
  });
}
