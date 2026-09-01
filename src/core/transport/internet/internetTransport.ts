// @stable v4.32.70 — НЕ ИЗМЕНЯТЬ без явного запроса.
// Причина: единственный online-транспорт на Android после IPFS kill switch (v4.32.19).
// При поломке доставка сообщений между устройствами в разных WiFi/через мобильный интернет
// перестанет работать. Fallback'а больше нет (LAN работает только в одной подсети).

import { sha256 } from '@noble/hashes/sha2.js';
import { Platform } from 'react-native';
import * as Network from 'expo-network';

import { log } from '../../logger';

/**
 * InternetTransport — доставка AirChat-фреймов поверх публичного WebSocket/HTTP
 * pub-sub сервиса ntfy.sh. Работает через интернет (WiFi или мобильные данные),
 * не требует прямой P2P-связи между устройствами.
 *
 * Архитектура:
 *  - **Отправка**: HTTP POST `https://ntfy.sh/<topicForDid(targetDid)>` с base64
 *    полезной нагрузкой в теле + заголовок `X-Sender` = senderDid.
 *  - **Получение**: WebSocket `wss://ntfy.sh/<topicForDid(myDid)>/ws` — long-lived
 *    подписка с auto-reconnect (экспо backoff 2→30с).
 *  - **Topic**: `airchat1-<hex(sha256(did)).slice(0,24)>` — детерминированно,
 *    не раскрывает DID публично (нужно знать DID чтобы получить topic).
 *
 * Ограничения ntfy.sh free tier:
 *  - 60 сообщений/минуту per IP (для feed_view envelopes — с запасом).
 *  - ~4 KB на тело сообщения (для feed_view ~400 байт после base64, для feed_post
 *    с медиа — может не влезть; в этом случае отправка failed → roll-over на LAN).
 *  - 12 часов persistence: если получатель offline >12ч, сообщение теряется.
 *    Это нормально: feed-очередь на стороне отправителя сама делает retry при
 *    reconnect (v4.32.67 networkReconnectWatcher + lanCoordinator.onPeerDiscovered).
 *
 * Шифрование: envelope уже подписан (`feedTransport.signJson`) или зашифрован
 * (`messaging.ts:encryptSymmetric` — для DM), relay видит только ciphertext.
 */

type OnFrameCallback = (senderDid: string, payload: Uint8Array) => void;

const DEFAULT_RELAY_BASE = 'https://ntfy.sh';
const DEFAULT_WS_BASE = 'wss://ntfy.sh';
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** Максимум полезной нагрузки в bytes (до base64). ntfy.sh free ~4096 бит в теле;
 *  с base64-expansion 4/3 → 3 KB сырых байт безопасно. */
const MAX_PAYLOAD_BYTES = 3_072;
/** Срок, в течение которого считаем relay "достижимым" после успешной публикации
 *  (influence на canReach — экономим round-trip каждого send). */
const REACHABILITY_TTL_MS = 60_000;

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function toB64(bytes: Uint8Array): string {
  // В RN нет Buffer в UI-потоке, но global.Buffer полифиллится expo. Fallback на btoa.
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).btoa(binary);
}

function fromB64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (globalThis as any).atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/**
 * Детерминированный topic для DID. Topic публичен (на ntfy.sh видны все сообщения
 * по topic'у), но восстановить DID из topic'а требует брутфорса 128-битного хэша.
 */
export function topicForDid(did: string): string {
  const h = sha256(new TextEncoder().encode('airchat-relay-v1:' + did));
  return 'airchat1-' + toHex(h).slice(0, 24);
}

type RelayEventMessage = {
  id?: string;
  time?: number;
  event?: 'open' | 'keepalive' | 'message' | 'poll_request';
  topic?: string;
  message?: string;
  title?: string;
  // Headers come through X-* prefixed fields in JSON
  // ntfy преобразует X-Sender → sender, но с prefix'ами не всегда — смотрим оба.
  sender?: string;
  'x-sender'?: string;
};

export class InternetTransport {
  private myDid = '';
  private relayBase = DEFAULT_RELAY_BASE;
  private wsBase = DEFAULT_WS_BASE;
  private ws: WebSocket | null = null;
  private onFrame?: OnFrameCallback;
  private active = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastConnectedAt = 0;
  private lastSendOkAt = 0;
  private wsOpen = false;

