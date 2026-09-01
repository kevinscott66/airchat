// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: формат envelope FEED_ENVELOPE_MAGIC = 0xF0 согласован с
// lanCoordinator.onFrame (v4.32.24). Если поменять MAGIC-байт или порядок
// полей — lanCoordinator перестанет распознавать feed-трафик и будет
// отправлять его в messaging.receiveDirectLanEnvelope → ошибки парсинга +
// silent data loss.
//
// feedTransport (v4.32.24) — доставка ленты через multiTransportRouter вместо
// IPFS pubsub. После отключения IPFS на mobile (v4.32.19) путь публикации
// через `addToIpfs` + `pubsubPublish` стал холостым — посты оставались
// локальными. Этот модуль заменяет pubsub на адаптивный роутер
// (WebRTC → LAN → WiFi-Direct) с приоритетами, определёнными в multiTransport.ts.
//
// Протокол кадра:
//   [0]  0xF0           — магический байт, отличает feed-envelope от group-
//                         envelope (JSON начинается с '{' = 0x7B) и
//                         direct-envelope (тоже '{').
//   [1+] JSON           — `{ payload: string, signature: string }` где payload
//                         это canonical-stringify объекта FeedEnvelopePayload.
//                         Поля и порядок верификации — строго как в
//                         signature.ts#signJson/verifySignedJson.
//
// Версионирование: текущая версия протокола = 1 (неявная, без поля `version` в payload).
// Бэкворд-совместимость обеспечивается **аддитивными** изменениями: новые поля в
// FeedEventData-подтипах (`documents?`, `remove?`, `newText?`) помечаются
// опциональными — старые клиенты их игнорируют, новые получатели проверяют `!== undefined`.
// Если потребуется breaking-change (смена типа поля или удаление обязательного) —
// бампить MAGIC до 0xF1 и параллельно принимать оба до window дня, затем удалять
// старый. `FEED_ENVELOPE_MAGIC` — единственный in-band маркер версии.

import { Buffer } from 'buffer';
import type { KeyPairBytes } from '../crypto/keyManager';
import { signJson, verifySignedJson } from '../crypto/signature';
import { publicKeyToDidKey, parseDidKey } from '../identity/did';
import { log } from '../logger';
import { listContacts } from './contacts';
import { multiTransportRouter } from '../transport/multiTransport';
import { runWithConcurrency } from '../utils/runWithConcurrency';
import { pubsubSubscribe, pubsubPublish } from '../transport/ipfs/pubsub';

/** Магический первый байт. 0xF0 = вне ASCII-диапазона, JSON не может начинаться с него. */
export const FEED_ENVELOPE_MAGIC = 0xf0;
/**
 * v4.32.208 (Bridge Stage 2): feed-relay wrapper MAGIC.
 * Layout: [0xF1][JSON({h: hops, f: base64(original_0xF0_frame)})]
 *
 * Rationale: the signed feed envelope (0xF0) wraps a payload whose bytes are
 * signed by the author — we cannot add an `hops` field inside without
 * breaking the signature. A separate outer wrapper carries the hop counter
 * unsigned (hops are mesh metadata, not content), and the inner signed
 * frame is passed through verbatim to parseAndVerifyFeedEnvelope.
 *
 * Dispatch: isFeedFrame() accepts both 0xF0 (direct) and 0xF1 (relayed);
 * coordinators route both to receiveFeedEnvelope which unwraps as needed.
 */
export const FEED_RELAY_MAGIC = 0xf1;
export const FEED_RELAY_MAX_HOPS = 3;

/** Параллелизм broadcast'а. 8 — как в прошлом pubsub-пути, работает на 50 контактах за ~2с. */
const FEED_BROADCAST_CONCURRENCY = 8;

/** Лимит размера одного кадра (защита от base64-бомб в медиа). */
const FEED_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export type FeedEnvelopeType =
  | 'feed_post'
  | 'feed_reaction'
  | 'feed_comment'
  | 'feed_comment_reaction'
  | 'feed_comment_delete'
  | 'feed_repost'
  | 'feed_delete'
  | 'feed_edit'
  | 'feed_poll_vote'
  | 'feed_view';

/** Полезная нагрузка внутри подписанного payload'а. Ключи всегда сортируются (stableStringify в signJson). */
export interface FeedEnvelopePayload {
  type: FeedEnvelopeType;
  /** ID поста (для post/repost — свой, для reaction/comment/delete/edit — целевой). */
  postId: string;
  /** Автор события (DID). Должен совпадать с sender, иначе envelope отбрасывается. */
  authorDid: string;
  /** Время (ms, unix). */
  ts: number;
  /** Содержимое события (зависит от type). См. типы ниже. */
  data: FeedEventData;
}

