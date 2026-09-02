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
import {
  WATERMARK_FLUSH_MS,
  loadBacklogWatermark,
  saveBacklogWatermark,
  sinceParam,
} from './relayBacklog';

let started = false;

/**
 * Последняя отметка, ещё не записанная в базу.
 *
 * Живёт на уровне модуля, а не в замыкании старта, чтобы `stop` мог дописать
 * её: приложение уходит в фон вместе с транспортом, и без этого последние до
 * десяти секунд принятого пришлось бы разбирать заново при следующем запуске.
 */
let pendingWatermark: { myDid: string; atMs: number } | null = null;

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
  // v4.32.545: отметка «докуда мы уже прочитали relay». Читается один раз при
  // старте, дальше живёт в памяти и изредка уходит в базу — см. relayBacklog.
  // Именно она превращает переподключение в «догрузить всё пропущенное»:
  // раньше подписка всегда просила последние десять минут и накопленное за
  // ночь оставалось лежать на relay до истечения срока хранения.
  let watermark = await loadBacklogWatermark(myDid);
  let flushedAt = 0;
  transport.start({
    myDid,
    relayBase: c.internet?.relayBase,
    wsBase: c.internet?.wsBase,
    since: () => sinceParam(watermark, Date.now()),
    onFrameSeen: (atMs) => {
      // Только вперёд: кадры внутри пачки приходят не строго по возрастанию
      // времени, и откат отметки назад означал бы повторный разбор уже
      // разобранного при следующем подключении.
      if (atMs <= (watermark ?? 0)) return;
      watermark = atMs;
      pendingWatermark = { myDid, atMs };
      const now = Date.now();
      if (now - flushedAt < WATERMARK_FLUSH_MS) return;
      flushedAt = now;
      pendingWatermark = null;
      void saveBacklogWatermark(myDid, atMs);
    },
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
  if (pendingWatermark) {
    void saveBacklogWatermark(pendingWatermark.myDid, pendingWatermark.atMs);
    pendingWatermark = null;
  }
  try {
    getInternetTransportSingleton().stop();
  } catch {
    /* ignore */
  }
  started = false;
}
