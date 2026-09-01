// @stable v4.32.70 — НЕ ИЗМЕНЯТЬ без явного запроса.
// Причина: старт/стоп интернет-транспорта в одной секции с LAN; при ошибке
// получателя на другом WiFi/мобильном интернете перестанут приходить frame'ы.

import type { KeyPairBytes } from '../../crypto/keyManager';
import type { AppConfig } from '../../config';
import { loadConfig } from '../../config';
import { publicKeyToDidKey } from '../../identity/did';
import { log } from '../../logger';
import { getMessagingService } from '../../social/messaging';
import { getGroupMessagingService } from '../../social/groupMessaging';
import { isFeedFrame } from '../../social/feedTransport';
import { receiveFeedEnvelope } from '../../social/feedService';
import { getInternetTransportSingleton } from './internetTransport';

let started = false;

/**
 * Определяет тип envelope по первым байтам JSON (копия из lanCoordinator; держим
 * локально, чтобы не создавать циклическую зависимость LAN ↔ internet).
 */
function isGroupEnvelope(payload: Uint8Array): boolean {
  try {
    const preview = new TextDecoder().decode(payload.slice(0, 200));
    return /"type"\s*:\s*"group/.test(preview);
  } catch {
    return false;
  }
}

/**
 * Запуск InternetTransport (WebSocket sub + HTTP pub через ntfy.sh или
 * сконфигурированный relay). Работает в любой сети с интернетом — WiFi или
 * мобильные данные. Parallel с LAN: на одной WiFi оба транспорта активны,
 * MultiTransportRouter сам выберет приоритетный по success-rate.
 */
export async function startInternetTransportIfEnabled(
  pair: KeyPairBytes,
  cfg?: AppConfig,
): Promise<void> {
  const c = cfg ?? (await loadConfig());
  if (c.internet?.enabled === false) {
    log.info('internet_coordinator_disabled_by_config');
    return;
  }
  if (started) return;
  const myDid = publicKeyToDidKey(pair.publicKey);
  const transport = getInternetTransportSingleton();
  transport.start({
    myDid,
    relayBase: c.internet?.relayBase,
    wsBase: c.internet?.wsBase,
    onFrame: (senderDid, payload) => {
      // Симметрично lanCoordinator.onFrame: feed → group → DM.
      // v4.32.208: accept 0xF0 + 0xF1 (relay wrapper) — unwrap inside receiveFeedEnvelope.
      if (isFeedFrame(payload)) {
        void receiveFeedEnvelope(payload, senderDid);
      } else if (isGroupEnvelope(payload)) {
        void getGroupMessagingService()?.receiveGroupEnvelope(payload, senderDid);
      } else {
        void getMessagingService()?.receiveDirectLanEnvelope(payload, senderDid);
      }
    },
  });
  started = true;
  log.info('internet_coordinator_started');
}

export function stopInternetTransportStack(): void {
  if (!started) return;
  try {
    getInternetTransportSingleton().stop();
  } catch {
    /* ignore */
  }
  started = false;
}
