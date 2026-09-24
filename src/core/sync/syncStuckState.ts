/**
 * Сколько записей не доехало — то, что знает проход, и то, что нужно экрану.
 *
 * Счёт живёт в памяти и обновляется каждым проходом целиком: он не копится, а
 * заменяется. Записать его на диск было бы хуже — предел на сущность мог
 * измениться, испорченная строка могла приехать заново в исправленном виде, и
 * вчерашнее число тогда пугало бы человека беспричинно. Ср.
 * `net/connectionStatus.ts`: там же и по той же причине живёт состояние связи.
 */

import { NO_SYNC_STUCK, syncStuckCount, type SyncStuck } from './syncStuckReport';

let current: SyncStuck = NO_SYNC_STUCK;
const listeners = new Set<() => void>();

export function readSyncStuck(): SyncStuck {
  return current;
}

/**
 * Записать итог прохода.
 *
 * Проход, который не дошёл до сбора (нет сети, отмена), сюда не приходит
 * вовсе: заменить настоящее число нулём значило бы объявить, что всё уехало,
 * — а он даже не смотрел.
 */
export function recordSyncStuck(next: SyncStuck): void {
  const same =
    current.oversize === next.oversize &&
    current.held === next.held &&
    current.rejected === next.rejected &&
    current.poisoned === next.poisoned;
  current = next;
  if (!same) for (const listener of [...listeners]) listener();
}

export function subscribeSyncStuck(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isSyncStuck(): boolean {
  return syncStuckCount(current) > 0;
}

/** Только для тестов: вернуть счёт в исходное состояние. */
export function resetSyncStuckForTests(): void {
  current = NO_SYNC_STUCK;
  listeners.clear();
}
