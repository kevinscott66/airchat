/**
 * v4.32.67: flush-on-reconnect watcher.
 *
 * Слушает `Network.addNetworkStateListener` — при любом переходе «offline → online»
 * (включение Wi-Fi, возврат в зону сотовой связи) прогоняет очереди доставки:
 *   - feed publish queue (все неотправленные посты по всем контактам);
 *   - DM outbox (через runSyncIfOnline).
 *
 * Это парный к lanCoordinator.onPeerDiscovered механизм, но для случаев когда
 * оффлайн был НА НАШЕЙ стороне (свой Wi-Fi упал → вернулся), а не на стороне
 * контакта. Например: юзер опубликовал пост в метро без интернета → вышел на
 * улицу → Wi-Fi/4G поднялся → post летит всем онлайн-контактам через multiTransport.
 *
 * Debounce 2с против всплесков connectivity-events (iOS иногда шлёт 3-4 события
 * подряд при переключении сетей).
 */
import * as Network from 'expo-network';
import type { KeyPairBytes } from '../crypto/keyManager';
import { log } from '../logger';
import { flushFeedPublishQueue, resumeCommentOutbox } from '../social/feedService';
import { runSyncIfOnline } from '../storage/sync';

const FLUSH_DEBOUNCE_MS = 2_000;

let subscription: { remove: () => void } | null = null;
let lastConnected: boolean | null = null;
let pairRef: KeyPairBytes | null = null;
let onReconnectRef: ((pair: KeyPairBytes) => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const pair = pairRef;
    if (!pair) return;
    log.info('net_reconnect_flush_start');
    void flushFeedPublishQueue(pair).catch((e) => {
      log.warn('net_reconnect_feed_flush_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    });
    // v4.32.164 P1#2: дренируем outbox comment/delete envelopes при появлении сети.
    try { resumeCommentOutbox(pair); } catch (e) {
      log.warn('net_reconnect_comment_outbox_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
    void runSyncIfOnline().catch((e) => {
      log.warn('net_reconnect_outbox_flush_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    });
    try {
      onReconnectRef?.(pair);
    } catch (e) {
      log.warn('net_reconnect_sync_callback_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }, FLUSH_DEBOUNCE_MS);
}

export function startNetworkReconnectWatcher(
  pair: KeyPairBytes,
  onReconnect?: (pair: KeyPairBytes) => void,
): void {
  pairRef = pair;
  onReconnectRef = onReconnect ?? null;
  if (subscription) return; // уже запущен

  // Seed текущего состояния, чтобы первый event сравнивался корректно.
  void Network.getNetworkStateAsync()
    .then((st) => {
      lastConnected = !!st.isConnected;
    })
    .catch(() => {
      lastConnected = null;
    });

  try {
    subscription = Network.addNetworkStateListener((ev) => {
      const now = !!ev.isConnected;
      const prev = lastConnected;
      lastConnected = now;
      // Только переход false/null → true считаем «reconnect».
      if (now && prev !== true) {
        log.info('net_reconnect_detected', { prev, now });
        scheduleFlush();
      }
    });
    log.info('net_reconnect_watcher_started');
  } catch (e) {
    log.warn('net_reconnect_watcher_start_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    subscription = null;
  }
}

export function stopNetworkReconnectWatcher(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    subscription?.remove();
  } catch {
    /* ignore */
  }
  subscription = null;
  pairRef = null;
  onReconnectRef = null;
  lastConnected = null;
  log.info('net_reconnect_watcher_stopped');
}
