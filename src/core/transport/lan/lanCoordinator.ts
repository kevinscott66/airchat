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
 * Разбор кадра из локальной сети под ловушкой (v4.32.780).
 *
 * Исход разбора (`EnvelopeIntake`) здесь намеренно выброшен — см. комментарий у
 * `onFrame`, — но брошенное выбрасывать нельзя. До ловушки отказ разбора уходил
 * в необработанное отклонение обещания: в журнале самого приложения такой
 * записи нет вовсе, только в системной консоли сборки, которой у человека на
 * руках не бывает. Кадр по локальной сети и правда теряется — перезапросить его
 * неоткуда, — но потеря обязана быть названа: иначе разбор жалобы «сообщение из
 * соседней комнаты не дошло» упирается в пустоту.
 *
 * Работа берётся замыканием, а не готовым обещанием: тогда одна и та же ловушка
 * ловит и брошенное синхронно — до первого `await` внутри разбора.
 */
function intakeLanFrame(kind: string, senderDid: string, run: () => Promise<unknown> | undefined): void {
  const failed = (e: unknown): void => {
    log.warn('lan_frame_handle_failed', {
      kind,
      from: senderDid.slice(0, 24),
      err: e instanceof Error ? e.message : String(e),
    });
  };
  try {
    void run()?.catch(failed);
  } catch (e) {
    failed(e);
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
      //
      // v4.32.730: `EnvelopeIntake` здесь намеренно выброшен. По локальной сети
      // кадр приходит живьём, отправитель рядом и повторит сам; перезапросить
      // его неоткуда — накопленного у LAN нет, отметки «докуда прочитано» тоже.
      // Отвечает исход ради интернет-координатора, где он и читается.
      //
      // v4.32.780: выброшен исход — но не отказ. Каждый разбор идёт через
      // `intakeLanFrame`, и брошенное из него попадает в журнал, а не в
      // необработанное отклонение обещания.
      if (isLanBlobFrame(payload)) {
        intakeLanFrame('blob', senderDid, () => receiveLanBlobFrame(payload));
      } else if (isFeedFrame(payload)) {
        intakeLanFrame('feed', senderDid, () => receiveFeedEnvelope(payload, senderDid));
      } else if (isGroupEnvelope(payload)) {
        intakeLanFrame('group', senderDid, () =>
          getGroupMessagingService()?.receiveGroupEnvelope(payload, senderDid)
        );
      } else {
        intakeLanFrame('direct', senderDid, () =>
          getMessagingService()?.receiveDirectLanEnvelope(payload, senderDid)
        );
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
