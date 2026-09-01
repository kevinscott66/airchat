import { checkOnlineWrite } from './cachePolicy';
import { pullSyncMutations, pushSyncMutations } from './syncApi';
import type { KeyPairBytes } from '../crypto/keyManager';
import { log } from '../logger';
import { getSyncState, saveSyncState } from '../storage/local';
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
  limit?: number;
  /** Becomes false when the active profile is wiped or switched. */
  shouldContinue?: () => boolean;
};

export type AccountSyncResult = {
  status: 'synced' | 'offline';
  pushed: SyncPushResponse | null;
  pulled: SyncPullResponse | null;
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
    await options.applyMutation(mutation);
  }
  if (options.shouldContinue && !options.shouldContinue()) {
    return { status: 'offline', pushed, pulled: null };
  }
  if (options.afterProjection) await options.afterProjection();
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
