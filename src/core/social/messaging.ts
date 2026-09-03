import { v4 as uuidv4 } from 'uuid';
import { encryptSymmetric, decryptSymmetric } from '../crypto/encrypt';
import type { KeyPairBytes } from '../crypto/keyManager';
import { publicKeyToDidKey, parseDidKey, didFromPubB64 } from '../identity/did';
import { ownerPidByDid } from '../identity/ownerProfile';
import { publicKeyFromB64, publicKeyToB64 } from '../crypto/pubKeyFormat';
import {
  getLocalConversationTips,
  republishProfileFromKv,
  setLocalConversationTip,
} from '../identity/profile';
import { log } from '../logger';
import {
  chatMessageExists,
  deleteChatMessage,
  getChatMessageAuthor,
  getChatMessageTexts,
  listChatMessages,
  upsertChatMessage,
  saveChatMessage,
  updateChatMessageStatus,
  updateChatMessageText,
  touchConversation,
  type ChatMessageRow,
} from '../storage/local';
import { oldestCursor, type ChatPageCursor } from '../storage/chatPageCursor';
import { checkOnlineWrite, requireOnlineWrite } from '../sync/cachePolicy';
import { combineHalves, shouldTryPeerHalf, type TwoSidedOutcome } from './twoSidedEdit';
import { handleIncomingGroupEnvelope, handleIncomingGroupReadReceipt, handleIncomingGroupJoinRequest, handleIncomingGroupControl, GROUP_READ_RECEIPT_PREFIX, GROUP_JOIN_REQUEST_PREFIX, GROUP_CTL_PREFIX } from './groupMessaging';
import { receiptOverflowCount, sanitizeReceiptIds } from './receiptBatch';
import { withinMessageTextLimit } from './messageTextLimit';
import { sanitizeMediaCids, serializeMediaCids } from '../media/mediaCidPolicy';
import { groupRecipient, type GroupRecipient } from './groupRecipient';
// Префикс — из кодека без импортов: reactionSync тянет обратно messaging,
// статический импорт замкнул бы цикл (сам обработчик грузится динамически).
import { REACTION_PREFIX } from './reactionEnvelope';
import { POLL_CLOSE_PREFIX, POLL_VOTE_PREFIX } from './pollVoteEnvelope';
import { isPollMessage } from './pollEnvelope';
import { STORY_PREFIX } from './storyEnvelope';
import { DM_PIN_PREFIX } from './dmPinEnvelope';
import { DISAPPEAR_PREFIX } from './disappearEnvelope';
import { PRESENCE_PREF_PREFIX } from './presenceEnvelope';
import { PROFILE_PREFIX } from './profileEnvelope';
import { stripSpoofedSysPrefix } from './sysLineGuard';
import { isPlainCid } from '../cid';
import { isNbCid } from '../media/mediaBlob';
import { isIpfsEnabled } from '../transport/ipfs/heliaNode';
import { multiTransportRouter } from '../transport/multiTransport';
import { getSymmetricKeyForPeer, listContacts, ensureImplicitContact, deriveSymmetricKeyForStranger, clearSymKeyCache } from './contacts';
import {
  IPFSMessageStore,
  parseEnvelopeFromWire,
  serializeEnvelopeToBytes,
  type EncryptedMessage,
} from './messageStore';
import { dmPairKey, syncDmHistoryFromProfile } from './messageSync';
import { type CtlRetryPayload } from './ctlRetryPayload';
import { runWithConcurrency } from '../utils/runWithConcurrency';
import { ErrorHandler, ErrorSeverity } from '../errorHandler';
import { rateLimiter } from '../security/rateLimiter';
import { privacyPrefTryBoolFor, readReceiptsAllowedFor } from '../settings/privacyPrefs';
import { profileManager } from '../identity/profileManager';
import { clearDekMemory } from '../storage/localEncryption';
import { recordPeerActivityFor } from './presenceService';

/**
 * Чем кончилась попытка сообщить собеседнику о служебном действии («удалить у
 * всех», «изменить у всех»). У себя действие выполнено в любом случае — этот
 * ответ только про вторую половину.
 *
 * v4.32.431. Раньше обе функции возвращали `string | null`, и оба места в
 * ChatScreen читали это как «да/нет», причём по-разному: один вызов показывал
 * «Не удалось удалить — нет связи с облаком», другой не проверял результат
 * вовсе. Различить «доставлено», «подождём связи» и «канала нет» одним null
 * было нечем, поэтому человеку сообщали неправду в обе стороны. В cache-only
 * режиме теперь остаются только `sent` и `unreachable`: отправка без сети не
 * получает обещание будущей доставки.
 */
// v4.32.555: «удалить у всех» и «изменить у всех» перестали отвечать одним
// словом про сеть. Обе половины — своя строка и конверт собеседнику — теперь
// называются вместе, см. `twoSidedEdit.ts`.
export type { PeerDelivery, TwoSidedOutcome } from './twoSidedEdit';

type InnerPayload =
  | { kind?: 'text'; text: string; mediaCids?: string[]; replyToId?: string; replyToPreview?: string }
  | { kind: 'delete'; targetMessageId: string }
  | { kind: 'edit'; targetMessageId: string; newText: string }
  | { kind: 'read_receipt'; messageIds: string[] }
  | { kind: 'typing' };

/**
 * v4.32.124 (AUDIT P0 #1): replay window for envelope timestamps.
 * Dedupe by messageId uses a 4096-entry FIFO + SQLite existence check; once
 * the FIFO evicts an id and the local row is GC'd, a captured ciphertext
 * could be replayed as a fresh inbound. Reject envelopes older than 7 days
 * or more than 5 minutes in the future.
 */
const ENVELOPE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ENVELOPE_MAX_SKEW_MS = 5 * 60 * 1000;

// PUBLISH_RETRIES=1 означал 1 итерацию (i=0), проверка `i < 0` никогда не true → delay не срабатывал.
// Теперь 3 попытки с задержкой между ними.
const PUBLISH_RETRIES = 3;

// v4.32.238: единая подпись сообщения живёт в messagePreview.ts — четыре
// копии этой цепочки успели разойтись по набору префиксов. Ре-экспорт
// сохранён: имя используется по всему проекту.
import { isControlOnlyText, isSilentEnvelope, previewLabelForText, truncateReplyPreview } from './messagePreview';
import { LIVELOC_PREFIX, isLiveLocMessage, parseLiveLoc } from './locationEnvelope';
import { chatRowIdForLiveLoc, decideLiveLocUpdate } from './liveLocRowIdentity';
import { classifyPushKind } from '../../notifications/pushKind';
import { decideMediaSend, tallyMediaUploads } from '../media/mediaSendReport';
import type { MediaUploadResult } from '../media/mediaUpload';
import { sanitizeReplyRef } from './replyRef';
import { survivesBlock } from './blockPolicy';
import { type DmRetryPayload } from './dmRetryPayload';
export { previewLabelForText };

// ─── In-app notification emitter ─────────────────────────────────────────────
/**
 * Событие «пришло личное сообщение».
 *
 * v4.32.477: к нему добавлены `cid` и `senderDid`. Раньше событие несло
 * только собеседника и превью — этого хватало плашке внутри приложения, но
 * не системному уведомлению: ему нужен собеседник в виде DID (проверка
 * «этот чат заглушён») и ключ, по которому уведомление об ЭТОМ сообщении
 * показывается один раз, даже если оно доехало и по сети, и следом за push.
 */
export type InAppNotification = {
  peerPubB64: string;
  preview: string;
  /** Ключ сообщения: CID из IPFS либо `lan:<id>` для прямой доставки. */
  cid: string;
  /** DID отправителя — по нему проверяется заглушение и открывается чат. */
  senderDid: string;
};
type InAppNotifCb = (n: InAppNotification) => void;
const inAppListeners = new Set<InAppNotifCb>();
export function subscribeInAppNotifications(cb: InAppNotifCb): () => void {
  inAppListeners.add(cb);
  return () => inAppListeners.delete(cb);
}
function emitInApp(n: InAppNotification): void {
  for (const cb of inAppListeners) { try { cb(n); } catch { /* ignore */ } }
}

/**
 * Виден ли этот собеседник по локальной сети прямо сейчас.
 *
 * v4.32.550: ответ идёт в `requireOnlineWrite`, чтобы Wi‑Fi без выхода наружу
 * перестал отменять отправку. LAN — транспорт первого приоритета; когда пир
 * найден по mDNS, интернет для доставки не нужен вовсе.
 */
async function localPathTo(contactPubB64: string): Promise<boolean> {
  const did = didFromPubB64(contactPubB64);
  if (!did) return false;
  return multiTransportRouter.hasLocalPath(did);
}

async function findContactPubKeyByDid(did: string): Promise<string | null> {
  try {
    const contacts = await listContacts();
    for (const c of contacts) {
      if (didFromPubB64(c.peerPublicKey) === did) return c.peerPublicKey;
    }
    return null;
  } catch (e) {
    log.warn('contact_find_did_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - start;
    if (ms > 300) {
      log.info('perf_step', { step: name, ms });
    }
  }
}

function measureSync<T>(name: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - start;
    if (ms > 300) {
      log.info('perf_step', { step: name, ms });
    }
  }
}