export type FeedEventData =
  | FeedPostData
  | FeedReactionData
  | FeedCommentData
  | FeedCommentReactionData
  | FeedCommentDeleteData
  | FeedRepostData
  | FeedDeleteData
  | FeedEditData
  | FeedPollVoteData
  | FeedViewData;

export interface FeedPostData {
  kind: 'post';
  text: string;
  authorName: string;
  /** Медиа как base64 (изображения/видео). На мобильной сети IPFS нет, кладём inline. */
  media?: string[];
  mediaMime?: string[];
  /** v4.32.48: документы (PDF/DOC/…). Каждый элемент — base64 байтов.
   *  Опциональное поле — старые клиенты игнорируют, новый пост выглядит у них
   *  как пост без вложений. Лимит суммарно ≤1.5 MB до base64-оверхеда,
   *  жёстко режется в tryPublishFeedPostComplete → too_large. */
  documents?: FeedDocumentAttachment[];
}

/** v4.32.48: метаданные документа + inline base64 данные. */
export interface FeedDocumentAttachment {
  /** Имя файла с расширением, показывается получателю. */
  name: string;
  /** MIME (`application/pdf`, `application/msword`, …). */
  mime: string;
  /** Размер в байтах (до base64). */
  size: number;
  /** Base64-байты документа. */
  data: string;
}

export interface FeedReactionData {
  kind: 'reaction';
  emoji: string;
  /** v4.32.29: если true — это отмена реакции (unreact). Опциональное поле,
   *  старые клиенты его игнорируют (добавят, сняться ← пустой). */
  remove?: boolean;
}

export interface FeedCommentData {
  kind: 'comment';
  commentId: string;
  text: string;
  authorName: string;
}

/** Reaction to a comment. The signer is the reacting user, not the comment author. */
export interface FeedCommentReactionData {
  kind: 'comment_reaction';
  commentId: string;
  emoji: string;
  remove?: boolean;
}

/** v4.32.162: удаление комментария. Принимается, если отправитель = автор комментария
 *  ИЛИ отправитель = автор поста (модерация своей ленты). Аддитивный envelope — старые
 *  клиенты дропнут в default (`feed_envelope_unknown_type`), удаление у них не пройдёт,
 *  но это ок для прогрессивного rollout'а. */
export interface FeedCommentDeleteData {
  kind: 'comment_delete';
  commentId: string;
}

export interface FeedRepostData {
  kind: 'repost';
  text: string;
  authorName: string;
  originalPostId: string;
  originalAuthorDid: string;
  originalAuthorName: string | null;
  originalText: string;
  /** Устаревшее поле: до v4.32.29 содержало синтетические CID (`inline:*:<postId>`), что
   *  давало у получателя пустую картинку — у него нет kvStore-записи исходного поста. */
  originalMedia?: string[] | null;
  originalMediaMime?: string[] | null;
  /** v4.32.29: фактические base64-байты медиа оригинала, переносимые в репост.
   *  Опциональное поле, старые клиенты игнорируют → fallback на originalMedia-CID (пустая картинка). */
  originalMediaBase64?: string[];
  /** v4.32.29: mime-типы для originalMediaBase64 — 1:1. */
  originalMediaBase64Mime?: string[];
}

export interface FeedDeleteData {
  kind: 'delete';
}

export interface FeedEditData {
  kind: 'edit';
  newText: string;
}

/** v4.32.51: голос в опросе (пост типа `\x03<json>` с POLL_PREFIX).
 *  Аддитивный тип envelope — старые клиенты получат kind='poll_vote' и проигнорируют
 *  (switch в receiveFeedEnvelope упадёт в default → `feed_envelope_unknown_type`).
 *  postId — ID поста-опроса; authorDid (в payload) = DID голосующего (senderDid);
 *  optionIndex — индекс выбранного варианта;
 *  remove — если true, это отмена голоса (для multi-choice toggle). */
export interface FeedPollVoteData {
  kind: 'poll_vote';
  optionIndex: number;
  remove?: boolean;
}

