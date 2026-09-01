import * as Network from 'expo-network';

import { log } from '../logger';
import {
  NO_WRITE_PATH_TEXT,
  classifyReachability,
  decideWritePath,
  isWriteBlocked,
  type WritePath,
  type WriteReachability,
} from './writePathDecision';

/**
 * Telegram-style storage policy: SQLite/files are a read cache only. A write
 * must have a live network path; it is never stored for later delivery.
 */
export const CACHE_ONLY_MODE = true;

export type OnlineWriteResult =
  | { ok: true; path: WritePath; reachability: WriteReachability }
  | { ok: false; reason: 'offline'; reachability: WriteReachability };

/**
 * Опросить сеть и решить, есть ли куда отправлять.
 *
 * v4.32.550: `localPathAvailable` — виден ли получатель по локальному
 * транспорту (LAN / Wi‑Fi Direct). Прежде этот вопрос не задавался вовсе, и
 * Wi‑Fi без выхода наружу выглядел как полное отсутствие связи, хотя LAN —
 * транспорт первого приоритета и доставил бы сообщение напрямую. См.
 * `writePathDecision.ts`.
 */
export async function checkOnlineWrite(localPathAvailable = false): Promise<OnlineWriteResult> {
  if (!CACHE_ONLY_MODE) return { ok: true, path: 'allow', reachability: 'online' };
  let reachability: WriteReachability;
  try {
    const state = await Network.getNetworkStateAsync();
    reachability = classifyReachability({
      failed: false,
      connected: state.isConnected ?? null,
      internetReachable: state.isInternetReachable ?? null,
    });
  } catch (e) {
    // Провалившийся опрос — это незнание, а не «сети нет». Отправку он не
    // отменяет: пусть она попробует и провалится честно, если сети правда нет.
    log.warn('network_probe_failed', { err: e instanceof Error ? e.message : String(e) });
    reachability = classifyReachability({ failed: true, connected: null, internetReachable: null });
  }
  const path = decideWritePath(reachability, localPathAvailable);
  if (isWriteBlocked(path)) return { ok: false, reason: 'offline', reachability };
  return { ok: true, path, reachability };
}

export async function requireOnlineWrite(localPathAvailable = false): Promise<void> {
  const result = await checkOnlineWrite(localPathAvailable);
  if (!result.ok) {
    log.info('write_blocked_offline', { reachability: result.reachability });
    throw new Error(NO_WRITE_PATH_TEXT);
  }
}