  isActive(): boolean {
    return this.active;
  }

  /** Возвращает true, если WS-подписка соединена ИЛИ недавний POST прошёл успешно. */
  isReachable(): boolean {
    if (!this.active) return false;
    if (this.wsOpen) return true;
    return Date.now() - this.lastSendOkAt < REACHABILITY_TTL_MS;
  }

  getStatus(): { active: boolean; wsOpen: boolean; myTopic: string; relay: string; reconnectAttempt: number } {
    return {
      active: this.active,
      wsOpen: this.wsOpen,
      myTopic: this.myDid ? topicForDid(this.myDid) : '',
      relay: this.relayBase,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  async canReach(_targetDid: string): Promise<boolean> {
    if (!this.active) return false;
    // Любой контакт достижим, если у нас есть интернет. Relay сам хранит сообщение
    // 12 часов — получатель подхватит при следующем подключении к WS.
    try {
      const s = await Network.getNetworkStateAsync();
      return Boolean(s.isConnected);
    } catch {
      return false;
    }
  }

  /**
   * Публикуем envelope на topic получателя. Возвращает true, если HTTP 2xx
   * (relay принял сообщение). Это НЕ значит, что получатель его уже увидел —
   * но relay хранит до 12ч, так что fire-and-forget с гарантией persistence.
   */
  async send(data: Uint8Array, targetDid: string): Promise<boolean> {
    if (!this.active || !this.myDid) return false;
    if (data.length > MAX_PAYLOAD_BYTES) {
      log.warn('internet_send_too_large', { bytes: data.length, max: MAX_PAYLOAD_BYTES });
      return false;
    }
    const topic = topicForDid(targetDid);
    const url = `${this.relayBase}/${topic}`;
    const body = toB64(data);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          // v4.32.216 (Paranoid CRIT-2): do NOT send X-Sender. Sender identity
          // is authenticated inside AEAD plaintext via static ECDH; any outer
          // header is a metadata leak to the relay (ntfy.sh) and network path.
          // Receiver never consulted this header.
          'Content-Type': 'text/plain',
          'X-Airchat-V': '1',
          Priority: 'default',
          Cache: 'no',
          Tags: 'airchat',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        log.warn('internet_send_http_err', { status: res.status, topic: topic.slice(0, 18) });
        return false;
      }
      this.lastSendOkAt = Date.now();
      log.info('internet_send_ok', { bytes: data.length, topic: topic.slice(0, 18), targetDid: targetDid.slice(0, 24) });
      return true;
    } catch (e) {
      log.warn('internet_send_failed', {
        err: e instanceof Error ? e.message : String(e),
        topic: topic.slice(0, 18),
      });
      return false;
    }
  }

  start(opts: { myDid: string; onFrame: OnFrameCallback; relayBase?: string; wsBase?: string }): void {
    if (Platform.OS === 'web') {
      // На web fetch + WebSocket тоже работают, просто ничего не мешает. Разрешаем.
    }
    this.stop();
    this.myDid = opts.myDid;
    this.onFrame = opts.onFrame;
    this.relayBase = opts.relayBase ?? DEFAULT_RELAY_BASE;
    this.wsBase = opts.wsBase ?? DEFAULT_WS_BASE;
    this.active = true;
    this.reconnectAttempt = 0;
    this.openWs();
    log.info('internet_transport_started', {
      myDid: this.myDid.slice(0, 24),
      topic: topicForDid(this.myDid).slice(0, 18),
      relay: this.relayBase,
    });
  }