/** Повторяет публикацию в IPFS при временных сбоях (короткие задержки — цель быстрый fallback/outbox). */
async function publishMessageWithRetry(
  store: IPFSMessageStore,
  em: EncryptedMessage
): Promise<string | null> {
  // v4.32.19: если IPFS выключен (Android/iOS), не крутим retry-loop ­— сразу null,
  // чтобы вызывающий перешёл на multiTransportRouter (WebRTC/LAN/wifi_direct) или outbox.
  if (!isIpfsEnabled()) return null;
  for (let i = 0; i < PUBLISH_RETRIES; i++) {
    const cid = await store.publishMessage(em);
    if (cid) return cid;
    if (i < PUBLISH_RETRIES - 1) {
      const ms = 350;
      log.info('dm_publish_retry', { attempt: i + 1, delayMs: ms });
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  return null;
}

let messagingInstance: MessagingService | null = null;

export function initMessagingService(pair: KeyPairBytes): MessagingService {
  messagingInstance?.dispose();
  messagingInstance = new MessagingService(pair);
  void messagingInstance.startListening();
  // v4.32.247: разослать свой профиль тем контактам, которые ещё не получили
  // текущую версию. Отправка идёт по одному разу на версию (см. profileSync),
  // поэтому обычный запуск приложения ничего не шлёт.
  void import('./profileSync')
    .then((m) => m.broadcastMyProfile())
    .catch(() => { /* офлайн — разошлём при следующем запуске */ });
  return messagingInstance;
}

export function getMessagingService(): MessagingService | null {
  return messagingInstance;
}

export function disposeMessagingService(): void {
  messagingInstance?.dispose();
  messagingInstance = null;
  // v4.32.124 (AUDIT P1): drop derived sym keys for the previous identity so
  // they can't decrypt traffic of a subsequent login to a different profile.
  clearSymKeyCache();
}

/**
 * v4.32.377: здесь жили sendDirectMessage и decryptIncoming — свободные
 * функции рядом с классом, который делает то же самое. Не вызывал их никто, в
 * том числе тесты, хотя у первой было написано «kept for tests».
 *
 * Обе были не просто лишними. sendDirectMessage начиналась с
 * initMessagingService: «отправить одно сообщение» означало снести живой
 * сервис вместе со всеми его подписками и поднять новый. А decryptIncoming
 * была вторым, отдельно написанным разбором чужого шифртекста из IPFS — со
 * своими потолками и своими проверками формы, которые расходились с боевыми
 * молча, потому что этот путь никогда не исполнялся.
 */

export class MessagingService {
  private readonly pair: KeyPairBytes;
  private readonly store = new IPFSMessageStore();
  private unsub: Array<() => void> = [];
  private listening = false;
  /**
   * v4.32.124 (AUDIT P1): subscription generation counter. Each dispose()
   * bumps it. startListening() captures the gen at entry and, after each
   * awaited subscribeToContact resolves, checks it against the current
   * value — if changed (dispose() ran mid-iteration), the newly-obtained
   * unsub is called immediately instead of being pushed onto a stale list.
   */
  private subGen = 0;
  /** In-memory dedup: prevents duplicate delivery (e.g. LAN + pubsub simultaneously).
   * v4.32.117: capped at SEEN_MAX via FIFO eviction to bound memory for long-running sessions. */
  private readonly seenMessageIds = new Set<string>();
  // v4.32.124 (AUDIT P1): bumped from 4096 → 16384 to cover bursts from the
  // 3-path ingress (shared DM topic CID + self-inbox wire + LAN fallback)
  // plus retries. Memory cost is bounded (16k UUIDv4 strings ≈ 580 KB).
  private static readonly SEEN_MAX = 16384;
  /** Add to dedup set with FIFO eviction when size exceeds SEEN_MAX. */
  private markSeen(id: string): void {
    if (this.seenMessageIds.size >= MessagingService.SEEN_MAX) {
      const first = this.seenMessageIds.values().next().value as string | undefined;
      if (first) this.seenMessageIds.delete(first);
    }
    this.seenMessageIds.add(id);
  }

  /**
   * v4.32.207 (Bridge Stage 1): mesh-gossip relay for DMs.
   * When we receive an envelope addressed to someone else (recipientDid ≠ myDid),
   * forward it via our own multiTransportRouter to the real recipient. This
   * bridges topologies — e.g. a sender on WAN reaches a recipient on LAN-only
   * if we (their mutual contact) straddle both transports.
   *
   * Safety:
   * - hops counter bounded [0, MAX_RELAY_HOPS=3] to prevent loops.
   * - seenMessageIds dedup on messageId blocks re-relay of the same envelope.
   * - ciphertext remains opaque to us (ECDH key is pairwise A↔B).
   * - self-inbox publish is also attempted for WAN bridging.
   * - fire-and-forget: never blocks ingress.
   */
  private static readonly MAX_RELAY_HOPS = 3;
  /**
   * v4.32.210 (Audit-39): relay hop is DIRECT-ONLY, no fan-out. Sender-side
   * gossipDmToContacts does the one-shot fan-out at send time; each relay
   * hop just tries to push directly to the real recipient. This caps total
   * network traffic at ≈N (sender contacts) instead of N^hops. If a relay
   * node has the recipient as a contact, its direct push succeeds and the
   * DM lands; otherwise it silently fails (dedup still prevents loops).
   */
  private async maybeRelayDm(em: EncryptedMessage, claimedSenderDid: string): Promise<void> {
    try {
      const curHops = typeof em.hops === 'number' ? em.hops : 0;
      if (curHops >= MessagingService.MAX_RELAY_HOPS) {
        log.info('dm_relay_hop_limit', { messageId: em.messageId.slice(0, 8), hops: curHops });
        return;
      }
      if (this.seenMessageIds.has(em.messageId)) {
        return;
      }
      this.markSeen(em.messageId);
      const relayed: EncryptedMessage = { ...em, hops: curHops + 1 };
      const payload = serializeEnvelopeToBytes(relayed);
      const myDid = publicKeyToDidKey(this.pair.publicKey);
      if (em.recipientDid !== myDid) {
        void this.store.publishToSelfInbox(em.recipientDid, payload).catch(() => { /* ignore */ });
        void multiTransportRouter.send(payload, em.recipientDid).catch(() => { /* ignore */ });
      }
      log.info('dm_relayed', {
        messageId: em.messageId.slice(0, 8),
        hops: curHops + 1,
        to: em.recipientDid.slice(-16),
        via: claimedSenderDid.slice(-16),
      });
    } catch (e) {
      log.warn('dm_relay_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * v4.32.207 (Bridge Stage 1): cross-transport fan-out on send.
   * After the direct send paths, also push the envelope through each contact
   * as a gossip hop. Each contact will: (a) if they are the recipient, accept
   * it; (b) otherwise, run maybeRelayDm and forward further. This covers the
   * case where sender has internet, recipient has LAN-only, and a mutual
   * contact bridges the two topologies.
   *
   * Payload already has hops=0 (initial). Recipients that can't decrypt just
   * drop it at the ECDH gate. Fire-and-forget per contact.
   */
  /**
   * v4.32.211 (Audit-40 #2): cap fan-out at GOSSIP_FANOUT_LIMIT to prevent
   * a 1000-contact user from spawning 1000 concurrent multiTransportRouter
   * connection attempts. Each send can stack LAN→internet→webrtc→wifi_direct
   * retries that block for seconds — unbounded fan-out would thrash the
   * network. 64 is a pragmatic ceiling: covers typical social graphs, bounds
   * worst case memory+sockets.
   */
  private static readonly GOSSIP_FANOUT_LIMIT = 64;
  private async gossipDmToContacts(payload: Uint8Array, recipientDid: string, myDid: string): Promise<void> {
    try {
      const contacts = await listContacts();
      let sent = 0;
      for (const c of contacts) {
        if (sent >= MessagingService.GOSSIP_FANOUT_LIMIT) break;
        try {
          const pk = publicKeyFromB64(c.peerPublicKey);
          if (!pk) continue;
          const did = publicKeyToDidKey(pk);
          if (!did || did === myDid || did === recipientDid) continue;
          void multiTransportRouter.send(payload, did).catch(() => { /* ignore */ });
          sent += 1;
        } catch { /* ignore one bad contact */ }
      }
      if (contacts.length > MessagingService.GOSSIP_FANOUT_LIMIT) {
        log.info('dm_gossip_fanout_capped', { total: contacts.length, sent });
      }
    } catch (e) {
      log.warn('dm_gossip_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }

  /** v4.32.114: coalesce concurrent refreshSubscriptions() so multiple LAN DMs
   * from strangers don't spawn N parallel dispose/startListening cycles. */
  private refreshPending: Promise<void> | null = null;
  /** Typing signal listeners keyed by peerPublicKeyB64. Multiple listeners per peer supported. */
  private typingListeners: Map<string, Set<() => void>> = new Map();

  constructor(pair: KeyPairBytes) {
    this.pair = pair;
  }

  /** Профиль, которому принадлежит этот сервис. Ищется один раз (v4.32.457). */
  private ownerPid: number | null = null;

  /**
   * Номер профиля, в чьих переписках работает этот сервис.
   *
   * До v4.32.457 здесь читался ГЛОБАЛЬНЫЙ «активный профиль», хотя сервис
   * создаётся под конкретную пару ключей и пересоздаётся при каждом
   * переключении. Разница видна на длинном приёме: входящее личное сообщение
   * расшифровано ключом личного профиля, дальше по пути стоят await'ы (при
   * первом сообщении от незнакомца — полная пересборка подписок, это секунды),
   * и если человек за это время переключился на рабочий профиль, запись
   * ложилась в переписку рабочего — вместе с превью диалога и счётчиком
   * непрочитанных. Это видимая утечка между аккаунтами, а заводят их ровно
   * затем, чтобы такого не было.
   *
   * Теперь профиль определяется по ключу, которым сервис работает, и
   * запоминается: значение не может измениться посреди операции.
   *
   * v4.32.470: метод стал публичным. Очередь отправки (storage/sync) обязана
   * сверить владельца строки с владельцем службы ПЕРЕД отправкой, а другого
   * честного источника «чей это сервис» нет: глобальный активный профиль
   * успевает смениться, пара ключей — нет.
   */
  async ownerProfileId(): Promise<number> {
    if (this.ownerPid !== null) return this.ownerPid;
    const found = this.lookupOwnerPid();
    if (found !== null) {
      this.ownerPid = found;
      return found;
    }
    // v4.32.228 (PERF #34, CRIT): холодный путь — только когда профили ещё не
    // подняты. Раньше `await profileManager.init()` стоял на КАЖДОМ
    // getMessages / send / receive и на устройстве давал profileMs ≈ 2.4s
    // каждые 15 секунд: JS-поток замирал, keepalive relay'я голодал, сокет
    // падал с 1006. Теперь ответ запоминается и этот путь проходится однажды.
    await profileManager.init();
    const late = this.lookupOwnerPid();
    if (late !== null) {
      this.ownerPid = late;
      return late;
    }
    return 1;
  }

  /**
   * Кто мы для группового приёмника (v4.32.465).
   *
   * Групповые обработчики раньше выясняли это сами — через активный профиль и
   * `loadKeyPair()`, то есть через два глобальных источника, которые меняются
   * при переключении аккаунта. Служба знает ответ точно: пара у неё своя, а
   * номер профиля выведен из этой же пары. Отдаём его одним значением.
   */
  async groupRecipient(): Promise<GroupRecipient> {
    return groupRecipient(await this.ownerProfileId(), this.pair);
  }

  /** Профиль по ключу сервиса, а не по тому, что активно прямо сейчас. */
  private lookupOwnerPid(): number | null {
    return ownerPidByDid(
      publicKeyToDidKey(this.pair.publicKey),
      profileManager.getActiveProfile(),
      () => profileManager.getAllProfiles(),
    );
  }

  dispose(): void {
    clearDekMemory();
    // Bump generation first so any in-flight subscribeToContact knows its
    // result is stale by the time it resolves.
    this.subGen++;
    for (const u of this.unsub) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.unsub = [];
    this.listening = false;
  }

  async refreshSubscriptions(): Promise<void> {
    // Coalesce: if a refresh is already running, return the same promise.
    if (this.refreshPending) return this.refreshPending;
    this.refreshPending = (async () => {
      try {
        this.dispose();
        await this.startListening();
      } finally {
        this.refreshPending = null;
      }
    })();
    return this.refreshPending;
  }

  async startListening(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    // v4.32.124 (AUDIT P1): capture the generation at start; every await below
    // re-checks it and discards subscriptions that arrived after a dispose().
    const gen = this.subGen;
    const stillFresh = (): boolean => this.subGen === gen;
    const myDid = publicKeyToDidKey(this.pair.publicKey);
    // v4.32.118 Stage 2: always subscribe to our own self-inbox so strangers
    // can DM us without first being in our contacts. The handler dispatches
    // via receiveDirectLanEnvelope, which calls ensureImplicitContact for
    // unknown senders (T1 path).
    const inboxUnsub = await this.store.subscribeToSelfInbox(myDid, (wire, claimedSenderDid) => {
      void this.receiveDirectLanEnvelope(wire, claimedSenderDid).catch((e) => {
        log.warn('self_inbox_dispatch_failed', { err: e instanceof Error ? e.message : String(e) });
      });
    });
    if (inboxUnsub) {
      if (!stillFresh()) { try { inboxUnsub(); } catch { /* ignore */ } }
      else this.unsub.push(inboxUnsub);
    }
    const contacts = await listContacts();
    if (!stillFresh()) return;
    let subscribedCount = 0;
    for (const c of contacts) {
      const peerDid = didFromPubB64(c.peerPublicKey);
      // Порченая строка контакта дала бы did:key, который не примет обратно ни
      // один разборщик: подписка на такой топик молча не слышит ничего.
      if (!peerDid) {
        log.warn('subscribe_bad_contact_pub');
        continue;
      }
      const unsub = await this.store.subscribeToContact(myDid, peerDid, (raw) => {
        void this.handlePubsubLine(c.peerPublicKey, raw);
      });
      if (unsub) {
        if (!stillFresh()) {
          try { unsub(); } catch { /* ignore */ }
          continue;
        }
        this.unsub.push(unsub);
        subscribedCount++;
      }
    }
    // If IPFS pubsub was not available and we have contacts but zero subscriptions,
    // reset the flag so the next sendMessage call retries subscription setup.
    if (subscribedCount === 0 && contacts.length > 0) {
      this.listening = false;
    }
  }

  /** Pull up to `limit` messages from peer profile DAG tip (requires contact profileCid). */
  async syncHistoryFromPeer(peerPublicKeyB64: string, limit = 100): Promise<void> {
    await syncDmHistoryFromProfile({
      pair: this.pair,
      peerPublicKeyB64,
      limit,
      store: this.store,
      importCid: (cid) => this.receiveCid(cid, peerPublicKeyB64),
    });
  }

  private async handlePubsubLine(peerPubKeyB64: string, raw: string): Promise<void> {
    // v4.32.124 (AUDIT P0 #2, #3): legacy unauthenticated `read:<id>` and
    // `typing:` lines removed. The shared `airchat-dm-<a>-<b>` topic is
    // joinable by any peer that knows both DIDs; unauth control lines
    // allowed third parties to flip local status to `read` or forge typing
    // indicators. Both now travel inside encrypted envelopes
    // (kind='read_receipt' and kind='typing'), handled in
    // persistIncomingFromEnvelope after decrypt.
    const cid = raw.trim();
    if (cid.startsWith('Qm') || cid.startsWith('baf')) {
      await this.receiveCid(cid, peerPubKeyB64);
    }
  }

  /** Subscribe to typing signals from a peer. Multiple listeners per peer supported. Returns an unsubscribe fn. */
  onTyping(peerPubKeyB64: string, callback: () => void): () => void {
    let cbs = this.typingListeners.get(peerPubKeyB64);
    if (!cbs) { cbs = new Set(); this.typingListeners.set(peerPubKeyB64, cbs); }
    cbs.add(callback);
    return () => {
      const set = this.typingListeners.get(peerPubKeyB64);
      if (set) { set.delete(callback); if (set.size === 0) this.typingListeners.delete(peerPubKeyB64); }
    };
  }

  async sendTypingIndicator(contactPubB64: string): Promise<void> {
    // v4.32.124 (AUDIT P0 #3): route typing through an authenticated encrypted
    // envelope instead of the unauth `typing:` pubsub line.
    await this.sendEncryptedControl(contactPubB64, { kind: 'typing' });
  }

  /**
   * v4.32.124 (AUDIT P0 #2, #3): encrypt a control payload (read_receipt / typing)
   * and deliver via self-inbox pubsub + LAN fallback. No CID save, no DB row,
   * no conversation-tip update — these control messages are ephemeral.
   * Requires a known sym key (contact row must exist); silently no-ops if not.
   */
  private async sendEncryptedControl(contactPubB64: string, payload: InnerPayload): Promise<void> {
    try {
      const sym = await getSymmetricKeyForPeer(await this.ownerProfileId(), contactPubB64);
      if (!sym) return;
      const peerDid = didFromPubB64(contactPubB64);
      if (!peerDid) return;
      const myDid = publicKeyToDidKey(this.pair.publicKey);
      if (peerDid === myDid) return;
      // v4.32.214 (Audit-43 C1): embed authenticated _ts INSIDE the AEAD
      // ciphertext so the outer em.timestamp (unauthenticated) cannot be
      // tampered with to slide a captured envelope past the replay window.
      const ts = Date.now();
      const inner = new TextEncoder().encode(JSON.stringify({ ...payload, _ts: ts }));
      const encryptedContent = encryptSymmetric(sym, inner);
      const em: EncryptedMessage = {
        messageId: uuidv4(),
        senderDid: myDid,
        recipientDid: peerDid,
        encryptedContent,
        timestamp: ts,
      };
      const wire = serializeEnvelopeToBytes(em);
      // Fire-and-forget: ephemeral control should never block the caller.
      void this.store.publishToSelfInbox(peerDid, wire).catch(() => { /* ignore */ });
      void multiTransportRouter.send(wire, peerDid).catch(() => { /* ignore */ });
    } catch (e) {
      log.warn('encrypted_control_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }

  async receiveCid(cid: string, peerPubKeyB64: string): Promise<void> {
    if (cid.startsWith('fallback:')) {
      log.debug('receiveCid_skip_fallback_placeholder', { cid });
      return;
    }
    const em = await this.store.getMessage(cid);
    if (!em) {
      log.warn('msg_ipfs_missing', { cid });
      return;
    }
    await this.persistIncomingFromEnvelope(em, peerPubKeyB64, cid);
  }

  /** Входящий DM по локальной сети (mDNS + TCP), без CID в IPFS. */
  async receiveDirectLanEnvelope(raw: Uint8Array, claimedSenderDid: string): Promise<void> {
    const em = parseEnvelopeFromWire(raw);
    if (!em) {
      log.warn('lan_envelope_parse_failed');
      return;
    }
    // v4.32.207: sender-hop mismatch is now informational, not fatal.
    // When peer C relays A→B, claimedSenderDid is C but env.senderDid is A.
    // The cryptographic auth gate is the ECDH-derived symmetric decrypt
    // below (line ~452) — if the envelope was forged by C, decryptSymmetric
    // will fail and we drop silently. This enables mesh gossip relay.
    if (em.senderDid !== claimedSenderDid) {
      log.info('dm_sender_differs_from_hop', { env: em.senderDid.slice(-16), hop: claimedSenderDid.slice(-16) });
    }
    const myDid = publicKeyToDidKey(this.pair.publicKey);
    // v4.32.120 #4: self-echo never enters ingress (defence-in-depth vs
    // subscribeToSelfInbox's own guard).
    if (em.senderDid === myDid) return;
    // v4.32.207: recipient-mismatch → mesh-gossip relay candidate.
    // Instead of dropping, try to forward toward the real recipient using
    // our own multi-transport router. Bounded by MAX_RELAY_HOPS and dedup
    // via seenMessageIds; ciphertext remains opaque (we can't decrypt it).
    if (em.recipientDid !== myDid) {
      void this.maybeRelayDm(em, claimedSenderDid);
      void raw;
      return;
    }

    // v4.32.120 #1: decrypt-before-implicit-contact. Attackers who spray
    // airchat-inbox-<victim> with random envelopes must fail decrypt BEFORE
    // any DB write, refreshSubscriptions(), or contacts_index mutation.
    // Sym-key derivation is deterministic (ECDH + canonical salt over sorted
    // pub keys) and purely in-memory — no side-effects. Only on decrypt
    // success do we commit the implicit contact row.
    let peerPubKeyB64 = await findContactPubKeyByDid(em.senderDid);
    let needsImplicitContact = false;
    let senderPk: Uint8Array | null = null;
    if (!peerPubKeyB64) {
      // v4.32.427: длина после parseDidKey не проверяется — парсер отдаёт
      // либо ровно 32 байта, либо null. Второе условие здесь не могло стать
      // истинным ни при каком входе и лишь создавало вид проверки.
      senderPk = parseDidKey(em.senderDid);
      if (!senderPk) {
        log.warn('lan_unknown_sender_bad_did', { did: em.senderDid.slice(0, 20) });
        return;
      }
      peerPubKeyB64 = publicKeyToB64(senderPk);
      needsImplicitContact = true;
    }

    // Early decrypt gate — no persistence side-effects yet.
    let sym: Uint8Array | null = null;
    if (needsImplicitContact && senderPk) {
      sym = deriveSymmetricKeyForStranger(this.pair, senderPk);
    } else {
      sym = await getSymmetricKeyForPeer(await this.ownerProfileId(), peerPubKeyB64);
    }
    if (!sym) {
      log.warn('lan_symkey_unavailable');
      return;
    }
    const pt = decryptSymmetric(sym, em.encryptedContent);
    if (!pt) {
      // Attacker traffic or corrupt packet — drop silently, no DB touch.
      return;
    }
    // v4.32.170: privacy_only_contacts_msg — reject DMs from unknown peers
    // when the user asked «сообщения только от контактов». We drop after
    // successful decrypt (so the sender cannot distinguish us from offline),
    // and BEFORE ensureImplicitContact so we don't auto-create a row.
    if (needsImplicitContact) {
      try {
        // v4.32.311: решение своё у каждого аккаунта, см. privacyPrefs.
        // v4.32.460: и спрашиваем его у ТОГО аккаунта, чьим ключом расшифровали,
        // а не у того, чей экран сейчас открыт: расшифровка выше ждала сеть.
        // v4.32.474: «не смогли прочитать» теперь и правда отличимо от «не
        // трогали» — раньше отказ базы приходил сюда как «выключено», и ветка
        // ниже не исполнялась ни разу. Решение прежнее (принять), но след в
        // журнале появляется на самом деле.
        const onlyContacts = await privacyPrefTryBoolFor(
          await this.ownerProfileId(),
          'privacy_only_contacts_msg',
        );
        if (onlyContacts === null) {
          log.warn('dm_contacts_filter_unreadable', { did: em.senderDid.slice(0, 20) });
        } else if (onlyContacts) {
          log.info('dm_rejected_non_contact', { did: em.senderDid.slice(0, 20) });
          return;
        }
      } catch (e) {
        // v4.32.313: молчать здесь нельзя. Отказ чтения означает, что настройку
        // мы не знаем, и оба исхода плохи: отбросив сообщение, мы потеряем его
        // насовсем (отправитель считает, что доставил), приняв — впустим того,
        // кого человек мог просить не пускать. Выбран приём, потому что настройка
        // лежит в той же базе, что и сама переписка: если её не прочитать, то и
        // сохранять сообщение будет некуда. Но в журнале след остаётся.
        log.warn('dm_contacts_filter_unreadable', { err: e instanceof Error ? e.message : String(e) });
      }
    }
    // Decrypt succeeded → sender is the real holder of their secret key.
    // NOW it's safe to create the implicit contact row and persist.
    if (needsImplicitContact && senderPk) {
      try {
        const created = await ensureImplicitContact(await this.ownerProfileId(), this.pair, senderPk);
        // v4.32.120: only refresh pubsub subscriptions when a NEW row was
        // actually created (idempotent call returns false on existing rows).
        // This bounds refreshSubscriptions churn even if attacker-bypass is
        // ever found upstream.
        if (created) await this.refreshSubscriptions();
      } catch (e) {
        log.warn('lan_implicit_contact_failed', { err: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    const storageCid = `lan:${em.messageId}`;
    // Pass pre-verified plaintext through to persist path to avoid re-decrypting.
    await this.persistIncomingFromEnvelope(em, peerPubKeyB64, storageCid, pt);
  }

  private async persistIncomingFromEnvelope(
    em: EncryptedMessage,
    peerPubKeyB64: string,
    cid: string,
    preDecryptedPt?: Uint8Array,
  ): Promise<void> {
    const myDid = publicKeyToDidKey(this.pair.publicKey);
    if (em.senderDid !== myDid && em.recipientDid !== myDid) return;
    // v4.32.124 (AUDIT P0 #1): replay-window guard. Drops envelopes older than
    // ENVELOPE_MAX_AGE_MS or more than ENVELOPE_MAX_SKEW_MS in the future.
    // v4.32.214 (Audit-43 C1): em.timestamp is OUTER/unauthenticated — a relay
    // can rewrite it without breaking Poly1305. The authenticated _ts embedded
    // inside the plaintext (verified post-decrypt below) is the real gate.
    // This outer check is a cheap pre-filter to avoid the ECDH when the
    // attacker didn't even bother forging the outer ts.
    const now = Date.now();
    if (em.timestamp > now + ENVELOPE_MAX_SKEW_MS || em.timestamp < now - ENVELOPE_MAX_AGE_MS) {
      log.warn('envelope_timestamp_out_of_window', {
        delta_ms: now - em.timestamp,
        messageId: em.messageId.slice(0, 8),
      });
      return;
    }
    // Fast in-memory check before the async SQLite round-trip (prevents BLE+LAN race)
    if (this.seenMessageIds.has(em.messageId)) return;
    this.markSeen(em.messageId);
    if (await chatMessageExists(em.messageId, await this.ownerProfileId())) return;

    // v4.32.317: блок-лист поднимается с диска асинхронно, а конструктор
    // rateLimiter отрабатывает при загрузке модуля — до того, как открыта база.
    // Пока чтение не закончилось, isBlocked ниже отвечал «не заблокирован» на
    // кого угодно, и сообщение, пришедшее в это окно, оседало в переписке.
    // Ждём здесь, до расшифровки: сразу после неё стоит единственная проверка
    // блок-листа, и отвечать на неё «не заблокирован» по неготовности базы
    // нельзя (v4.32.491).
    await rateLimiter.whenReady();

    // v4.32.120: skip re-decrypt when caller (receiveDirectLanEnvelope)
    // already validated the envelope. This also avoids a second ECDH on the
    // hot self-inbox path.
    let pt: Uint8Array | null;
    if (preDecryptedPt) {
      pt = preDecryptedPt;
    } else {
      const sym = await getSymmetricKeyForPeer(await this.ownerProfileId(), peerPubKeyB64);
      if (!sym) {
        // Not our key (implicit contact not yet created) — don't poison dedup.
        this.seenMessageIds.delete(em.messageId);
        return;
      }
      pt = decryptSymmetric(sym, em.encryptedContent);
      if (!pt) {
        // Corrupt or not addressed to us — don't poison dedup so a later retry can succeed.
        this.seenMessageIds.delete(em.messageId);
        return;
      }
    }
    // v4.32.115: guard JSON.parse — malformed plaintext must not throw and must
    // un-mark seenMessageIds so a redelivery via another transport can be retried.
    let payload: InnerPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(pt)) as InnerPayload;
    } catch (e) {
      log.warn('dm_payload_parse_failed', { err: e instanceof Error ? e.message : String(e) });
      this.seenMessageIds.delete(em.messageId);
      return;
    }

    // v4.32.214 (Audit-43 C1): authenticated inner-timestamp check. If the
    // sender embedded _ts inside the encrypted plaintext (every v4.32.214+
    // sender does), verify: (a) it's within the replay window; (b) the outer
    // em.timestamp matches _ts within 60s — any larger mismatch means a relay
    // tried to slide the envelope. Legacy senders without _ts fall through to
    // the outer-ts check that already ran above (backward-compat, rollout).
    const innerTs = (payload as { _ts?: unknown })._ts;
    if (typeof innerTs === 'number' && Number.isFinite(innerTs)) {
      if (innerTs > now + ENVELOPE_MAX_SKEW_MS || innerTs < now - ENVELOPE_MAX_AGE_MS) {
        log.warn('envelope_inner_ts_out_of_window', {
          delta_ms: now - innerTs,
          messageId: em.messageId.slice(0, 8),
        });
        this.seenMessageIds.delete(em.messageId);
        return;
      }
      // v4.32.215 (Audit-44 M): tightened from 60s → 10s. Sender sets both
      // to Date.now() in the same microsecond so any mismatch beyond a few
      // ms is tampering; 10s is a generous ceiling for misconfigured clocks.
      if (Math.abs(innerTs - em.timestamp) > 10_000) {
        log.warn('envelope_outer_inner_ts_mismatch', {
          outer: em.timestamp,
          inner: innerTs,
          messageId: em.messageId.slice(0, 8),
        });
        this.seenMessageIds.delete(em.messageId);
        return;
      }
    }

    const peerDid = didFromPubB64(peerPubKeyB64);
    if (!peerDid) {
      log.warn('inbound_bad_peer_pub');
      return;
    }
    const pairKey = dmPairKey(myDid, peerDid);
    const inbound = em.senderDid !== myDid;
    const ownerPid = await this.ownerProfileId();
    // v4.32.491: блок-лист спрашивается ОДИН раз и до всей диспетчеризации.
    // Раньше он стоял только перед «печатает…» и перед сохранением текста, а
    // всё служебное применялось к базе выше по коду: заблокированный человек
    // молчал на экране, но продолжал включать мне исчезающие сообщения,
    // ставить реакции, менять закреплённое, переписывать своё имя и фото в
    // моих контактах и класть сторис в мою ленту. Конверты, адресованные
    // группе, исключены намеренно — см. blockPolicy.
    if (inbound && !survivesBlock((payload as { text?: unknown }).text) && rateLimiter.isBlocked(peerPubKeyB64)) {
      log.info('dm_blocked_drop', { from: peerPubKeyB64.slice(0, 12), kind: payload.kind ?? 'text' });
      return;
    }
    // v4.32.120 #6: lan:/fallback: markers are not real IPFS CIDs — writing
    // them to conversation tip breaks syncDmHistoryFromProfile's DAG walk.
    // Tip is only meaningful for history sync; skip update when we lack a
    // real CID. The announceCid path will set the real tip when it arrives.
    // v4.32.432: форму даёт общий isPlainCid вместо списка запрещённых
    // префиксов — список пропускал и пустую строку, и любой другой
    // плейсхолдер. Та же проверка теперь стоит и внутри
    // setLocalConversationTip; здесь она осталась, чтобы не читать kv зря.
    const maybeSetTip = async (): Promise<void> => {
      if (isPlainCid(cid)) await setLocalConversationTip(pairKey, cid);
    };

    if (payload.kind === 'delete' && 'targetMessageId' in payload) {
      // v4.32.186 (Round-16 #1): a peer may only delete messages they
      // authored. Verify the target row was sent BY this peer (direction=in,
      // contactPubB64===sender) before deleting.
      const auth = await getChatMessageAuthor(payload.targetMessageId, ownerPid);
      if (!auth || auth.contactPubB64 !== peerPubKeyB64 || auth.direction !== 'in') {
        log.warn('delete_payload_rejected_authorship', { from: peerPubKeyB64.slice(0, 8) });
        return;
      }
      await deleteChatMessage(payload.targetMessageId, ownerPid);
      await maybeSetTip();
      await saveChatMessage({
        id: em.messageId,
        contactPubB64: peerPubKeyB64,
        cid,
        text: '\u200b',
        direction: inbound ? 'in' : 'out',
        status: 'delivered',
        mediaCids: null,
        createdAt: em.timestamp,
        ownerProfileId: ownerPid,
      });
      return;
    }

    if (payload.kind === 'edit' && 'targetMessageId' in payload && 'newText' in payload) {
      // v4.32.186 (Round-16 #2): edit authorship check.
      const auth = await getChatMessageAuthor(payload.targetMessageId, ownerPid);
      if (!auth || auth.contactPubB64 !== peerPubKeyB64 || auth.direction !== 'in') {
        log.warn('edit_payload_rejected_authorship', { from: peerPubKeyB64.slice(0, 8) });
        return;
      }
      if (typeof payload.newText !== 'string') return;
      // v4.32.239: правка шла в базу без вычистки префикса, хотя первичное
      // сохранение его снимает. То есть обойти защиту системных строк можно
      // было в два шага: прислать обычное сообщение, а следом правку на
      // '\x0bsys:Исчезающие сообщения включены'. В группах ту же дыру на
      // op='edit' уже закрыли (см. groupControlEnvelope).
      await updateChatMessageText(payload.targetMessageId, stripSpoofedSysPrefix(payload.newText), ownerPid);
      await maybeSetTip();
      return;
    }

    if (payload.kind === 'read_receipt' && 'messageIds' in payload && Array.isArray(payload.messageIds)) {
      // v4.32.186 (Round-16 #3): read receipt only applies to OUR outgoing
      // messages whose contactPubB64 matches the sender. Filter out any
      // ids that are inbound or belong to a different peer.
      // v4.32.507: список из конверта сперва приводится к потолку. Каждый
      // идентификатор стоит отдельного чтения из базы, и неограниченный
      // массив (тем более из повторов одной строки) вешал приёмный цикл.
      const ids = sanitizeReceiptIds(payload.messageIds);
      const dropped = receiptOverflowCount(payload.messageIds, ids.length);
      let applied = 0;
      for (const msgId of ids) {
        const auth = await getChatMessageAuthor(msgId, ownerPid);
        if (!auth || auth.contactPubB64 !== peerPubKeyB64 || auth.direction !== 'out') continue;
        await updateChatMessageStatus(msgId, 'read', ownerPid);
        applied++;
      }
      if (dropped > 0) log.warn('read_receipts_oversized_drop', { dropped, from: peerPubKeyB64.slice(0, 8) });
      log.info('read_receipts_applied', { count: applied, from: peerPubKeyB64.slice(0, 8) });
      return;
    }

    // v4.32.124 (AUDIT P0 #3): authenticated typing indicator. Ephemeral —
    // do not persist, do not update tip; just fan-out to UI listeners.
    if (payload.kind === 'typing') {
      // v4.32.226: record "last seen" on the LOCAL receive clock, not the
      // sender's em.timestamp. em.timestamp is the peer's clock (and is the
      // outer, unauthenticated, relay-rewritable field) — using it made
      // "был(а) в сети N мин назад" wrong whenever the two devices' clocks
      // differed, and let a peer/relay spoof the last-seen time. We just
      // received this frame, so the peer was active ~now by our own clock.
      // v4.32.485: под номером ВЛАДЕЛЬЦА переписки, а не работающей службы.
      recordPeerActivityFor(ownerPid, peerPubKeyB64);
      const cbs = this.typingListeners.get(peerPubKeyB64);
      if (cbs) cbs.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
      return;
    }

    const textPayload = payload as { kind?: 'text'; text: string; mediaCids?: string[]; replyToId?: string; replyToPreview?: string };

    // v4.32.227 (KB-2): group control envelopes must NEVER be persisted as plain
    // DM rows. Previously the routing here was inbound-only, so a self-echo of our
    // OWN outbound group send (em.senderDid === myDid ⇒ inbound=false) fell through
    // to saveChatMessage() below and stored the raw `\x02grp:{…}` JSON as an
    // outbound DM — leaking a member pubkey + local `file://` media path into a
    // «Контакт …» conversation. Now we short-circuit in BOTH directions: inbound
    // envelopes are routed to group storage, outbound ones are already persisted by
    // the group send path, so we simply drop them from the DM pipeline.
    // Group message envelope — route to group storage, skip DM storage
    if (textPayload.text?.startsWith('\x02grp:')) {
      if (inbound) await handleIncomingGroupEnvelope(textPayload.text, await this.groupRecipient(), peerPubKeyB64);
      return;
    }

    // Group read receipt — update seen_by on the message, skip DM storage
    if (textPayload.text?.startsWith(GROUP_READ_RECEIPT_PREFIX)) {
      if (inbound) await handleIncomingGroupReadReceipt(textPayload.text, await this.groupRecipient(), peerPubKeyB64);
      return;
    }

    // Group join request — store as pending join request for admin, skip DM storage
    if (textPayload.text?.startsWith(GROUP_JOIN_REQUEST_PREFIX)) {
      if (inbound) await handleIncomingGroupJoinRequest(textPayload.text, await this.groupRecipient(), peerPubKeyB64);
      return;
    }

    // v4.32.231: управляющий конверт группы (бан/кик/роль/мета) — применяем к
    // локальной БД и НЕ сохраняем как DM (иначе в чате «Контакт …» появился бы
    // сырой JSON с чужими публичными ключами).
    if (textPayload.text?.startsWith(GROUP_CTL_PREFIX)) {
      if (inbound) await handleIncomingGroupControl(textPayload.text, await this.groupRecipient(), peerPubKeyB64);
      return;
    }

    // v4.32.246: сторис контакта. Раньше ездила через IPFS pubsub, который на
    // телефоне выключен, — то есть не доезжала никогда. В переписке конверт не
    // показывается: это не сообщение, а обновление ленты сторис.
    if (textPayload.text?.startsWith(STORY_PREFIX)) {
      if (inbound) {
        const { handleIncomingStory } = await import('./storyService');
        await handleIncomingStory(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.232: реакция на сообщение — обновляет существующую строку, своего
    // пузыря в чате не создаёт.
    if (textPayload.text?.startsWith(REACTION_PREFIX)) {
      if (inbound) {
        const { handleIncomingReaction } = await import('./reactionSync');
        await handleIncomingReaction(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.250: голос в опросе — обновляет счётчики существующего опроса,
    // своего пузыря в чате не создаёт.
    if (textPayload.text?.startsWith(POLL_VOTE_PREFIX)) {
      if (inbound) {
        const { handleIncomingPollVote } = await import('./pollVoteSync');
        await handleIncomingPollVote(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.251: завершение опроса автором (или админом группы).
    if (textPayload.text?.startsWith(POLL_CLOSE_PREFIX)) {
      if (inbound) {
        const { handleIncomingPollClose } = await import('./pollVoteSync');
        await handleIncomingPollClose(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.235: закрепление в личке — меняет только баннер, своего пузыря в
    // чате не создаёт (иначе в переписке появился бы сырой JSON).
    if (textPayload.text?.startsWith(DM_PIN_PREFIX)) {
      if (inbound) {
        const { handleIncomingDmPin } = await import('./dmPinSync');
        await handleIncomingDmPin(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.237: таймер исчезающих сообщений. Сам конверт пузырём не
    // становится — вместо него в переписке появляется системная строка.
    if (textPayload.text?.startsWith(DISAPPEAR_PREFIX)) {
      if (inbound) {
        const { handleIncomingDisappear } = await import('./disappearSync');
        await handleIncomingDisappear(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.238: просьба «не показывай моё время входа». Пузыря не создаёт;
    // применяется к подписанному отправителю (см. presencePrefSync).
    if (textPayload.text?.startsWith(PRESENCE_PREF_PREFIX)) {
      if (inbound) {
        const { handleIncomingLastSeenPref } = await import('./presencePrefSync');
        await handleIncomingLastSeenPref(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.247: имя, фото и «О себе» собеседника. Раньше профиль уходил
    // только в IPFS, выключенный на телефоне, — контакт всегда оставался
    // кружком с буквой. В переписке конверт не показывается.
    if (textPayload.text?.startsWith(PROFILE_PREFIX)) {
      if (inbound) {
        const { handleIncomingPeerProfile } = await import('./profileSync');
        await handleIncomingPeerProfile(textPayload.text, peerPubKeyB64, ownerPid);
      }
      return;
    }

    // v4.32.568: номер строки живой геолокации — это номер сессии, а не номер
    // конверта (liveLocRowIdentity). Пока они были одним, эта ветка не
    // выполнялась НИ РАЗУ: проверка повторов выше отбрасывала конверт ровно
    // тогда, когда строка с таким номером уже была, — тем же запросом. Каждая
    // посылка заводила новый пузырь, и за восемь часов трансляции их
    // набиралось около девятисот шестидесяти, столько же непрочитанных и
    // столько же плашек внутри приложения.
    const rawText = textPayload.text ?? '';
    const liveNext = isLiveLocMessage(rawText) ? parseLiveLoc(rawText) : null;
    const rowId = chatRowIdForLiveLoc(liveNext?.liveId, em.messageId);
    if (inbound && liveNext) {
      // v4.32.239: обновление «на месте» шло по одному лишь совпадению id, без
      // проверки, чья это вообще строка. А id своих исходящих собеседник знает
      // — он же присылает по ним отметки о прочтении. Значит, конверт живой
      // геолокации с чужим id переписывал ЛЮБОЕ сообщение в базе, в том числе
      // моё собственное отправленное: в моей же переписке появлялся мой текст,
      // которого я не писал. Проверка та же, что у правки сообщения (Round-16):
      // строка обязана быть входящей и от этого же собеседника.
      const auth = await getChatMessageAuthor(rowId, ownerPid);
      if (auth) {
        if (auth.contactPubB64 !== peerPubKeyB64 || auth.direction !== 'in') {
          log.warn('liveloc_update_rejected_authorship', { from: peerPubKeyB64.slice(0, 8) });
          return;
        }
        // И заменять можно только живую геолокацию: иначе тот же конверт
        // молча подменял бы текст обычного сообщения, минуя правку.
        const prev = (await getChatMessageTexts([rowId], peerPubKeyB64, ownerPid)).get(rowId);
        // v4.32.575: своя копия строки не открылась — проверить, живая это
        // геолокация или обычное сообщение, нечем. Раньше нечитаемая копия
        // приходила пустой строкой: она не начинается с префикса, и конверт
        // отвергался — тем же ответом отвечаем и теперь, но осознанно и с
        // честной записью в журнале.
        if (prev === null) {
          log.warn('liveloc_update_rejected_unreadable', { from: peerPubKeyB64.slice(0, 8) });
          return;
        }
        if (prev != null && !prev.startsWith(LIVELOC_PREFIX)) {
          log.warn('liveloc_update_rejected_not_liveloc', { from: peerPubKeyB64.slice(0, 8) });
          return;
        }
        // v4.32.568: у каждой посылки свой номер конверта, поэтому защита от
        // повторов её больше не прикрывает. Придержанная и подсунутая позже
        // посылка отодвинула бы метку назад, к уже пройденному месту.
        const verdict = decideLiveLocUpdate(prev != null ? parseLiveLoc(prev) : null, liveNext);
        if (verdict.kind === 'skip') {
          log.warn('liveloc_update_skipped', { code: verdict.code, from: peerPubKeyB64.slice(0, 8) });
          return;
        }
        await updateChatMessageText(rowId, rawText, ownerPid);
        await maybeSetTip();
        return;
      }
    }
    // v4.32.282: цитата приходит от собеседника, и длину её до этой версии
    // никто не ограничивал — отправитель мог положить в неё что угодно любого
    // размера. v4.32.299: и не только длину — id вообще не проверялся на то,
    // строка ли это, а превью попадало в цитату как есть, вместе со служебным
    // конвертом и префиксом системной строки. Правила общие с группами
    // (social/replyRef): цитата в обоих случаях — чужой текст на экране.
    // v4.32.508: до этой версии длину текста в личке не ограничивал никто —
    // ни отправка, ни приём. Всё, что миновало разбор конвертов выше, это
    // обычное сообщение, и многомегабайтная строка от собеседника доезжала до
    // SQLite, до предпросмотра в списке чатов и до пузыря в переписке — то
    // есть до главного потока. Групповой путь такой же текст отбрасывал
    // (groupMessaging), поэтому здесь то же правило и тем же модулем.
    if (!withinMessageTextLimit(textPayload.text ?? '')) {
      log.warn('dm_text_oversized_drop', {
        len: typeof textPayload.text === 'string' ? textPayload.text.length : -1,
        from: peerPubKeyB64.slice(0, 8),
      });
      return;
    }
    // v4.32.508: список вложений приходил в строку базы как есть. В слот CID
    // можно положить `../` и увести загрузку картинки на чужой сервер — то
    // есть выдать IP получателя и время открытия чата; можно и просто прислать
    // десять тысяч элементов. Групповой приём чистит его с v4.32.244, личный
    // не чистил вовсе — правило то же (media/mediaCidPolicy).
    const incomingCids = sanitizeMediaCids(textPayload.mediaCids);
    const incomingReply = sanitizeReplyRef(textPayload.replyToId, textPayload.replyToPreview, em.messageId);
    const row: ChatMessageRow = {
      id: rowId,
      contactPubB64: peerPubKeyB64,
      cid,
      // v4.32.238: системную строку рисует приложение, поэтому собеседник не
      // вправе её прислать — иначе он показал бы поддельное уведомление
      // «Исчезающие сообщения включены» и т. п. (см. sysLineGuard).
      text: stripSpoofedSysPrefix(textPayload.text ?? ''),
      direction: inbound ? 'in' : 'out',
      status: inbound ? 'delivered' : 'sent',
      mediaCids: incomingCids.length ? serializeMediaCids(incomingCids) : null,
      createdAt: em.timestamp,
      ownerProfileId: ownerPid,
      replyToId: incomingReply.id,
      replyToPreview: incomingReply.preview,
    };
    // v4.32.477: одно и то же сообщение доезжает разными путями — по локальной
    // сети, через ретранслятор и следом за push-уведомлением. Строка в базе от
    // этого не двоится (INSERT OR IGNORE по id), а всё, что делалось после неё,
    // повторялось: счётчик непрочитанного рос на каждую копию, а плашка внутри
    // приложения показывалась столько раз, сколькими путями сообщение пришло.
    // Спрашиваем базу ДО записи: была ли уже такая строка.
    const alreadyStored = (await getChatMessageAuthor(rowId, ownerPid)) != null;
    await saveChatMessage(row);
    // v4.32.573: голос в опросе едет отдельным служебным конвертом и обгоняет
    // сам опрос. Такой голос ждал на полке — теперь опрос есть, и его можно
    // применить (см. pollVotePending).
    if (inbound && !alreadyStored && isPollMessage(row.text)) {
      void import('./pollVoteSync')
        .then(({ flushPendingPollVotes }) => flushPendingPollVotes(row.id, ownerPid))
        .catch((e) => log.warn('poll_vote_flush_failed', { err: e instanceof Error ? e.message : String(e) }));
    }
    await maybeSetTip();
    // v4.32.477: превью считается по сохранённому тексту, а не по сырому. Они
    // расходились ровно на подделку системной строки: в базу текст ложился без
    // префикса системной строки (см. sysLineGuard), а в превью тот же префикс
    // означал «это системная строка» — и собеседник показывал в списке чатов
    // строку от имени приложения.
    const previewText = previewLabelForText(row.text).slice(0, 120);
    if (!alreadyStored) {
      void touchConversation(peerPubKeyB64, ownerPid, previewText, inbound ? 'in' : 'out', inbound);
    }
    if (inbound) {
      // v4.32.226: last-seen on the LOCAL receive clock (see typing branch) —
      // not the sender's unauthenticated em.timestamp, which broke the
      // "был(а) в сети …" label under cross-device clock skew.
      recordPeerActivityFor(ownerPid, peerPubKeyB64);
      if (!alreadyStored) {
        log.info('dm_incoming_saved', { messageId: em.messageId, cid: cid.slice(0, 16) });
        emitInApp({
          peerPubB64: peerPubKeyB64,
          preview: previewText,
          cid,
          senderDid: em.senderDid,
        });
      }
    }
  }

  private async uploadMediaFromUri(uri: string, targetDid?: string): Promise<MediaUploadResult> {
    // v4.32.226: IPFS is kill-switched on mobile (addToIpfs → null), which
    // silently dropped EVERY image/file from outgoing DMs — the peer received
    // a text-only message. Fall back to the E2E-encrypted ntfy attachment
    // store (same path as voice). The descriptor is encoded as an `nb:`
    // pseudo-CID; it carries the DECRYPTION KEY, so it must only ever travel
    // inside the encrypted inner payload — sendMessageWork/retry strip nb:
    // entries from the plaintext outer envelope.
    // v4.32.358: сам выбор пути и чтение файла переехали в media/mediaUpload —
    // здесь оставалось седьмое повторение одного и того же, и с ним седьмое
    // чтение всего файла в память до всякой проверки размера.
    // v4.32.569: причина отказа (oversize или failed) едет к вызывающему.
    // Здесь она превращалась в null ещё до возврата, и личное сообщение
    // уходило собеседнику без единого вложения, ничего об этом не сказав.
    const { uploadMediaToCid } = await import('../media/mediaUpload');
    return uploadMediaToCid(uri, { targetDid });
  }

  /**
   * Свой ли это ключ — то есть «Сохранённые сообщения» (v4.32.560).
   *
   * Сравниваем не строки, а did: один и тот же ключ приходит на вход в разной
   * записи (с дополняющими знаками и без, из QR и из базы), и сравнение строк
   * отвечало бы «разные» на один и тот же ключ. Ровно так же отличает себя от
   * собеседника весь остальной модуль (`peerDid === myDid`).
   */
  private isMyOwnKey(contactPubB64: string): boolean {
    const peerDid = didFromPubB64(contactPubB64);
    return !!peerDid && peerDid === publicKeyToDidKey(this.pair.publicKey);
  }

  /**
   * Записать сообщение в свою же переписку — без сети (v4.32.560).
   *
   * «Заметки для себя» — переписка без собеседника: договариваться о ключе не
   * с кем, отправлять некому. Экран переписки знал это про текст, голос и GIF
   * и сохранял их сам, а всё остальное — снимок, документ, точку на карте,
   * визитку, опрос, пересылку — отдавал обычной отправке. Та искала общий ключ
   * с «собеседником», не находила (своей строки в контактах нет с v4.32.31) и
   * показывала «Нет защищённого канала с этим контактом. Добавьте его заново
   * по QR-коду». Совет неисполним: себя по QR не добавить.
   *
   * Всплывало это и просто при входе в «Избранное»: открытие переписки шлёт
   * собеседнику свой профиль и решение о времени последнего входа, и оба
   * конверта упирались в тот же отказ.
   *
   * Поэтому своя переписка обрабатывается здесь целиком: строка ложится в базу
   * доставленной, вложения проходят обычную загрузку (иначе их нечем будет
   * показать — локальный путь в списке вложений не рисуется), а конверт,
   * шифрование и транспорт не участвуют вовсе.
   */
  private async saveToSelfChat(
    contactPubB64: string,
    text: string,
    mediaUris?: string[],
    replyToId?: string,
    replyToPreview?: string
  ): Promise<string | null> {
    // Служебный конверт сам себе не нужен: профиль, отметка о прочтении,
    // реакция, закрепление — всё это рассказывают собеседнику, а он тут я.
    // Живую геолокацию ведёт экран (см. callerOwnsRow в sendMessageWork).
    if (isControlOnlyText(text) || isLiveLocMessage(text)) {
      log.debug('dm_self_envelope_skipped');
      return null;
    }
    const ownerPid = await this.ownerProfileId();
    const myDid = publicKeyToDidKey(this.pair.publicKey);
    const mediaCids: string[] = [];
    if (mediaUris?.length) {
      const DM_MEDIA_CONCURRENCY = 3;
      const results = await runWithConcurrency(
        mediaUris,
        DM_MEDIA_CONCURRENCY,
        (uri) => this.uploadMediaFromUri(uri, myDid),
      );
      for (const r of results) {
        if (r.ok) mediaCids.push(r.cid);
      }
      const verdict = decideMediaSend(tallyMediaUploads(results));
      if (verdict.kind === 'abort') {
        log.warn('dm_self_media_all_failed', { total: mediaUris.length });
        // Исключение, а не null: экран по нему вернёт подпись в поле ввода и
        // уберёт предварительный пузырь.
        throw new Error(verdict.text);
      }
      if (verdict.warn) {
        log.warn('dm_self_media_partial', { sent: mediaCids.length, total: mediaUris.length });
        void ErrorHandler.getInstance().handle({
          code: 'MEDIA_PARTIAL',
          message: verdict.warn,
          severity: ErrorSeverity.WARNING,
          retryable: false,
        });
      }
    }
    const ts = Date.now();
    const messageId = uuidv4();
    await upsertChatMessage({
      id: messageId,
      contactPubB64,
      // Тот же вид ссылки, что у заметок, сохранённых экраном переписки:
      // строка никуда не отправлялась, и настоящего CID у неё нет.
      cid: `local:${ts}`,
      text,
      direction: 'out',
      status: 'delivered',
      mediaCids: mediaCids.length ? JSON.stringify(mediaCids) : null,
      createdAt: ts,
      ownerProfileId: ownerPid,
      replyToId: replyToId ?? null,
      replyToPreview: truncateReplyPreview(replyToPreview),
    });
    void touchConversation(contactPubB64, ownerPid, previewLabelForText(text).slice(0, 120), 'out', false);
    return messageId;
  }

  async sendMessage(
    contactPubB64: string,
    text: string,
    mediaUris?: string[],
    replyToId?: string,
    replyToPreview?: string
  ): Promise<string | null> {
    // v4.32.560: своя переписка не проходит ни одной проверки ниже — себя не
    // блокируют, себе не считают часовой лимит и с собой не договариваются о
    // ключе. См. saveToSelfChat.
    if (this.isMyOwnKey(contactPubB64)) {
      return this.saveToSelfChat(contactPubB64, text, mediaUris, replyToId, replyToPreview);
    }
    // v4.32.318: блок-лист поднят с диска — иначе на первых секундах после
    // запуска обе проверки ниже отвечали бы «не заблокирован» кому угодно.
    await rateLimiter.whenReady();
    // v4.32.318: отказ по блокировке и отказ по лимиту — разные вещи, а
    // человеку показывался один и тот же текст про «слишком много сообщений в
    // час». Заблокировавший ждал, пока «лимит» пройдёт, и пробовал снова.
    if (rateLimiter.isBlocked(contactPubB64)) {
      log.info('dm_send_blocked', { to: contactPubB64.slice(0, 12) });
      void ErrorHandler.getInstance().handle({
        code: 'BLOCKED_CONTACT',
        message: 'Контакт заблокирован. Снимите блокировку, чтобы написать.',
        severity: ErrorSeverity.ERROR,
        retryable: false,
      });
      return null;
    }
    // v4.32.329: служебный конверт (реакция, галочка о прочтении, голос в
    // опросе, рассылка группы) тратит свой запас, а не полусотню человеческих
    // сообщений в час. Разделять их по тексту, а не по новому аргументу,
    // потому что isControlOnlyText — уже существующий и единственный ответ на
    // вопрос «эта строка вообще показывается в переписке».
    if (isControlOnlyText(text)) {
      if (!rateLimiter.canSendControl(contactPubB64)) {
        // Без ErrorHandler: человек этого конверта не отправлял и баннер
        // «слишком много сообщений» ему ни о чём не скажет.
        log.warn('dm_send_control_rate_limited', { to: contactPubB64.slice(0, 12) });
        return null;
      }
    } else if (!rateLimiter.canSendMessage(contactPubB64)) {
      // v4.32.318: без ключа контакта в context — оттуда он уходит в Sentry
      // (ErrorHandler кладёт context в extra), а двенадцати символов чужого
      // публичного ключа хватает, чтобы связать отчёт с конкретным человеком.
      // На устройстве он остаётся, строкой выше.
      log.info('dm_send_rate_limited', { to: contactPubB64.slice(0, 12) });
      void ErrorHandler.getInstance().handle({
        code: 'RATE_LIMIT_DM',
        message: 'Слишком много сообщений этому контакту (лимит в час). Попробуйте позже.',
        severity: ErrorSeverity.ERROR,
        retryable: false,
      });
      return null;
    }
    const t0 = Date.now();
    return new Promise<string | null>((resolve, reject) => {
      setTimeout(() => {
        void (async () => {
          try {
            const cid = await this.sendMessageWork(contactPubB64, text, mediaUris, replyToId, replyToPreview);
            const ms = Date.now() - t0;
            if (ms > 3000) {
              log.info('perf_slow', { op: 'sendMessage', ms });
            }
            resolve(cid);
          } catch (e) {
            reject(e);
          }
        })();
      }, 0);
    });
  }

  private async sendMessageWork(
    contactPubB64: string,
    text: string,
    mediaUris?: string[],
    replyToId?: string,
    replyToPreview?: string
  ): Promise<string | null> {
    await requireOnlineWrite(await localPathTo(contactPubB64));
    await measureAsync('dm_startListening', () => this.startListening());
    // v4.32.464: номер профиля берётся один раз в начале работы и дальше
    // передаётся во всё, что пишет и читает по профилю. Спрашивать его заново
    // после каждого await значило бы спрашивать, какой экран открыт сейчас, —
    // а отправка принадлежит паре ключей, с которой служба создана.
    const ownerPid = await this.ownerProfileId();
    let sym = await measureAsync('dm_getSymmetricKey', () => getSymmetricKeyForPeer(ownerPid, contactPubB64));
    if (!sym) {
      // v4.32.113 T1 (Telegram-style): pubkey получателя известен (из QR/deep-link/вставки),
      // но контакта нет. Автоматически создаём implicit-row через ECDH — sym-key детерминирован.
      // Если валидный pubkey (32 байта) — derive и продолжаем; иначе реально сдаёмся.
      try {
        const peerPkBytes = publicKeyFromB64(contactPubB64);
        if (peerPkBytes) {
          const created = await ensureImplicitContact(ownerPid, this.pair, peerPkBytes);
          if (created) {
            // Переподписаться на pubsub-топик новоиспечённого контакта, иначе мы не услышим
            // его ответ, пока не перезагрузим приложение.
            await measureAsync('dm_refresh_subs_after_implicit', () => this.refreshSubscriptions());
          }
          sym = await getSymmetricKeyForPeer(ownerPid, contactPubB64);
        }
      } catch (e) {
        log.warn('dm_implicit_contact_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      if (!sym) {
        // v4.32.336: до сих пор этот отказ был совершенно немым — только строка
        // в логе. А это конец пути: ключ шифрования для собеседника получить не
        // удалось, значит сообщение не будет ни зашифровано, ни сохранено, ни
        // отправлено. Экраны, показывавшие «Отправлено» и «Переслано», делали
        // это в том числе здесь. Два соседних отказа — блокировка и часовой
        // лимит — свой ErrorHandler имеют с самого начала; этот выпал.
        //
        // Ключ собеседника в сообщение не кладём: ErrorHandler отправляет его в
        // Sentry, а по чужому публичному ключу отчёт связывается с человеком.
        log.warn('dm_no_session');
        void ErrorHandler.getInstance().handle({
          code: 'NO_SESSION_DM',
          message: 'Нет защищённого канала с этим контактом. Добавьте его заново по QR-коду или ссылке.',
          severity: ErrorSeverity.ERROR,
          retryable: false,
        });
        return null;
      }
    }
    const peerDid = didFromPubB64(contactPubB64);
    if (!peerDid) return null;
    const myDid = publicKeyToDidKey(this.pair.publicKey);
    const pairKey = dmPairKey(myDid, peerDid);
    const tips = await measureAsync('dm_conversation_tips', () => getLocalConversationTips());
    const previousMessageCid = tips[pairKey];

    const messageId = uuidv4();
    const mediaCids: string[] = [];
    if (mediaUris?.length) {
      // Параллельная загрузка медиафайлов с лимитом конкурентности.
      // Было: for...of с await — N файлов × время загрузки = полная блокировка.
      // Стало: до 3 параллельных загрузок — быстрее и не перегружает сеть/диск.
      const DM_MEDIA_CONCURRENCY = 3;
      const results = await runWithConcurrency(
        mediaUris,
        DM_MEDIA_CONCURRENCY,
        (uri) => measureAsync('dm_media_upload', () => this.uploadMediaFromUri(uri, peerDid)),
      );
      for (const r of results) {
        if (r.ok) mediaCids.push(r.cid);
      }
      // v4.32.569: длина списка ссылок ни разу не сравнивалась с числом
      // выбранных файлов. Не загрузилось ни одной фотографии — сообщение
      // всё равно уходило, пузырь с подписью появлялся, и человек был
      // уверен, что отправил снимок. Собеседник не получал ничего.
      const verdict = decideMediaSend(tallyMediaUploads(results));
      if (verdict.kind === 'abort') {
        log.warn('dm_media_all_failed', { total: mediaUris.length, to: peerDid.slice(0, 16) });
        // Именно исключение, а не null: экран переписки по нему возвращает
        // подпись в поле ввода и убирает предварительный пузырь. Тихий null
        // оставил бы пузырь висеть, а подпись — пропасть.
        throw new Error(verdict.text);
      }
      if (verdict.warn) {
        log.warn('dm_media_partial', {
          sent: mediaCids.length,
          total: mediaUris.length,
          to: peerDid.slice(0, 16),
        });
        void ErrorHandler.getInstance().handle({
          code: 'MEDIA_PARTIAL',
          message: verdict.warn,
          severity: ErrorSeverity.WARNING,
          retryable: false,
        });
      }
    }
    // v4.32.214 (Audit-43 C1): embed authenticated _ts INSIDE plaintext so
    // the outer em.timestamp cannot be tampered to bypass replay window.
    const ts = Date.now();
    const inner = new TextEncoder().encode(JSON.stringify({ text, mediaCids, replyToId, replyToPreview, _ts: ts }));
    const encryptedContent = measureSync('dm_encrypt', () => encryptSymmetric(sym, inner));
    // v4.32.226: nb: blob refs embed the media decryption key — they may ONLY
    // travel inside encryptedContent. The outer envelope is plaintext to the
    // relay, so strip them here (plain IPFS cids may stay for store sizing).
    const outerMediaCids = mediaCids.filter((c) => !isNbCid(c));
    const em: EncryptedMessage = {
      messageId,
      senderDid: myDid,
      recipientDid: peerDid,
      encryptedContent,
      timestamp: ts,
      previousMessageCid,
      mediaCids: outerMediaCids.length ? outerMediaCids : undefined,
      replyTo: replyToId,
    };
    const pending: ChatMessageRow = {
      id: messageId,
      contactPubB64,
      cid: null,
      text,
      direction: 'out',
      status: 'sending',
      mediaCids: mediaCids.length ? JSON.stringify(mediaCids) : null,
      createdAt: ts,
      ownerProfileId: ownerPid,
      replyToId: replyToId ?? null,
      replyToPreview: truncateReplyPreview(replyToPreview),
    };
    // v4.32.247: управляющий конверт — не сообщение. Реакция, закрепление,
    // таймер, управление группой, сторис, профиль уходят тем же sendMessage,
    // и до этой версии каждый из них оседал в chat_messages исходящей строкой:
    // в переписке появлялся пузырь с сырым JSON (внутри — чужие публичные
    // ключи и пути к файлам), а в списке диалогов последняя реплика
    // подменялась на «Системное сообщение». Приём такие конверты отбрасывал
    // давно (см. handleDecrypted), отправка — нет.
    const control = isControlOnlyText(text);
    // v4.32.568: строку живой геолокации ведёт экран переписки — она одна на
    // всю сессию и лежит под её номером (payload.liveId), с временем начала
    // сессии. Отправка сохраняла ВТОРУЮ, под номером конверта, и делала это
    // каждые полминуты: одна сессия оставляла у отправителя в его же
    // переписке около девятисот шестидесяти пузырей с сырым конвертом.
    // Записать поверх нельзя — upsert затёр бы время начала сессии временем
    // такта, и пузырь прыгал бы в конец списка каждые полминуты.
    const callerOwnsRow = isLiveLocMessage(text);
    const saveRow = async (row: ChatMessageRow): Promise<void> => {
      if (!control && !callerOwnsRow) await upsertChatMessage(row);
    };
    const touchConv = (): void => {
      if (!control) {
        void touchConversation(contactPubB64, ownerPid, previewLabelForText(text).slice(0, 120), 'out', false);
      }
    };
    await measureAsync('dm_db_upsert_pending', () => saveRow(pending));

    const cid = await measureAsync('dm_ipfs_publish', () => publishMessageWithRetry(this.store, em));
    if (!cid) {
      log.warn('dm_ipfs_publish_failed_trying_fallback', { messageId, peerDid });
      const payload = serializeEnvelopeToBytes(em);
      // v4.32.118 Stage 2: ALSO publish to recipient's self-inbox as a
      // parallel WAN fallback — LAN/WebRTC may not be reachable but pubsub
      // via any connected IPFS peer can still bridge to them.
      // v4.32.119: skip self-echo for Saved Messages.
      if (peerDid !== myDid) {
        void this.store.publishToSelfInbox(peerDid, payload).catch((e) => {
          log.warn('self_inbox_fallback_publish_failed', { err: e instanceof Error ? e.message : String(e) });
        });
      }
      // v4.32.207 (Bridge Stage 1): gossip fan-out to contacts bridges the
      // sender/recipient topology gap when a mutual contact straddles them.
      // v4.32.213 (Audit-42 H3): try direct multiTransport FIRST, then fall
      // back to gossip fan-out only if direct failed — avoids 64× amplification
      // on every DM when direct LAN/WebRTC already reaches the recipient.
      const fallbackOk = await multiTransportRouter.send(payload, peerDid);
      if (!fallbackOk) {
        void this.gossipDmToContacts(payload, peerDid, myDid);
      }
      if (fallbackOk) {
        log.info('message_sent_via_fallback', { peerDid, messageId });
        const fallbackRef = `fallback:${messageId}`;
        await saveRow({
          ...pending,
          cid: fallbackRef,
          status: 'delivered',
        });
        // v4.32.128 (AUDIT): NEVER write fallback:/lan: refs to conversation
        // tip. Receive-side has been guarded since v120 (#6) — send-side was
        // still writing the placeholder, which broke syncDmHistoryFromProfile's
        // DAG walk: subsequent outgoing messages would link
        // previousMessageCid="fallback:<uuid>" and history sync would stall at
        // the phantom tip. Tip stays on the last real CID; when outbox later
        // drains via IPFS and `announceCid` fires, that path will update tip
        // properly. Consistent with receive-side isPlainCid guard.
        touchConv();
        void republishProfileFromKv(this.pair);
        return fallbackRef;
      }
      log.info('dm_send_no_online_route', { peerDid, messageId });
      await saveRow({ ...pending, status: 'failed' });
      touchConv();
      return null;
    }

    await saveRow({
      ...pending,
      cid,
      status: 'sent',
    });
    await this.store.announceCid(myDid, peerDid, cid);
    // v4.32.118 Stage 2: also publish the wire envelope to recipient's
    // self-inbox so strangers (not yet in our contacts, and not yet with
    // us in their contacts) still receive it. Recipient's
    // `subscribeToSelfInbox` will dispatch through `receiveDirectLanEnvelope`
    // which creates an implicit contact from senderDid. Fire-and-forget:
    // shared-topic delivery above is the primary path; this is the T1
    // fallback for cold peers. Wire payload is already ECDH-encrypted.
    // v4.32.119: skip self-echo for Saved Messages (peerDid === myDid).
    if (peerDid !== myDid) {
      try {
        const wire = serializeEnvelopeToBytes(em);
        void this.store.publishToSelfInbox(peerDid, wire).catch((e) => {
          log.warn('self_inbox_publish_failed', { err: e instanceof Error ? e.message : String(e) });
        });
        // v4.32.212 (Audit-41 #5 CRITICAL): IPFS-success path was only
        // announcing CID on the `airchat-dm-A-B` pubsub topic. If the
        // recipient has no internet (LAN-only / Wi-Fi без интернета), they
        // never subscribe to that topic and the DM never arrives.
        // v4.32.213 (Audit-42 H3): only fall back to contact gossip fan-out
        // when the direct multiTransportRouter send failed. Previously we
        // fired both unconditionally, so every DM to an online contact cost
        // 64 extra gossip sends even when LAN/WebRTC already delivered.
        void (async () => {
          try {
            const ok = await multiTransportRouter.send(wire, peerDid);
            if (!ok) {
              await this.gossipDmToContacts(wire, peerDid, myDid);
            }
          } catch {
            try { await this.gossipDmToContacts(wire, peerDid, myDid); } catch { /* ignore */ }
          }
        })();
      } catch (e) {
        log.warn('self_inbox_publish_wire_failed', { err: e instanceof Error ? e.message : String(e) });
      }
    }
    await saveRow({
      ...pending,
      cid,
      status: 'delivered',
    });
    await setLocalConversationTip(pairKey, cid);
    touchConv();
    void republishProfileFromKv(this.pair);
    // v4.32.248: служебный конверт собеседника не будит — см. isSilentEnvelope.
    // Сообщения группы, приглашения и заявки на вступление push сохраняют:
    // за ними стоит событие, ради которого приложение и открывают.
    if (!isSilentEnvelope(text)) {
      // v4.32.572: получателю при закрытом приложении неоткуда узнать, что
      // это сообщение в группе, — конверт тот же, что у личной переписки.
      // Один бит вида решает, какой выключатель уведомлений спрашивать.
      const pushKind = classifyPushKind(text);
      void import('../../notifications/pushNotifications').then(({ pushNotificationService }) => {
        void pushNotificationService.sendPushToContact(peerDid, cid, myDid, pushKind);
      });
    }
    return cid;
  }

  /**
   * v4.32.431: служебный конверт (удаление/правка) доводится до собеседника
   * той же лестницей, что и обычное сообщение — см. `sendMessageWork`.
   *
   * Раньше здесь стояла одна ступень из четырёх: `publishMessageWithRetry` и
   * `if (!cid) return null`. На Android и iOS IPFS выключен насовсем
   * (`isIpfsEnabled` → false), то есть первая ступень там не «редко не
   * срабатывает», а не срабатывает никогда — и обе операции не уходили вообще
   * никуда, ни разу, ни при какой связи.
   *
   * Возвращает ссылку, под которой конверт ушёл, или null, если ни один
   * транспорт не подтвердил отправку. `fallback:` в конец диалога не пишем по
   * тому же правилу, что и на отправке сообщения (v4.32.128): по
   * ненастоящему CID обход истории останавливается.
   */
  private async deliverControlEnvelope(
    em: EncryptedMessage,
    peerDid: string,
    myDid: string,
    pairKey: string
  ): Promise<string | null> {
    const cid = await publishMessageWithRetry(this.store, em);
    if (cid) {
      await this.store.announceCid(myDid, peerDid, cid);
      await setLocalConversationTip(pairKey, cid);
      return cid;
    }
    const payload = serializeEnvelopeToBytes(em);
    if (peerDid !== myDid) {
      void this.store.publishToSelfInbox(peerDid, payload).catch((e) => {
        log.warn('ctl_self_inbox_publish_failed', { err: e instanceof Error ? e.message : String(e) });
      });
    }
    const fallbackOk = await multiTransportRouter.send(payload, peerDid);
    if (fallbackOk) {
      log.info('ctl_sent_via_fallback', { peerDid, messageId: em.messageId });
      return `fallback:${em.messageId}`;
    }
    void this.gossipDmToContacts(payload, peerDid, myDid);
    return null;
  }

  /** Собрать запечатанный служебный конверт. Общий кусок удаления и правки. */
  private async buildControlEnvelope(
    contactPubB64: string,
    inner: Record<string, unknown>
  ): Promise<{ em: EncryptedMessage; peerDid: string; myDid: string; pairKey: string } | null> {
    const sym = await getSymmetricKeyForPeer(await this.ownerProfileId(), contactPubB64);
    if (!sym) return null;
    const peerDid = didFromPubB64(contactPubB64);
    if (!peerDid) return null;
    const myDid = publicKeyToDidKey(this.pair.publicKey);
    const pairKey = dmPairKey(myDid, peerDid);
    const tips = await getLocalConversationTips();
    // v4.32.214 (Audit-43 C1): authenticated _ts inside AEAD ciphertext.
    const ts = Date.now();
    const bytes = new TextEncoder().encode(JSON.stringify({ ...inner, _ts: ts }));
    return {
      em: {
        messageId: uuidv4(),
        senderDid: myDid,
        recipientDid: peerDid,
        encryptedContent: encryptSymmetric(sym, bytes),
        timestamp: ts,
        previousMessageCid: tips[pairKey],
      },
      peerDid,
      myDid,
      pairKey,
    };
  }

  /**
   * Publish encrypted delete tombstone (peer removes target locally when received).
   *
   * v4.32.431: удаление у себя идёт первым и происходит всегда. Раньше оно
   * стояло последней строкой, после `if (!cid) return null`, поэтому на
   * телефоне «Удалить у всех» не удаляло сообщение даже у самого человека:
   * меню закрывалось, список перерисовывался, сообщение оставалось на месте.
   */
  async sendDeleteTombstone(contactPubB64: string, targetMessageId: string): Promise<TwoSidedOutcome> {
    await this.startListening();
    const ownerPid = await this.ownerProfileId();
    // Половина у себя — первой и без оглядки на сеть: своя строка в своей базе.
    const localDone = await deleteChatMessage(targetMessageId, ownerPid);
    const online = await checkOnlineWrite(await localPathTo(contactPubB64));
    if (!shouldTryPeerHalf(localDone, online.ok)) {
      log.info('ctl_delete_peer_half_skipped', {
        localDone,
        reachability: online.reachability,
      });
      return combineHalves(localDone, 'unreachable');
    }

    const built = await this.buildControlEnvelope(contactPubB64, { kind: 'delete', targetMessageId });
    if (!built) {
      log.warn('ctl_delete_no_channel', { targetMessageId });
      return combineHalves(localDone, 'unreachable');
    }
    const ref = await this.deliverControlEnvelope(built.em, built.peerDid, built.myDid, built.pairKey);
    if (ref) {
      void republishProfileFromKv(this.pair);
      return combineHalves(localDone, 'sent');
    }
    return combineHalves(localDone, 'unreachable');
  }

  async deleteMessageLocalOnly(messageId: string): Promise<void> {
    await deleteChatMessage(messageId, await this.ownerProfileId());
  }

  /** Удалить сообщение только в локальной SQLite (синоним для UI). */
  deleteMessageLocally(messageId: string): Promise<void> {
    return this.deleteMessageLocalOnly(messageId);
  }

  /** Удалить у всех: удаление у себя + tombstone в сеть (см. `sendDeleteTombstone`). */
  deleteMessageForEveryone(contactPubB64: string, messageId: string): Promise<TwoSidedOutcome> {
    return this.sendDeleteTombstone(contactPubB64, messageId);
  }

  /**
   * Редактировать сообщение: обновить локально + отправить edit-tombstone собеседнику.
   *
   * v4.32.431: правка перестала теряться в пути. У себя текст менялся, до
   * собеседника не доходил ничего, и признака расхождения не было ни у кого:
   * человек, убравший из отправленного сообщения адрес или сумму, видел у себя
   * исправленный текст, а у собеседника оставался исходный.
   */
  async editMessage(contactPubB64: string, messageId: string, newText: string): Promise<TwoSidedOutcome> {
    const ownerPid = await this.ownerProfileId();
    // Тот же порядок, что и в удалении: своя строка правится всегда.
    const localDone = await updateChatMessageText(messageId, newText, ownerPid);
    const online = await checkOnlineWrite(await localPathTo(contactPubB64));
    if (!shouldTryPeerHalf(localDone, online.ok)) {
      log.info('ctl_edit_peer_half_skipped', {
        localDone,
        reachability: online.reachability,
      });
      return combineHalves(localDone, 'unreachable');
    }

    const built = await this.buildControlEnvelope(contactPubB64, {
      kind: 'edit',
      targetMessageId: messageId,
      newText,
    });
    if (!built) {
      log.warn('ctl_edit_no_channel', { messageId });
      return combineHalves(localDone, 'unreachable');
    }
    const ref = await this.deliverControlEnvelope(built.em, built.peerDid, built.myDid, built.pairKey);
    return combineHalves(localDone, ref ? 'sent' : 'unreachable');
  }

  /**
   * Повторная попытка из очереди. Конверт собирается заново: он привязан к
   * моменту отправки, и пролежавший сутки ушёл бы с меткой суточной давности.
   * Локальную часть здесь не повторяем — она сделана при первой попытке.
   */
  async retrySendCtl(p: CtlRetryPayload): Promise<boolean> {
    await this.startListening();
    const inner: Record<string, unknown> =
      p.op === 'delete'
        ? { kind: 'delete', targetMessageId: p.targetMessageId }
        : { kind: 'edit', targetMessageId: p.targetMessageId, newText: p.newText };
    const built = await this.buildControlEnvelope(p.contactPubB64, inner);
    if (!built) {
      // Канала к этому собеседнику нет и не появится — повторять нечего.
      log.warn('ctl_retry_no_channel', { op: p.op, targetMessageId: p.targetMessageId });
      return true;
    }
    const ref = await this.deliverControlEnvelope(built.em, built.peerDid, built.myDid, built.pairKey);
    return ref !== null;
  }

  async retrySendDm(payload: DmRetryPayload): Promise<boolean> {
    const ownerPid = await this.ownerProfileId();
    const sym = await getSymmetricKeyForPeer(await this.ownerProfileId(), payload.contactPubB64);
    if (!sym) {
      // v4.32.20: НЕ re-enqueue. retrySendDm вызывается из sync.ts для уже
      // лежащего в outbox item'а — возврат `false` оставляет его там для следующей
      // попытки. Раньше enqueue здесь создавал дубликат → очередь росла
      // экспоненциально (каждые 6с через OfflineStatus).
      return false;
    }
    const peerDid = didFromPubB64(payload.contactPubB64);
    if (!peerDid) return false;
    const myDid = publicKeyToDidKey(this.pair.publicKey);
    // v4.32.214 (Audit-43 C1): authenticated _ts inside AEAD ciphertext.
    // Use original payload.ts so retry produces byte-identical replay-safe inner.
    // v4.32.357: replyToId/replyToPreview идут тем же путём, что и при первой
    // отправке. Их тут не было вовсе: ответ, ушедший через очередь (то есть
    // почти любой ответ, отправленный без сети), доезжал до собеседника
    // обычным сообщением, а в своей же переписке терял привязку к цитируемому,
    // потому что upsert ниже перезаписывал строку без этих полей.
    const inner = new TextEncoder().encode(
      JSON.stringify({
        text: payload.text,
        mediaCids: payload.mediaCids,
        replyToId: payload.replyToId,
        replyToPreview: payload.replyToPreview,
        _ts: payload.ts,
      })
    );
    const encryptedContent = encryptSymmetric(sym, inner);
    // v4.32.226: strip nb: blob refs (carry decryption keys) from the
    // plaintext outer envelope — same rule as sendMessageWork.
    const outerRetryCids = payload.mediaCids.filter((c) => !isNbCid(c));
    const em: EncryptedMessage = {
      messageId: payload.messageId,
      senderDid: myDid,
      recipientDid: peerDid,
      encryptedContent,
      timestamp: payload.ts,
      previousMessageCid: payload.previousMessageCid,
      mediaCids: outerRetryCids.length ? outerRetryCids : undefined,
      replyTo: payload.replyToId,
    };
    const cid = await publishMessageWithRetry(this.store, em);
    if (!cid) {
      log.warn('dm_retry_ipfs_failed_trying_fallback', { messageId: payload.messageId, peerDid });
      const wire = serializeEnvelopeToBytes(em);
      const ok = await multiTransportRouter.send(wire, peerDid);
      if (ok) {
        log.info('message_sent_via_fallback', { peerDid, messageId: payload.messageId });
        const fallbackRef = `fallback:${payload.messageId}`;
        // v4.32.247: тот же запрет, что и в sendMessageWork, — управляющий
        // конверт не должен всплыть строкой в переписке при повторной отправке
        // из очереди.
        if (!isControlOnlyText(payload.text)) {
          await upsertChatMessage({
            id: payload.messageId,
            contactPubB64: payload.contactPubB64,
            cid: fallbackRef,
            text: payload.text,
            direction: 'out',
            status: 'delivered',
            mediaCids: payload.mediaCids.length ? JSON.stringify(payload.mediaCids) : null,
            createdAt: payload.ts,
            ownerProfileId: ownerPid,
            replyToId: payload.replyToId ?? null,
            replyToPreview: payload.replyToPreview ?? null,
          });
          void touchConversation(payload.contactPubB64, ownerPid, previewLabelForText(payload.text).slice(0, 120), 'out', false);
        }
        // v4.32.432: хвост переписки НЕ трогаем — тот же запрет, что в
        // sendMessageWork. Здесь он был написан словами двумя строками выше и
        // нарушен строкой ниже: в хвост уезжал `fallback:<uuid>`.
        void republishProfileFromKv(this.pair);
        return true;
      }
      // v4.32.20: НЕ re-enqueue — sync.ts уже держит item. См. комментарий выше.
      return false;
    }
    const pairKey = dmPairKey(myDid, peerDid);
    if (!isControlOnlyText(payload.text)) {
      await upsertChatMessage({
        id: payload.messageId,
        contactPubB64: payload.contactPubB64,
        cid,
        text: payload.text,
        direction: 'out',
        status: 'delivered',
        mediaCids: payload.mediaCids.length ? JSON.stringify(payload.mediaCids) : null,
        createdAt: payload.ts,
        ownerProfileId: ownerPid,
        replyToId: payload.replyToId ?? null,
        replyToPreview: payload.replyToPreview ?? null,
      });
      void touchConversation(payload.contactPubB64, ownerPid, previewLabelForText(payload.text).slice(0, 120), 'out', false);
    }
    await this.store.announceCid(myDid, peerDid, cid);
    await setLocalConversationTip(pairKey, cid);
    void republishProfileFromKv(this.pair);
    return true;
  }

  async sendReadReceipt(contactPubB64: string, messageId: string | string[]): Promise<void> {
    // v4.32.124 (AUDIT P0 #2): route through encrypted envelope (single batch)
    // instead of per-id unauth pubsub lines.
    // v4.32.171: не сливаем read-receipt заблокированному контакту — иначе
    // пир видит, что жертва всё ещё читает его сообщения.
    // v4.32.318: сперва дождаться списка. Отметки о прочтении уходят как раз
    // при открытии переписки, а её открывают в том числе сразу после запуска —
    // то есть ровно тогда, когда список ещё читается с диска.
    await rateLimiter.whenReady();
    if (rateLimiter.isBlocked(contactPubB64)) return;
    // v4.32.312: переключатель «не отправлять отметки о прочтении» спрашивали
    // три раза на экране переписки — по копии значения, прочитанной один раз при
    // открытии. Копия успевала устареть (настройки открываются ПОВЕРХ переписки,
    // и та не размонтируется), а с v4.32.311 читалась вовсе не оттуда, откуда
    // пишется. Решение теперь здесь же, где и проверка блок-листа выше: отсюда
    // его нельзя забыть, и оно всегда свежее.
    if (!(await readReceiptsAllowedFor(await this.ownerProfileId()))) return;
    // v4.32.507: тот же потолок, что и на приёме. Класть в конверт больше,
    // чем получатель разберёт, значит молча терять отметки на его стороне.
    const ids = sanitizeReceiptIds(Array.isArray(messageId) ? messageId : [messageId]);
    if (!ids.length) return;
    await this.sendEncryptedControl(contactPubB64, { kind: 'read_receipt', messageIds: ids });
  }

  async getMessages(contactPubB64: string, limit = 100, offset = 0): Promise<ChatMessageRow[]> {
    // v4.32.227 (PERF #34): split-phase timing to localize the ~2.2s
    // ui_chat_poll_getmsgs stall — is it the profile/keystore step or the
    // SQLite read+decrypt? Threshold-gated so it's free in the fast path.
    const _t0 = Date.now();
    const pid = await this.ownerProfileId();
    const _t1 = Date.now();
    const rows = await listChatMessages({ contactPubB64, limit, offset, ownerProfileId: pid });
    const _t2 = Date.now();
    if (_t2 - _t0 > 150) log.info('getmsgs_phases', { profileMs: _t1 - _t0, listMs: _t2 - _t1, n: rows.length });
    return [...rows]
      .filter((r) => r.text !== '\u200b')
      .sort((a, b) => {
        const t = a.createdAt - b.createdAt;
        if (t !== 0) return t;
        return a.id.localeCompare(b.id);
      });
  }

  /**
   * Страница сообщений старше названной строки (v4.32.539).
   *
   * Отдельно от `getMessages` потому, что вызывающему нужны три вещи разом, и
   * все три считаются по НЕОТФИЛЬТРОВАННЫМ строкам: сами сообщения, признак
   * «есть ли ещё» и курсор для следующей страницы. По отфильтрованному списку
   * их не посчитать: страница из одних служебных строк соврала бы «конец
   * переписки» и не сдвинула бы отсчёт — экран замер бы на месте.
   *
   * `before === null` — первая страница, самые свежие сообщения.
   */
  async getOlderMessages(
    contactPubB64: string,
    limit: number,
    before: ChatPageCursor | null,
  ): Promise<{ messages: ChatMessageRow[]; hasMore: boolean; cursor: ChatPageCursor | null }> {
    const pid = await this.ownerProfileId();
    const rows = await listChatMessages({
      contactPubB64,
      limit,
      offset: 0,
      ownerProfileId: pid,
      before: before ?? undefined,
    });
    const messages = [...rows]
      .filter((r) => r.text !== '\u200b')
      .sort((a, b) => {
        const t = a.createdAt - b.createdAt;
        if (t !== 0) return t;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    return { messages, hasMore: rows.length >= limit, cursor: oldestCursor(rows) };
  }

  /** Load message when FCM delivers cid and did:key of peer. */
  async handlePushOpen(cid: string, contactDid?: string): Promise<void> {
    if (!cid?.trim()) return;
    if (!contactDid?.trim()) {
      log.warn('push_missing_contact_did');
      return;
    }
    const contacts = await listContacts();
    for (const c of contacts) {
      if (didFromPubB64(c.peerPublicKey) === contactDid) {
        await this.receiveCid(cid.trim(), c.peerPublicKey);
        return;
      }
    }
    log.warn('push_no_contact_for_did', { contactDid: contactDid.slice(0, 32) });
  }
}
