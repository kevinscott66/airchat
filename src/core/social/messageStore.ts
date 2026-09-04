import { CID } from 'multiformats/cid';
import { getHeliaUnixfs } from '../transport/ipfs/heliaNode';
import { addToIpfs, catFromIpfs } from '../transport/ipfs/node';
import { cacheGet, cachePut } from '../transport/ipfs/blockstore';
import { pubsubPublish, pubsubSubscribe } from '../transport/ipfs/pubsub';
import { isPlainCid } from '../cid';
import { log } from '../logger';

/** Helia `addBytes` может висеть на libp2p — ограничиваем ожидание, дальше retry/outbox. */
const HELIA_ADD_BYTES_TIMEOUT_MS = 2000;

export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read';

export type EncryptedMessage = {
  messageId: string;
  senderDid: string;
  recipientDid: string;
  /** Full output of encryptSymmetric (24-byte nonce + ciphertext). */
  encryptedContent: Uint8Array;
  timestamp: number;
  /** Previous message in the DM DAG (IPFS CID). */
  previousMessageCid?: string;
  replyTo?: string;
  mediaCids?: string[];
  /**
   * v4.32.207: mesh-gossip hop counter. Starts at 0; each relay increments.
   * Bounded by MAX_RELAY_HOPS on receive. Additive field, v=1 backward-compat:
   * old clients ignore it; new clients use it for loop prevention.
   */
  hops?: number;
};

function topicFor(contactDidA: string, contactDidB: string): string {
  return `airchat-dm-${[contactDidA, contactDidB].sort().join('-')}`;
}

/**
 * v4.32.118 Stage 2: per-recipient self-inbox pubsub topic.
 * Every user subscribes to `airchat-inbox-<myDid>` during startListening;
 * senders publish the serialized EncryptedMessage wire bytes to
 * `airchat-inbox-<recipientDid>` for any DM (including to non-contacts).
 *
 * Why: the shared `airchat-dm-<didA>-<didB>` topic only works if both sides
 * have each other in contacts (so both subscribe). For Telegram-style DM to
 * strangers we need a predictable topic the recipient is ALREADY listening on
 * regardless of whether they know the sender.
 *
 * Security: envelope is still encryptSymmetric'd with ECDH-derived key. The
 * pubsub layer is untrusted; an attacker who publishes garbage to our inbox
 * will get silently dropped at decrypt.
 */
export function selfInboxTopic(did: string): string {
  return `airchat-inbox-${did}`;
}