/** v4.32.67: сообщение автору «я прочитал твой пост». Отправляется ТОЛЬКО автору
 *  оригинального поста (targeted send через multiTransportRouter), один раз за
 *  пост+пара (дедуп по постId+senderDid). Получатель-автор пишет в локальную
 *  таблицу feed_post_views (viewer_did, viewed_at). postId — целевой пост;
 *  authorDid (в payload) = DID viewer'а (= senderDid). `viewerName` — опциональное
 *  имя viewer'а (из своего профиля), чтобы автор видел подпись без листания
 *  контактов; если нет — автор fallback'ается на contact-name или shortDid. */
export interface FeedViewData {
  kind: 'view';
  viewerName?: string;
}

/** Быстрый чек на тип кадра по первому байту. Вызывается на каждом входящем LAN-сообщении. */
export function isFeedEnvelope(payload: Uint8Array): boolean {
  return payload.length > 0 && payload[0] === FEED_ENVELOPE_MAGIC;
}

/** v4.32.208: 0xF1 — relay wrapper over a signed feed frame. */
export function isFeedRelayWrapper(payload: Uint8Array): boolean {
  return payload.length > 0 && payload[0] === FEED_RELAY_MAGIC;
}

/**
 * v4.32.208: accept both direct signed feed frames (0xF0) and relay-wrapped
 * frames (0xF1) — coordinators dispatch both to receiveFeedEnvelope.
 */
export function isFeedFrame(payload: Uint8Array): boolean {
  return payload.length > 0 && (payload[0] === FEED_ENVELOPE_MAGIC || payload[0] === FEED_RELAY_MAGIC);
}

/**
 * v4.32.208: wrap a signed feed frame (must be 0xF0-prefixed) with a hop
 * counter for mesh relay. Returns null on size overflow or bad input.
 */
