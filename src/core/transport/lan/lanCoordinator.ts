import type { KeyPairBytes } from '../../crypto/keyManager';
import type { AppConfig } from '../../config';
import { loadConfig } from '../../config';
import { publicKeyToDidKey } from '../../identity/did';
import { log } from '../../logger';
import { getMessagingService } from '../../social/messaging';
import { getGroupMessagingService } from '../../social/groupMessaging';
import { isFeedFrame } from '../../social/feedTransport';
import { receiveFeedEnvelope, flushFeedQueueForPeer } from '../../social/feedService';
import { runSyncIfOnline } from '../../storage/sync';
import { getLanTransportSingleton } from './lanTransport';
import { isLanBlobFrame, receiveLanBlobFrame } from './lanBlob';

let started = false;

/**
 * Определяет тип envelope по первым байтам JSON (без полного парсинга).
 * Групповые envelope имеют поле "type" со значением "group*".
 */
function isGroupEnvelope(payload: Uint8Array): boolean {
  try {
    // Быстрая проверка: ищем "type":"group в первых 200 байт
    const preview = new TextDecoder().decode(payload.slice(0, 200));
    return /"type"\s*:\s*"group/.test(preview);
  } catch {
    return false;
  }
}

/**
 * Запуск mDNS + TCP-сервера для доставки DM и групповых сообщений в одной Wi‑Fi сети (без интернета).
 * Требует `lan.enabled` в конфиге и development build с нативными модулями.
 */
export async function startLanTransportIfEnabled(pair: KeyPairBytes, cfg?: AppConfig): Promise<void> {
  const c = cfg ?? (await loadConfig());
  if (!c.lan?.enabled) return;
  if (started) return;
  const myDid = publicKeyToDidKey(pair.publicKey);
  const port = c.lan.port ?? 9000;
  const transport = getLanTransportSingleton();
  transport.start({
    myDid,
    port,
    onFrame: (senderDid, payload) => {
      // v4.32.24: feed envelope имеет MAGIC-байт 0xF0 в первом байте — отсекается
      // до regex-проверки на "type":"group и до JSON-парсинга direct-envelope.
      // v4.32.208: isFeedFrame accepts both 0xF0 (direct signed) and 0xF1
      // (relay wrapper); receiveFeedEnvelope unwraps 0xF1 internally.
      // v4.32.226: 0xB1 — chunk зашифрованного media-blob'а (LAN-доставка
      // фото/голосовых/файлов без relay). Бинарный, проверяется до feed/JSON.
      if (isLanBlobFrame(payload)) {
        void receiveLanBlobFrame(payload);
      } else if (isFeedFrame(payload)) {
        void receiveFeedEnvelope(payload, senderDid);
      } else if (isGroupEnvelope(payload)) {
        void getGroupMessagingService()?.receiveGroupEnvelope(payload, senderDid);
      } else {
        void getMessagingService()?.receiveDirectLanEnvelope(payload, senderDid);
      }
    },
    // v4.32.67: flush-on-reconnect. Когда mDNS зарезолвил пира (новый в сети ИЛИ старый
    // после длинной паузы — debounce 30с внутри lanTransport), прогоняем feed-очередь
    // нацеленно на этот DID и DM-outbox на все транспорты. Это закрывает сценарий
    // «контакт был оффлайн, отправил пост — контакт подключился к Wi-Fi — пост дошёл».
    onPeerDiscovered: (peerDid) => {
      log.info('lan_peer_triggered_flush', { peerDid: peerDid.slice(0, 24) });
      // Feed queue — целенаправленно на peerDid (избегаем рассылки уже-доставленным).
      void flushFeedQueueForPeer(pair, peerDid).catch((e) => {
        log.warn('lan_peer_feed_flush_failed', {
          peerDid: peerDid.slice(0, 24),
          err: e instanceof Error ? e.message : String(e),
        });
      });
      // DM outbox — общий drain (оutbox items не таргетированы per-peer). Если в очереди
      // лежит DM для этого peer'а, retrySendDm выберет актуальный транспорт (LAN теперь
      // доступен — только что появился).
      void runSyncIfOnline().catch((e) => {
        log.warn('lan_peer_outbox_flush_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      });
    },
  });
  started = true;
  log.info('lan_coordinator_started', { port });
}

export function stopLanTransportStack(): void {
  if (!started) return;
  try {
    getLanTransportSingleton().stop();
  } catch {
    /* ignore */
  }
  started = false;
}