export class IPFSMessageStore {
  async publishMessage(message: EncryptedMessage): Promise<string | null> {
    try {
      const payload = new TextEncoder().encode(JSON.stringify(serializeEnvelope(message)));
      const fs = await getHeliaUnixfs();
      if (fs) {
        const cid = await Promise.race([
          fs.addBytes(payload),
          new Promise<never>((_, rej) => {
            setTimeout(
              () => rej(new Error(`helia_add_bytes_timeout_${HELIA_ADD_BYTES_TIMEOUT_MS}ms`)),
              HELIA_ADD_BYTES_TIMEOUT_MS
            );
          }),
        ]).catch((e) => {
          log.warn('message_store_helia_add_timeout', {
            err: e instanceof Error ? e.message : String(e),
          });
          return null;
        });
        if (!cid) {
          const fallback = await addToIpfs(payload);
          if (fallback) await cachePut(fallback, payload);
          return fallback;
        }
        const s = cid.toString();
        await cachePut(s, payload);
        return s;
      }
      const cid = await addToIpfs(payload);
      if (cid) await cachePut(cid, payload);
      return cid;
    } catch (e) {
      log.warn('message_store_publish_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  async getMessage(cidStr: string): Promise<EncryptedMessage | null> {
    try {
      const cached = await cacheGet(cidStr);
      let raw: Uint8Array | null = cached;
      if (!raw) {
        const fs = await getHeliaUnixfs();
        if (fs) {
          const cid = CID.parse(cidStr);
          const chunks: Uint8Array[] = [];
          // v4.32.195 (Round-25 #1): bound helia fetch at WIRE_MAX_BYTES.
          // A peer-referenced CID could stream unbounded bytes and stall the
          // JS thread on TextDecoder/JSON.parse. Cat path has a 50MB cap, but
          // envelopes should never exceed 64KB.
          let running = 0;
          let oversized = false;
          for await (const buf of fs.cat(cid)) {
            running += buf.length;
            if (running > WIRE_MAX_BYTES) { oversized = true; break; }
            chunks.push(buf);
          }
          if (oversized) {
            log.warn('message_store_helia_oversize_drop', { cidStr: cidStr.slice(0, 12), bytes: running });
            return null;
          }
          const t = chunks.reduce((a, b) => a + b.length, 0);
          raw = new Uint8Array(t);
          let o = 0;
          for (const c of chunks) {
            raw.set(c, o);
            o += c.length;
          }
        } else {
          raw = await catFromIpfs(cidStr);
          // v4.32.204 (Round-34 #2): apply WIRE_MAX_BYTES cap on the fallback
          // path too. catFromIpfs has a 50MB global cap but envelopes must be
          // ≤ WIRE_MAX_BYTES — parity with the Helia branch above.
          if (raw && raw.byteLength > WIRE_MAX_BYTES) {
            log.warn('message_store_cat_oversize_drop', { cidStr: cidStr.slice(0, 12), bytes: raw.byteLength });
            return null;
          }
        }
        if (raw) await cachePut(cidStr, raw);
      }
      if (!raw) return null;
      const env = JSON.parse(new TextDecoder().decode(raw)) as ReturnType<typeof serializeEnvelope>;
      // v4.32.198 (Round-28 #5): apply the same wire-version check as
      // parseEnvelopeFromWire. A malicious CID could publish {v: 9999, ...}
      // and deserializeEnvelope would silently decode it as v1, potentially
      // misinterpreting future/added fields.
      const wireV = typeof env.v === 'number' ? env.v : 1;
      if (wireV > ENVELOPE_WIRE_VERSION) {
        log.warn('message_store_future_version', { got: wireV, supported: ENVELOPE_WIRE_VERSION });
        return null;
      }
      return deserializeEnvelope(env);
    } catch (e) {
      log.warn('message_store_get_failed', {
        err: e instanceof Error ? e.message : String(e),
        cidStr,
      });
      return null;
    }
  }

  /**
   * Raw pubsub line: CID string (unauth `read:`/`typing:` lines were removed
   * in v4.32.124 — see handlePubsubLine).
   * v4.32.124 (AUDIT P1): apply WIRE_MAX_BYTES cap to raw bytes BEFORE
   * decoding. Previously only parseEnvelopeFromWire enforced it; this path
   * decodes/TextDecoder any size an attacker publishes on the shared DM
   * topic and can stall the JS thread on megabyte strings.
   */
  subscribeToContact(
    myDid: string,
    contactDid: string,
    onData: (data: string) => void
  ): Promise<(() => void) | null> {
    const t = topicFor(myDid, contactDid);
    return pubsubSubscribe(t, (msg) => {
      try {
        if (msg.data.length > WIRE_MAX_BYTES) {
          log.warn('dm_topic_line_oversize', { size: msg.data.length });
          return;
        }
        const s = new TextDecoder().decode(msg.data).trim();
        onData(s);
      } catch (e) {
        log.warn('message_store_pubsub_parse_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  async announceCid(myDid: string, contactDid: string, cid: string): Promise<void> {
    const t = topicFor(myDid, contactDid);
    await pubsubPublish(t, new TextEncoder().encode(cid));
  }

  async announceReadReceipt(myDid: string, contactDid: string, messageId: string): Promise<void> {
    const t = topicFor(myDid, contactDid);
    await pubsubPublish(t, new TextEncoder().encode(`read:${messageId}`));
  }

  async announceTyping(myDid: string, contactDid: string): Promise<void> {
    const t = topicFor(myDid, contactDid);
    await pubsubPublish(t, new TextEncoder().encode('typing:'));
  }

  /**
   * v4.32.118 Stage 2: subscribe to OUR self-inbox. Any sender who publishes
   * an encrypted wire envelope to `airchat-inbox-<myDid>` lands here.
   * `onWire` receives raw bytes (serialized EncryptedMessage), same format
   * as LAN delivery; dispatching caller should run it through
   * `parseEnvelopeFromWire` + `receiveDirectLanEnvelope` (which already
   * handles unknown senders via ensureImplicitContact).
   */
  subscribeToSelfInbox(
    myDid: string,
    onWire: (wire: Uint8Array, claimedSenderDid: string) => void,
  ): Promise<(() => void) | null> {
    return pubsubSubscribe(selfInboxTopic(myDid), (msg) => {
      try {
        const env = parseEnvelopeFromWire(msg.data);
        if (!env) return;
        if (env.recipientDid !== myDid) return;
        // v4.32.120 #4: reject self-echo at the inbox layer. Prevents any
        // malicious republish of our own traffic (or multi-device same-DID
        // loops) from entering the ingress pipeline.
        if (env.senderDid === myDid) return;
        // claimedSenderDid will be re-validated by receiveDirectLanEnvelope
        // (checks env.senderDid matches + attempts decrypt with ECDH key).
        onWire(msg.data, env.senderDid);
      } catch (e) {
        log.warn('self_inbox_parse_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  /**
   * v4.32.118 Stage 2: publish wire envelope into recipient's self-inbox.
   * v4.32.125 (AUDIT P2): log transport-layer errors instead of silently
   * returning false — callers (MessagingService) already treat false as
   * "fall through to LAN / outbox", но при дебаге полезно знать причину.
   */
  async publishToSelfInbox(recipientDid: string, wire: Uint8Array): Promise<boolean> {
    try {
      return await pubsubPublish(selfInboxTopic(recipientDid), wire);
    } catch (e) {
      log.warn('self_inbox_publish_failed', {
        recipientDid: recipientDid.slice(-16),
        err: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }
}

/**
 * v4.32.125 (AUDIT P2): explicit wire-format version.
 * Adding `v` now means future breaking changes can bump to 2 and receivers
 * will reject cleanly rather than decoding as v1 and misinterpreting fields.
 * Receivers (deserializeEnvelope + parseEnvelopeFromWire) treat missing `v`
 * as 1 for backwards compat with envelopes already serialized to disk.
 */
const ENVELOPE_WIRE_VERSION = 1;

function serializeEnvelope(m: EncryptedMessage) {
  return {
    v: ENVELOPE_WIRE_VERSION,
    messageId: m.messageId,
    senderDid: m.senderDid,
    recipientDid: m.recipientDid,
    encryptedContent: Buffer.from(m.encryptedContent).toString('base64'),
    timestamp: m.timestamp,
    previousMessageCid: m.previousMessageCid,
    replyTo: m.replyTo,
    mediaCids: m.mediaCids,
    // v4.32.207: mesh-gossip hop counter. Additive — old clients ignore it.
    hops: typeof m.hops === 'number' ? m.hops : undefined,
  };
}

/** JSON конверта для fallback-транспортов (MultiTransportRouter). */
export function serializeEnvelopeToBytes(m: EncryptedMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(serializeEnvelope(m)));
}

function deserializeEnvelope(env: {
  v?: number;
  messageId: string;
  senderDid: string;
  recipientDid: string;
  encryptedContent: string;
  timestamp: number;
  previousMessageCid?: string;
  replyTo?: string;
  mediaCids?: string[];
  hops?: number;
}): EncryptedMessage {
  // v4.32.197 (Round-27 #5): even after outer JSON.parse shape-check, coerce
  // and cap fields before downstream code reads them. A legit-keyed peer can
  // still inject `mediaCids: Array(100000).fill(...)` or non-string fields
  // that crash `.slice()` / bloat SQLite rows.
  const mediaCids = Array.isArray(env.mediaCids)
    ? env.mediaCids.filter((c) => typeof c === 'string' && c.length <= 128).slice(0, 32)
    : undefined;
  return {
    messageId: typeof env.messageId === 'string' ? env.messageId.slice(0, 128) : '',
    senderDid: typeof env.senderDid === 'string' ? env.senderDid.slice(0, 256) : '',
    recipientDid: typeof env.recipientDid === 'string' ? env.recipientDid.slice(0, 256) : '',
    // v4.32.581: единственное поле, которое проверку обошло. Остальные восемь
    // приводятся по типу с потолком, а это уходило прямо в Buffer.from — и
    // конверт с `encryptedContent: 123` бросал исключение вместо того, чтобы
    // разобраться в пустой шифротекст и быть отброшенным по общему правилу.
    encryptedContent: typeof env.encryptedContent === 'string'
      ? new Uint8Array(Buffer.from(env.encryptedContent, 'base64'))
      : new Uint8Array(0),
    timestamp: typeof env.timestamp === 'number' && Number.isFinite(env.timestamp) ? env.timestamp : Date.now(),
    previousMessageCid: isPlainCid(env.previousMessageCid) ? env.previousMessageCid : undefined,
    replyTo: typeof env.replyTo === 'string' && env.replyTo.length <= 128 ? env.replyTo : undefined,
    mediaCids: mediaCids && mediaCids.length > 0 ? mediaCids : undefined,
    // v4.32.207: hops counter — clamp [0, 3] to bound relay depth.
    hops: typeof env.hops === 'number' && Number.isFinite(env.hops)
      ? Math.max(0, Math.min(3, env.hops | 0))
      : undefined,
  };
}

/**
 * v4.32.120: hard cap on attacker-controlled pubsub payload to prevent JS-thread
 * stalls on megabyte-sized JSON. 64 KiB covers legitimate envelopes (text+media
 * refs are small; actual media lives under mediaCids → IPFS).
 */
const WIRE_MAX_BYTES = 64 * 1024;

/** Разбор wire-формата (тот же JSON, что и в IPFS-блоке). */
export function parseEnvelopeFromWire(data: Uint8Array): EncryptedMessage | null {
  if (data.length > WIRE_MAX_BYTES) {
    log.warn('wire_envelope_oversize', { size: data.length });
    return null;
  }
  try {
    const env = JSON.parse(new TextDecoder().decode(data)) as {
      v?: number;
      messageId: string;
      senderDid: string;
      recipientDid: string;
      encryptedContent: string;
      timestamp: number;
      previousMessageCid?: string;
      replyTo?: string;
      mediaCids?: string[];
      hops?: number;
    };
    // v4.32.125 (AUDIT P2): reject future versions we don't understand rather
    // than silently decode as v1 and misinterpret new fields. Missing `v` is
    // treated as v1 for envelopes serialized before this field was added.
    const wireV = typeof env.v === 'number' ? env.v : 1;
    if (wireV > ENVELOPE_WIRE_VERSION) {
      log.warn('wire_envelope_future_version', { got: wireV, supported: ENVELOPE_WIRE_VERSION });
      return null;
    }
    return deserializeEnvelope(env);
  } catch {
    return null;
  }
}