  stop(): void {
    this.active = false;
    this.wsOpen = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private openWs(): void {
    if (!this.active || !this.myDid) return;
    const topic = topicForDid(this.myDid);
    // `?since=10m` — забираем сообщения за последние 10 минут при переподключении
    // (на случай если были оффлайн). Дубликаты отсекаются на receiver-side через
    // INSERT OR IGNORE / idempotency guards.
    const url = `${this.wsBase}/${topic}/ws?since=10m`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log.warn('internet_ws_ctor_failed', { err: e instanceof Error ? e.message : String(e) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wsOpen = true;
      this.lastConnectedAt = Date.now();
      this.reconnectAttempt = 0;
      log.info('internet_ws_open', { topic: topic.slice(0, 18) });
    };
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw) return;
        // v4.32.199 (Round-29 #1): byte-cap before JSON.parse. A rogue/MITM
        // relay can send a multi-MB frame and stall the JS thread. Legit
        // envelopes are base64-encoded bytes ≤ ~90KB.
        if (raw.length > 256 * 1024) {
          log.warn('internet_ws_msg_oversize', { len: raw.length });
          return;
        }
        const msg = JSON.parse(raw) as RelayEventMessage;
        if (msg.event !== 'message') return; // skip open/keepalive
        const rawSender = msg['x-sender'] ?? msg.sender ?? '';
        if (typeof rawSender !== 'string' || rawSender.length > 512) {
          log.warn('internet_ws_bad_sender_shape');
          return;
        }
        const senderDid = rawSender.trim();
        // v4.32.226 (IB-01 fix): a MISSING/blank sender is the NORMAL case, not a
        // drop condition. send() intentionally omits X-Sender (CRIT-2 privacy: the
        // authenticated sender lives inside the AEAD plaintext, never in an outer
        // header the relay can read), so legitimate frames arrive with no sender.
        // Dropping them here silently broke ALL DM/feed/group delivery
        // (internet_ws_msg_no_sender on every inbound frame). The real, forge-proof
        // sender is parsed and authenticated downstream by receive*Envelope (via
        // ECDH decrypt; self-echo is guarded there by em.senderDid === myDid). We
        // therefore pass the frame through with an empty senderDid hint. The DID
        // regex + echo checks only apply when a sender hint IS present (legacy
        // peers / relay hops), where a rogue relay could inject a victim DID.
        if (senderDid) {
          // v4.32.201 (Round-31 #5): strict DID regex on peer-originated sender.
          // A rogue ntfy.sh relay can inject arbitrary X-Sender headers
          // (including victim DIDs); reject anything that doesn't match DID shape.
          if (!/^did:[a-z0-9]+:[A-Za-z0-9._-]{1,128}$/.test(senderDid)) {
            log.warn('internet_ws_bad_sender_did');
            return;
          }
          if (senderDid === this.myDid) {
            // Эхо: наш же собственный POST вернулся через WS. Игнорируем.
            return;
          }
        }
        const body = msg.message ?? '';
        if (!body) return;
        let payload: Uint8Array;
        try {
          payload = fromB64(body);
        } catch (e) {
          log.warn('internet_ws_bad_b64', { err: e instanceof Error ? e.message : String(e) });
          return;
        }
        log.info('internet_ws_frame', {
          bytes: payload.length,
          senderDid: senderDid.slice(0, 24),
        });
        this.onFrame?.(senderDid, payload);
      } catch (e) {
        log.warn('internet_ws_msg_err', { err: e instanceof Error ? e.message : String(e) });
      }
    };
    ws.onerror = (e) => {
      log.warn('internet_ws_err', {
        msg: (e as unknown as { message?: string })?.message ?? 'unknown',
      });
    };
    ws.onclose = (e) => {
      this.wsOpen = false;
      const code = (e as unknown as { code?: number })?.code;
      log.info('internet_ws_close', { code, attempt: this.reconnectAttempt });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.active) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const rawDelay = RECONNECT_MIN_MS * 2 ** (this.reconnectAttempt - 1);
    const delay = Math.min(rawDelay, RECONNECT_MAX_MS);
    // v4.32.132 (AUDIT P3): surface hitting the backoff ceiling once so
    // long relay outages are visible in logs. Prior version silently
    // looped at 30s with no indication that we were in the "stuck"
    // regime — debug sessions had to rely on counting internet_ws_close.
    if (rawDelay >= RECONNECT_MAX_MS && this.reconnectAttempt === Math.ceil(Math.log2(RECONNECT_MAX_MS / RECONNECT_MIN_MS)) + 1) {
      log.warn('internet_reconnect_backoff_maxed', {
        attempt: this.reconnectAttempt,
        delayMs: delay,
      });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.openWs();
    }, delay);
  }
}

let singleton: InternetTransport | null = null;

export function getInternetTransportSingleton(): InternetTransport {
  if (!singleton) singleton = new InternetTransport();
  return singleton;
}