export function wrapFeedRelay(innerFrame: Uint8Array, hops: number): Uint8Array | null {
  try {
    if (!isFeedEnvelope(innerFrame)) return null;
    if (innerFrame.length > FEED_ENVELOPE_MAX_BYTES) return null;
    const clamped = Math.max(0, Math.min(FEED_RELAY_MAX_HOPS, hops | 0));
    const body = { h: clamped, f: Buffer.from(innerFrame).toString('base64') };
    const json = JSON.stringify(body);
    const jsonBytes = new TextEncoder().encode(json);
    const out = new Uint8Array(jsonBytes.length + 1);
    out[0] = FEED_RELAY_MAGIC;
    out.set(jsonBytes, 1);
    if (out.length > FEED_ENVELOPE_MAX_BYTES) {
      log.warn('feed_relay_wrapper_too_large', { bytes: out.length });
      return null;
    }
    return out;
  } catch (e) {
    log.warn('feed_relay_wrap_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * v4.32.209 (Bridge Stage 2 fix): verify a signed 0xF0 frame that arrived
 * via a relay hop. The transport's sender DID is NOT the author — we must
 * verify the signature against the authorDid embedded in the payload.
 *
 * Safety: still decodes strictly. Peek authorDid from the unverified inner
 * JSON, then call verifySignedJson with the author's pub key. If the
 * signature is valid for that pub key, the author truly authored it,
 * regardless of who forwarded it.
 */
export async function parseAndVerifyRelayedFeedEnvelope(
  frame: Uint8Array,
): Promise<FeedEnvelopePayload | null> {
  if (!isFeedEnvelope(frame)) return null;
  if (frame.length > FEED_ENVELOPE_MAX_BYTES) return null;
  let peekedAuthor: string;
  try {
    const outerJson = new TextDecoder().decode(frame.slice(1));
    const outer = JSON.parse(outerJson) as { payload?: unknown };
    if (typeof outer?.payload !== 'string') return null;
    // v4.32.209: byte-cap the inner payload string before a second JSON.parse.
    if (outer.payload.length > FEED_ENVELOPE_MAX_BYTES) return null;
    const peeked = JSON.parse(outer.payload) as { authorDid?: unknown };
    if (typeof peeked?.authorDid !== 'string') return null;
    peekedAuthor = peeked.authorDid;
  } catch {
    return null;
  }
  return parseAndVerifyFeedEnvelope(frame, peekedAuthor);
}

/** v4.32.208: unwrap a 0xF1-prefixed relay frame. Returns {hops, inner} or null. */
export function unwrapFeedRelay(wrapper: Uint8Array): { hops: number; inner: Uint8Array } | null {
  try {
    if (!isFeedRelayWrapper(wrapper)) return null;
    if (wrapper.length > FEED_ENVELOPE_MAX_BYTES) return null;
    const json = new TextDecoder().decode(wrapper.slice(1));
    if (json.length > FEED_ENVELOPE_MAX_BYTES) return null;
    const body = JSON.parse(json) as { h?: unknown; f?: unknown };
    if (!body || typeof body !== 'object') return null;
    const hops = typeof body.h === 'number' && Number.isFinite(body.h)
      ? Math.max(0, Math.min(FEED_RELAY_MAX_HOPS, body.h | 0))
      : 0;
    if (typeof body.f !== 'string' || body.f.length > FEED_ENVELOPE_MAX_BYTES * 2) return null;
    const inner = new Uint8Array(Buffer.from(body.f, 'base64'));
    if (!isFeedEnvelope(inner)) return null;
    if (inner.length > FEED_ENVELOPE_MAX_BYTES) return null;
    return { hops, inner };
  } catch {
    return null;
  }
}

/**
 * Упаковать FeedEnvelopePayload в байты: подпись + MAGIC-байт + JSON.
 * Возвращает null если результат больше лимита.
 */
export async function serializeFeedEnvelope(
  pair: KeyPairBytes,
  payload: FeedEnvelopePayload,
): Promise<Uint8Array | null> {
  try {
    const signed = await signJson(pair, payload as unknown as Record<string, unknown>);
    const json = JSON.stringify(signed);
    const jsonBytes = new TextEncoder().encode(json);
    const out = new Uint8Array(jsonBytes.length + 1);
    out[0] = FEED_ENVELOPE_MAGIC;
    out.set(jsonBytes, 1);
    if (out.length > FEED_ENVELOPE_MAX_BYTES) {
      log.warn('feed_envelope_too_large', { bytes: out.length, limit: FEED_ENVELOPE_MAX_BYTES, type: payload.type });
      return null;
    }
    return out;
  } catch (e) {
    log.warn('feed_envelope_serialize_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Распарсить + проверить подпись. Возвращает payload или null если подпись не верна /
 * author не совпадает с sender'ом.
 *
 * @param senderDid — DID отправителя (из LAN-транспорта). Проверяется что
 *                    payload.authorDid === senderDid — чтобы нельзя было
 *                    подписать от чужого имени.
 */
export async function parseAndVerifyFeedEnvelope(
  frame: Uint8Array,
  senderDid: string,
): Promise<FeedEnvelopePayload | null> {
  if (!isFeedEnvelope(frame)) return null;
  if (frame.length > FEED_ENVELOPE_MAX_BYTES) {
    log.warn('feed_envelope_received_too_large', { bytes: frame.length });
    return null;
  }
  let outer: { payload: string; signature: string };
  try {
    const json = new TextDecoder().decode(frame.slice(1));
    outer = JSON.parse(json) as { payload: string; signature: string };
  } catch {
    return null;
  }
  if (typeof outer?.payload !== 'string' || typeof outer?.signature !== 'string') return null;

  const pk = parseDidKey(senderDid);
  if (!pk) {
    log.warn('feed_envelope_sender_did_invalid', { senderDid: senderDid.slice(0, 32) });
    return null;
  }
  const verified = await verifySignedJson(pk, outer);
  if (!verified) {
    log.warn('feed_envelope_verify_failed', { senderDid: senderDid.slice(0, 32) });
    return null;
  }
  const payload = verified as unknown as FeedEnvelopePayload;
  if (!payload || typeof payload !== 'object') return null;
  // v4.32.212: cap authorDid length before compare (DID regex is 256-max elsewhere).
  if (typeof payload.authorDid !== 'string' || payload.authorDid.length > 256) return null;
  if (payload.authorDid !== senderDid) {
    log.warn('feed_envelope_author_mismatch', {
      author: payload.authorDid?.slice(0, 32),
      sender: senderDid.slice(0, 32),
    });
    return null;
  }
  if (typeof payload.type !== 'string' || typeof payload.postId !== 'string') return null;
  // v4.32.212 (Audit-41 #6): cap type + postId lengths. Without this a peer
  // can push a 2MB postId that bloats feedSeenKeys dedup cache (8192 × 2MB
  // = 16GB worst case). Typical postIds are UUIDs (36 chars) or CIDs (46-59).
  if (payload.type.length > 32 || payload.postId.length > 128) {
    log.warn('feed_envelope_field_oversize', {
      typeLen: payload.type.length,
      postIdLen: payload.postId.length,
    });
    return null;
  }
  if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) return null;
  // v4.32.213 (Audit-42 C2): reject envelopes older than 7 days. Without this
  // a relay/peer can capture a signed envelope and re-inject it years later;
  // combined with FIFO-evicting feedSeenKeys (8192 entries) it re-processes.
  // Floor is applied BEFORE the forward clamp so rejected envelopes never
  // reach savePost or gossip relay.
  const FEED_ENVELOPE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  if (payload.ts < Date.now() - FEED_ENVELOPE_MAX_AGE_MS) {
    return null;
  }
  // v4.32.202 (Round-32 #1): clamp ts to [0, now+5min]. Without this a signed
  // peer can pin their post at the top (ts=Infinity) or bury it in the past,
  // since feed is ordered by timestamp DESC.
  payload.ts = Math.min(Math.max(payload.ts, 0), Date.now() + 5 * 60_000);
  return payload;
}

/**
 * Разослать кадр всем контактам через multiTransportRouter.
 * Результат: сколько успешных доставок + список DID'ов, которым успешно доставили.
 *
 * v4.32.67: добавлен параметр `opts.skipDids` и `opts.onlyDids` — позволяет нацелить retry
 * только на недоставленных контактов (per-recipient tracking в feed_publish_queue). Это
 * закрывает сценарий «контакт был оффлайн, подключился позже — сообщение не пришло»:
 * при presence-триггере (lanCoordinator.onPeerDiscovered) мы повторяем broadcast только
 * на `onlyDids: [just_discovered_did]`, не спамя остальных.
 */
export async function broadcastFeedEnvelope(
  frame: Uint8Array,
  opts?: { skipDids?: Set<string>; onlyDids?: Set<string> },
): Promise<{ total: number; success: number; successDids: string[] }> {
  const contacts = await listContacts();
  if (contacts.length === 0) return { total: 0, success: 0, successDids: [] };

  const skipDids = opts?.skipDids;
  const onlyDids = opts?.onlyDids;
  const successDids: string[] = [];
  // Считаем «total» только по адресатам, которым реально пытались отправить.
  const targets: Array<{ did: string; contact: typeof contacts[number] }> = [];
  for (const c of contacts) {
    try {
      const peerPk = new Uint8Array(Buffer.from(c.peerPublicKey, 'base64'));
      const recipientDid = publicKeyToDidKey(peerPk);
      if (skipDids && skipDids.has(recipientDid)) continue;
      if (onlyDids && !onlyDids.has(recipientDid)) continue;
      targets.push({ did: recipientDid, contact: c });
    } catch { /* invalid pk — skip */ }
  }
  if (targets.length === 0) {
    log.info('feed_broadcast_done', { total: 0, success: 0, filtered: true });
    return { total: 0, success: 0, successDids: [] };
  }

  let success = 0;
  await runWithConcurrency(targets, FEED_BROADCAST_CONCURRENCY, async (t) => {
    try {
      const ok = await multiTransportRouter.send(frame, t.did);
      if (ok) {
        success += 1;
        successDids.push(t.did);
      }
    } catch (e) {
      log.warn('feed_broadcast_contact_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  });

  log.info('feed_broadcast_done', { total: targets.length, success });
  return { total: targets.length, success, successDids };
}

/**
 * Удобный helper: подписать + разослать. Вызывается из feedService.ts.
 * Возвращает сериализованный frame (нужен caller'у для логирования размеров) и
 * результат доставки. Если serialize failed — возвращает null.
 *
 * v4.32.67: поддержка targeted retry через `opts.skipDids`/`opts.onlyDids`.
 */
export async function signAndBroadcastFeedEnvelope(
  pair: KeyPairBytes,
  payload: FeedEnvelopePayload,
  opts?: { skipDids?: Set<string>; onlyDids?: Set<string> },
): Promise<{ frame: Uint8Array; delivered: { total: number; success: number; successDids: string[] } } | null> {
  const frame = await serializeFeedEnvelope(pair, payload);
  if (!frame) return null;
  const delivered = await broadcastFeedEnvelope(frame, opts);
  return { frame, delivered };
}

// ─── v4.32.114 T2 (Telegram-style per-post comments) ────────────────────────────
//
// Подписи/реакции/репосты на пост должны долетать до любого, кто этот пост видит,
// а не только до контактов автора события. Решение — pubsub-топик, детерминированный
// от postId: все наблюдатели поста подписываются на `airchat-post-<postId>` когда
// открывают модалку комментариев, а коммент-автор параллельно с контактным broadcast'ом
// публикует envelope в этот топик.
//
// Безопасность: верификация подписи остаётся той же (parseAndVerifyFeedEnvelope), поэтому
// любой может опубликовать в топик, но envelope будет отброшен получателем если подпись
// не совпадает с payload.authorDid. Мы не доверяем pubsub-транспорту, доверяем подписи.

/**
 * v4.32.125 (AUDIT P2): sanitize postId before baking into pubsub topic name.
 * postId is derived from CID or random bytes, but callers may pass user-controlled
 * strings by mistake; a topic name containing whitespace/control chars could
 * either crash the pubsub transport or match a broader topic than intended.
 * postId alphabet is base32/base58 + a handful of separators — нестрогий
 * allowlist достаточен.
 */
const POST_ID_ALLOWED = /^[a-zA-Z0-9_\-.:]{1,128}$/;

export function postCommentsTopic(postId: string): string | null {
  if (!POST_ID_ALLOWED.test(postId)) {
    // v4.32.130 (AUDIT): was returning a shared sentinel
    // `airchat-post-__invalid__`. Two screens that each passed a different
    // invalid postId would end up subscribing to the same topic and cross-
    // contaminate each other's comment streams. Return null and let callers
    // no-op the subscription/publish; `verified.postId !== postId` server
    // check also protected against mixing, but we shouldn't make a bad
    // subscription at all.
    log.warn('post_topic_postid_rejected', { len: postId?.length ?? 0 });
    return null;
  }
  return `airchat-post-${postId}`;
}

/**
 * Подписаться на pubsub-топик комментариев к посту. Каждый входящий frame парсится,
 * authorDid извлекается из (пока неверифицированного) payload, затем вызывается
 * `parseAndVerifyFeedEnvelope(frame, claimedAuthorDid)` — подпись verifySignedJson
 * гарантирует что payload действительно подписан ключом authorDid.
 *
 * `onVerified` получает уже проверенный payload. FeedScreen вызывает из него
 * `receiveFeedEnvelope(frame, authorDid)` для полной диспетчеризации (savePost/addComment
 * + emitFeedUpdate).
 *
 * Возвращает unsubscribe fn или null если pubsub недоступен (не-IPFS сборка).
 */
export async function subscribeToPostCommentsTopic(
  postId: string,
  onVerified: (frame: Uint8Array, authorDid: string) => void,
): Promise<(() => void) | null> {
  const topic = postCommentsTopic(postId);
  if (!topic) return null;
  return pubsubSubscribe(topic, async (msg) => {
    try {
      // v4.32.196 (Round-26 #4): byte-cap BEFORE outer JSON.parse.
      // parseAndVerifyFeedEnvelope enforces FEED_ENVELOPE_MAX_BYTES, but the
      // outer shape-probe below decodes and JSON.parses the frame first, so
      // a multi-MB publish would blow memory before verification runs.
      if (msg.data.length > FEED_ENVELOPE_MAX_BYTES) return;
      if (!isFeedEnvelope(msg.data)) return;
      const json = new TextDecoder().decode(msg.data.slice(1));
      const outer = JSON.parse(json) as { payload: string };
      if (typeof outer?.payload !== 'string') return;
      const inner = JSON.parse(outer.payload) as FeedEnvelopePayload;
      const claimed = typeof inner?.authorDid === 'string' ? inner.authorDid : '';
      if (!claimed) return;
      // Безопасная повторная верификация — вернёт null если подпись от другого ключа.
      const verified = await parseAndVerifyFeedEnvelope(msg.data, claimed);
      if (!verified) return;
      // v4.32.115: строгая проверка postId. Иначе злонамеренный участник мог бы
      // опубликовать в airchat-post-A подписанный envelope с postId=B и мы бы
      // обработали его как коммент к B (SQL-запись и бамп feedTick) — лишний трафик
      // и потенциальный vector для вытеснения легитимных комментов.
      if (verified.postId !== postId) {
        log.warn('post_topic_postid_mismatch', {
          expected: postId.slice(0, 12),
          got: verified.postId.slice(0, 12),
        });
        return;
      }
      onVerified(msg.data, claimed);
    } catch (e) {
      log.warn('post_topic_parse_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  });
}

export async function publishToPostCommentsTopic(postId: string, frame: Uint8Array): Promise<boolean> {
  const topic = postCommentsTopic(postId);
  if (!topic) return false;
  return pubsubPublish(topic, frame);
}
