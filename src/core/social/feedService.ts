/**
 * Лента: с v4.32.24 публикация идёт через multiTransportRouter (LAN + WebRTC + WiFi-Direct),
 * а не через IPFS pubsub. IPFS был отключён на mobile в v4.32.19 (isIpfsEnabled = false
 * на Android/iOS — helia-импорт блокировал JS-поток на 30с), после чего весь feed
 * стоял: addToIpfs возвращал null → publishFeedPost уходил в очередь и там копился.
 * Теперь посты/реакции/комментарии/репосты/delete/edit рассылаются как подписанные
 * FeedEnvelope кадры — см. ./feedTransport.ts, lanCoordinator.ts.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { KeyPairBytes } from '../crypto/keyManager';
import { publicKeyToDidKey, parseDidKey, didFromPubB64 } from '../identity/did';
import { profileManager } from '../identity/profileManager';
import { ownerPidByDid, storageIsOwn } from '../identity/ownerProfile';
import { publicKeyFromB64 } from '../crypto/pubKeyFormat';
import {
  FeedStorage,
  deleteFeedDbForProfile,
  type FeedPostRow,
  type FeedCommentRow,
  type FeedViewerRow,
  type FeedSyncSnapshot,
  type FeedSyncTombstone,
} from '../storage/feedStorage';
import { isPlainCid } from '../cid';
import { log } from '../logger';
import { scopedKvSetFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { feedViewSentKey } from '../storage/kvKeys';
import { kvGet, kvSet, kvDelete, kvGetInlineAttachment, kvSetInlineAttachment, kvDeleteByPrefix, kvTryListKeysByPrefix, setPollVote, deletePollVote, parsePollText, POLL_PREFIX } from '../storage/local';
import {
  INLINE_MEDIA_PREFIX,
  INLINE_DOC_PREFIX,
  postIdFromInlineKey,
  scanInlineOrphans,
  type InlinePostRef,
} from './feedOrphanScan';
import { gatewayUrl } from '../media/gatewayUrl';
import { runWithConcurrency } from '../utils/runWithConcurrency';
import { listContacts } from './contacts';
import { isAuthorMuted } from './mutedAuthors';
// v4.32.528: тип, в котором сбой чтения отличим от пустой ленты.
import type { DbRead } from '../storage/readResult';
import {
  FEED_COMMENT_MAX_CHARS,
  FEED_POST_MAX_CHARS,
  clampFeedAuthorName,
  clampFeedCommentText,
  clampFeedPostText,
  isEditableFeedText,
} from './feedTextLimit';
import { multiTransportRouter } from '../transport/multiTransport';
import { checkOnlineWrite } from '../sync/cachePolicy';
import { offlineAction, shouldAttemptBroadcast } from '../sync/localFirstWrite';
import { classifyBroadcast, dispositionOf, needsRetryQueue } from '../sync/publishOutcome';
import { Buffer } from 'buffer';
import {
  signAndBroadcastFeedEnvelope,
  parseAndVerifyFeedEnvelope,
  parseAndVerifyRelayedFeedEnvelope,
  publishToPostCommentsTopic,
  isFeedRelayWrapper,
  unwrapFeedRelay,
  wrapFeedRelay,
  FEED_RELAY_MAX_HOPS,
  type FeedEnvelopePayload,
  type FeedPostData,
  type FeedReactionData,
  type FeedCommentData,
  type FeedCommentReactionData,
  type FeedCommentDeleteData,
  type FeedRepostData,
  type FeedDeleteData,
  type FeedEditData,
  type FeedPollVoteData,
  type FeedViewData,
} from './feedTransport';

import {
  mergeQueue,
  mergeOutbox,
  ownedByKey,
  countByAuthor,
  sendableCount,
  parseQueueCounts,
  type QueueDecision,
} from './feedQueueCommit';

/** Ключ очереди v2 — v1 использовал IPFS, формат несовместим. v1-items игнорируются. */
const FEED_QUEUE_KEY = 'feed_publish_queue_v2';
/** v4.32.xx: отдельный маленький ключ со счётчиком очереди. Используется
 *  getFeedPublishQueueLength() чтобы не читать MB-сайз JSON из kvStore на каждом
 *  переключении таба. v4.32.459: внутри не одно число, а счёт по авторам —
 *  очередь одна на приложение, а показывать надо только свои записи. */
const FEED_QUEUE_LEN_KEY = 'feed_publish_queue_len_v2';
const MAX_QUEUE_RETRIES = 200; // v4.32.67: было 15; теперь retry идут до TTL, не до счётчика
/** v4.32.67: TTL — пост живёт в очереди 14 дней, ретраится пока не будет доставлен
 *  всем контактам. Закрывает сценарий: собеседник был оффлайн неделю → подключился →
 *  при mDNS discovery trigger'е post до него долетает. */
const FEED_QUEUE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// Base delay used both for initial retry scheduling and exponential backoff.
const RETRY_DELAY_MS = 30_000;
/** Не читать все URI в `Promise.all` — много тяжёлых base64 подряд нагружает Hermes/диск. */
const FEED_IMAGE_READ_CONCURRENCY = 4;
/** Лимит base64 одного медиа — защита от раздувания envelope выше FEED_ENVELOPE_MAX_BYTES. */
// v4.32.48: увеличили лимит 512KB → 800KB (base64-декодинг ~600KB raw). Вместе со
// снижением picker.quality до 0.6 в composers это покрывает подавляющее большинство
// фото с 12MP+ камер без ресайза. Лимит держит envelope < 2MB даже при 2 фото.
const FEED_MEDIA_MAX_BASE64_BYTES = 800 * 1024;

type QueuedFeedItem = {
  id: string;
  /** v4.32.29: стабильный postId — если пост был локально сохранён, переиспользуем.
   *  Раньше каждая retry-попытка генерила новый postId → дубликаты у автора. */
  postId?: string;
  /** v4.32.29: mime для каждого медиа — чтобы при retry восстановить envelope корректно. */
  imageMimes?: string[];
  text: string;
  authorName: string;
  /** v4.32.66 DEPRECATED: raw base64 раньше хранился прямо в JSON-очереди в kvStore;
   *  на 3 постах × 3 фото × 800KB это давало >7MB JSON blob, и каждый `getFeedPublishQueueLength()`
   *  (60с tick в FeedScreen + вызовы из onPublish) блокировал SQLite write-lock на 30+ секунд
   *  (зафиксировано `ui_kv_get_slow feed_publish_queue_v2 ms=32737`). С v4.32.66 НОВЫЕ items
   *  не пишут imageBase64s — байты уже лежат в `feed_inline_media:${postId}:${i}` kvStore
   *  (сохраняются в `tryPublishFeedPostComplete` при первом публикации). `republishQueuedItem`
   *  читает их оттуда напрямую. Поле оставлено optional для backward-compat со старыми
   *  items в очереди, которые дренируются в ближайшие итерации retry. */
  imageBase64s?: string[];
  retries: number;
  createdAt: number;
  /** v4.32.67: список DID'ов, которым пост уже успешно доставлен. Каждый retry пропускает
   *  этих адресатов и целится только в недоставленных — это единственный путь
   *  гарантировать доставку «контакту, который был оффлайн и подключился позже»:
   *  при presence-триггере (mDNS onPeerDiscovered) мы делаем retry только на него. */
  deliveredTo?: string[];
  /**
   * Чей это пост (v4.32.439).
   *
   * Очередь публикации лежит в ОДНОЙ записи kv на всё приложение
   * (`feed_publish_queue_v2`), а разбирает её тот ключ, который активен в момент
   * разбора. До этой отметки запись, положенную в очередь личным профилем,
   * при следующем flush'е забирал рабочий: пост без postId уходил в эфир
   * заново подписанным ЧУЖИМ ключом и рабочим контактам, а пост с postId
   * просто исчезал из очереди — `getPost` не находил его в ленте активного
   * профиля и это читалось как «автор удалил пост локально».
   *
   * Поле необязательное: записи, сделанные до v4.32.439, отметки не имеют.
   * Их владельца выясняет `republishQueuedItem` — по наличию поста в ленте
   * активного профиля; неопознанные лежат до TTL, но никуда не отправляются.
   */
  authorDid?: string;
};

export type PublishFeedResult =
  | { ok: true; cid: string; mediaDropped?: number }
  | { ok: true; queued: true; mediaDropped?: number }
  | { ok: false; reason?: 'empty' | 'too_large' | 'offline' | 'other'; mediaDropped?: number };

let retryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Ключ, которым будет отправлять таймер очереди постов (v4.32.462).
 *
 * Своя переменная у каждого таймера. Раньше очередь публикации и отложенные
 * комментарии делили одну: комментарий, написанный после переключения профиля,
 * подменял ключ у уже заведённого таймера постов. Тот просыпался с чужой парой,
 * своих записей не находил (их автор — другой ключ), больше себя не назначал —
 * и пост оставался лежать до перезапуска или смены сети.
 */
let feedRetryPair: KeyPairBytes | null = null;

function clearFeedRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

let storage: FeedStorage | null = null;
let currentProfileId: number | null = null;
let inboxUnsub: (() => void) | null = null;

/** Close the active feed database before copying it into the account vault. */
export async function closeFeedStorage(): Promise<void> {
  clearFeedRetryTimer();
  feedRetryPair = null;
  if (ctxPromise) {
    try {
      await ctxPromise;
    } catch {
      // A failed context has no safe connection to close.
    }
  }
  const active = storage;
  storage = null;
  currentProfileId = null;
  if (active) await active.close();
}
/**
 * v4.32.22: inflight-promise гвард. При `switchProfile` 4 useEffect'а в App.tsx
 * перезапускаются одновременно + `ensureStorage()` из FeedScreen — все дёргают
 * `setFeedProfileContext(pid)`. Раньше каждый создавал свой `new FeedStorage` и
 * гонял 7 ALTER TABLE в параллель → write-lock SQLite на 30-50с. Теперь
 * параллельные вызовы для одного pid ждут один и тот же Promise.
 */
let ctxPromise: Promise<void> | null = null;
let ctxPromiseForId: number | null = null;

export async function setFeedProfileContext(profileId: number): Promise<void> {
  if (currentProfileId === profileId && storage) return;
  if (ctxPromiseForId === profileId && ctxPromise) {
    await ctxPromise;
    return;
  }
  ctxPromiseForId = profileId;
  ctxPromise = (async () => {
    const next = new FeedStorage(profileId);
    await next.init();
    storage = next;
    currentProfileId = profileId;
  })();
  try {
    await ctxPromise;
  } finally {
    if (ctxPromiseForId === profileId) {
      ctxPromise = null;
      ctxPromiseForId = null;
    }
  }
}

/**
 * Та ли это лента, чьим ключом мы собираемся отправлять (v4.32.458).
 *
 * Лента активного профиля — модульная переменная: `rebindFeedToProfile`
 * подменяет её при переключении. Рассылка очереди живёт секунды и держит свою
 * пару ключей; если переключение случилось посреди неё, `ensureStorage()`
 * вернёт базу УЖЕ ДРУГОГО профиля. Отметка автора (v4.32.439) этот случай не
 * ловит: ключ-то наш, чужая тут база — и пост, которого в ней нет, читался как
 * «автор удалил его локально», после чего запись удалялась из очереди навсегда.
 *
 * Отвечаем «нет», только когда точно знаем оба номера и они разные: если
 * профили ещё не подняты (установка без seed), поведение прежнее.
 */
function feedStorageBelongsTo(pair: KeyPairBytes): boolean {
  const pid = ownerPidByDid(
    publicKeyToDidKey(pair.publicKey),
    profileManager.getActiveProfile(),
    () => profileManager.getAllProfiles(),
  );
  return storageIsOwn(pid, currentProfileId);
}

async function ensureStorage(): Promise<FeedStorage> {
  // v4.32.31: ждём inflight setFeedProfileContext, если он в процессе — это
  // устраняет race, когда receiveFeedEnvelope или UI-call (loadFeedPosts и т.п.)
  // срабатывал между `switchProfile` и `rebindFeedToProfile` и попадал на
  // `currentProfileId=null` → fallback `?? 1` писал в БД чужого (первого) профиля.
  if (ctxPromise) {
    try { await ctxPromise; } catch { /* ignored: followup attempt ниже */ }
  }
  if (storage && currentProfileId != null) return storage;
  // Last-ditch: профиль ещё не установлен (старт приложения до identity-effect).
  // НЕ пишем в произвольную БД — ждём явного setFeedProfileContext от caller'а.
  throw new Error('feed_storage_profile_unset');
}

/** Server-sync projection hooks for the active profile. */
export async function exportFeedSyncSnapshot(): Promise<FeedSyncSnapshot> {
  return (await ensureStorage()).exportSyncSnapshot();
}

export async function applyFeedSyncPost(row: FeedPostRow): Promise<void> {
  await (await ensureStorage()).upsertSyncPost(row);
}

export async function applyFeedSyncComment(row: FeedCommentRow): Promise<void> {
  await (await ensureStorage()).upsertSyncComment(row);
}

export async function applyFeedSyncPostDelete(postId: string): Promise<void> {
  await (await ensureStorage()).deleteSyncPost(postId);
}

export async function applyFeedSyncCommentDelete(tombstone: FeedSyncTombstone): Promise<void> {
  await (await ensureStorage()).deleteSyncComment(
    tombstone.commentId,
    tombstone.postId,
    tombstone.deletedAt,
  );
}

/**
 * Читает URI и возвращает base64 + mime. v4.32.24: медиа едет inline в envelope
 * (не через IPFS), поэтому применяем лимит на байт raw-файла.
 */
async function readMediaAsBase64(uri: string): Promise<{ b64: string; mime: string } | null> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    if (info.size && info.size > FEED_MEDIA_MAX_BASE64_BYTES) {
      log.warn('feed_media_too_large', { size: info.size, limit: FEED_MEDIA_MAX_BASE64_BYTES });
      return null;
    }
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const mime = /\.(jpe?g)$/i.test(uri) ? 'image/jpeg'
      : /\.png$/i.test(uri) ? 'image/png'
      : /\.webp$/i.test(uri) ? 'image/webp'
      : /\.gif$/i.test(uri) ? 'image/gif'
      : 'application/octet-stream';
    return { b64, mime };
  } catch (e) {
    log.warn('feed_media_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** v4.32.48: максимальный размер одного документа в байтах (до base64).
 *  Envelope лимит 2MB → 1.5MB raw → ~2MB base64; запас на текст/подпись. */
const FEED_DOC_MAX_RAW_BYTES = 1.2 * 1024 * 1024; // 1.2 MB
/** Сколько документов максимум можно прикрепить к одному посту. */
const FEED_DOC_MAX_PER_POST = 3;

/** Вход: { uri, name, mime, size }. Возврат: base64 + реальный size, либо null при превышении лимита. */
export type FeedDocumentInput = { uri: string; name: string; mime: string; size?: number };

async function readDocumentAsBase64(
  input: FeedDocumentInput,
): Promise<{ name: string; mime: string; size: number; b64: string } | null> {
  try {
    const info = await FileSystem.getInfoAsync(input.uri);
    if (!info.exists) return null;
    const size = (info as { size?: number }).size ?? input.size ?? 0;
    if (size > FEED_DOC_MAX_RAW_BYTES) {
      log.warn('feed_doc_too_large', { size, limit: FEED_DOC_MAX_RAW_BYTES, name: input.name });
      return null;
    }
    const b64 = await FileSystem.readAsStringAsync(input.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { name: input.name, mime: input.mime || 'application/octet-stream', size, b64 };
  } catch (e) {
    log.warn('feed_doc_read_failed', { err: e instanceof Error ? e.message : String(e), name: input.name });
    return null;
  }
}

/**
 * Генерация local-id (эквивалент CID'а, но без IPFS).
 * v4.32.47: 128-бит энтропии через `crypto.getRandomValues` (полифилл
 * `react-native-get-random-values` подключён в `index.ts`). До этого использовался
 * `Math.random().slice(2,10)` — ~40 бит, риск коллизии при флуд-ретраях и
 * одновременных публикациях с нескольких устройств одного пользователя.
 */
function generateFeedPostId(): string {
  const bytes = new Uint8Array(16); // 128-бит
  try {
    // crypto.getRandomValues доступен в RN через react-native-get-random-values
    (globalThis as { crypto?: { getRandomValues?: (u: Uint8Array) => Uint8Array } })
      .crypto?.getRandomValues?.(bytes);
  } catch {
    // Fallback: последняя линия обороны при отсутствии полифилла (не должна срабатывать)
  }
  // Если полифилл не сработал и байты остались нулевыми — смешиваем с Math.random чтобы не отдавать постоянный id
  let allZero = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) { allZero = false; break; }
  }
  if (allZero) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `f_${Date.now()}_${hex}`;
}

/**
 * v4.32.29: резолвер media-URI для рендера в FeedScreen. До этого UI строил
 * URL `${gateway}/ipfs/${cid}` для ВСЕХ cid — в т.ч. для `inline:<mime>;<i>:<postId>`,
 * что давало 404. Теперь:
 *   - `inline:<mime>;<i>:<postId>` → читаем base64 из kvStore и возвращаем data URI;
 *   - остальные (unlikely, legacy IPFS CID) → IPFS gateway если задан.
 */
export async function resolveFeedMediaUri(cid: string, gateway: string | null): Promise<string> {
  if (cid.startsWith('inline:')) {
    const rest = cid.slice('inline:'.length);
    const semi = rest.indexOf(';');
    if (semi < 0) return '';
    const mime = rest.slice(0, semi);
    const afterSemi = rest.slice(semi + 1);
    const colon = afterSemi.indexOf(':');
    if (colon < 0) return '';
    const idx = afterSemi.slice(0, colon);
    const postId = afterSemi.slice(colon + 1);
    const b64 = await kvGetInlineAttachment(`feed_inline_media:${postId}:${idx}`);
    if (!b64) return '';
    return `data:${mime};base64,${b64}`;
  }
  // v4.32.243: адрес шлюза собирает core/media/gatewayUrl — cid записи ленты
  // приходит от автора, а картинка грузится сама при отрисовке.
  return gatewayUrl(gateway, cid);
}

/** v4.32.48: прочитать base64 документа по postId/index из kvStore. */
export async function readFeedDocumentBase64(postId: string, index: number): Promise<string | null> {
  const b64 = await kvGetInlineAttachment(`feed_inline_doc:${postId}:${index}`);
  return b64 && b64.length > 0 ? b64 : null;
}

/**
 * v4.32.48: записать документ на диск устройства для последующего «Поделиться»
 * через expo-sharing или открытия пользователем.
 * Возвращает file:// URI свежесозданного файла в FileSystem.cacheDirectory или null.
 */
export async function saveFeedDocumentToCache(
  postId: string,
  index: number,
  name: string,
): Promise<string | null> {
  try {
    const b64 = await readFeedDocumentBase64(postId, index);
    if (!b64) return null;
    const safeName = name.replace(/[^\w.-]/g, '_').slice(0, 120) || `doc_${index}`;
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    if (!dir) return null;
    const uri = `${dir}feed_${postId.slice(0, 24)}_${index}_${safeName}`;
    await FileSystem.writeAsStringAsync(uri, b64, { encoding: FileSystem.EncodingType.Base64 });
    return uri;
  } catch (e) {
    log.warn('feed_doc_to_cache_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Пакетный резолв для списка постов. Возвращает map postId → список готовых URI.
 *  v4.32.64: добавлен concurrency-лимит — раньше `Promise.all(posts.map(... Promise.all(mediaCids.map(...))))`
 *  давал неконтролируемый параллелизм: лента из 20 постов × 3 медиа = 60+ одновременных
 *  kvGet'ов, на Android flash это приводило к write-lock contention и подвисаниям UI.
 *  Теперь все resolve-операции (пост × медиа) идут через один общий пул `FEED_IMAGE_READ_CONCURRENCY`. */
export async function resolveFeedMediaUris(
  posts: Array<{ id: string; mediaCids: string[] | null }>,
  gateway: string | null,
): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  // Сначала соберём все (postId, index, cid) и параллельно пройдёмся через пул.
  type Task = { postId: string; idx: number; cid: string };
  const tasks: Task[] = [];
  for (const p of posts) {
    if (!p.mediaCids || p.mediaCids.length === 0) continue;
    for (let i = 0; i < p.mediaCids.length; i++) {
      tasks.push({ postId: p.id, idx: i, cid: p.mediaCids[i] });
    }
  }
  // Храним разрешённые uri по postId, индексируем по idx чтобы сохранить порядок.
  const byPost: Record<string, (string | null)[]> = {};
  await runWithConcurrency(tasks, FEED_IMAGE_READ_CONCURRENCY, async (t) => {
    const uri = await resolveFeedMediaUri(t.cid, gateway);
    if (!byPost[t.postId]) byPost[t.postId] = [];
    byPost[t.postId][t.idx] = uri && uri.length > 0 ? uri : null;
  });
  for (const pid of Object.keys(byPost)) {
    const clean = byPost[pid].filter((u): u is string => !!u && u.length > 0);
    if (clean.length > 0) map[pid] = clean;
  }
  return map;
}

/**
 * Освободить kvStore от вложений поста. Вызывается при удалении поста.
 *
 * v4.32.305, три исправления сразу:
 *
 * 1. Документы не удалялись вообще — цикл шёл по mediaCids и трогал только
 *    `feed_inline_media:*`. Байты документа (до 14 МБ base64 на файл, до пяти
 *    файлов) оставались в базе до следующего запуска приложения, когда их
 *    подберёт reconcileOrphanInlineMedia. То есть содержимое удалённого поста
 *    переживало удаление — ровно то, что в v4.32.276 чинили для корзины.
 * 2. `kvSet(key, '')` вместо удаления. Строка оставалась в таблице с пустым
 *    значением; v4.32.71 завёл kvDelete именно затем, чтобы так не делать.
 * 3. Перебор по индексам находил только те слоты, что описаны в mediaCids.
 *    Если пост сохранился, а часть kvSet не прошла или mediaCids не
 *    расшифровался, лишние слоты не находились. Удаление по префиксу не
 *    зависит ни от количества, ни от читаемости строки поста.
 */
async function cleanupInlinePayloads(postId: string): Promise<void> {
  for (const prefix of [`feed_inline_media:${postId}:`, `feed_inline_doc:${postId}:`]) {
    try {
      await kvDeleteByPrefix(prefix);
    } catch (e) {
      // v4.32.47: log.warn вместо silent catch — иначе осиротевшие байты
      // невозможно диагностировать (Android disk full, SQLite lock).
      log.warn('feed_inline_cleanup_failed', {
        postId: postId.slice(0, 24),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * v4.32.24: UI-подписки на обновления ленты. FeedScreen регистрирует callback
 * через startFeedInboxListener — входящие envelope из lanCoordinator дёргают его.
 */
let onUpdateCb: (() => void) | null = null;
// v4.32.132 (AUDIT P1): race guard — flipped true in stop/rebind, cleared
// once the new profile context is committed in start/rebind. Declared here
// so receiveFeedEnvelope (below) can reference without TDZ concerns.
let feedRebinding = false;
// v4.32.133 (AUDIT P2): generation counter — incremented on every rebind so
// `receiveFeedEnvelope` can detect a profile switch that happened *during*
// its own `await parseAndVerifyFeedEnvelope` and bail out before writing
// into the new profile's DB with data meant for the old one.
let feedProfileGen = 0;

/**
 * v4.32.208 (Bridge Stage 2): in-memory dedup cache for feed envelopes.
 * Key: `${type}|${postId}|${authorDid}|${ts}`. FIFO-evicts oldest when full.
 * Suppresses double-save and mesh-gossip loops. 8192 keys ≈ ~1MB memory.
 */
const FEED_SEEN_MAX = 8192;
const feedSeenKeys = new Set<string>();
function feedSeenMarkOrHas(key: string): boolean {
  if (feedSeenKeys.has(key)) return true;
  if (feedSeenKeys.size >= FEED_SEEN_MAX) {
    const first = feedSeenKeys.values().next().value as string | undefined;
    if (first) feedSeenKeys.delete(first);
  }
  feedSeenKeys.add(key);
  return false;
}

/**
 * v4.32.213 (Audit-42 C1): fast 32-bit FNV-1a hash over envelope.data for
 * dedup-key completeness. Without it, an author can sign two envelopes with
 * identical (type,postId,authorDid,ts) but different data payloads (e.g.
 * feed_edit newText, feed_reaction emoji swap, feed_poll_vote option change)
 * — the second is silently dropped by feedSeenMarkOrHas. Collision risk per
 * author per ts is negligible because the outer key already pins the tuple.
 */
function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * v4.32.208 (Bridge Stage 2): fan out a signed feed frame (0xF0) wrapped as
 * 0xF1 relay with hops+1 to all contacts except the peer we got it from and
 * the original author. Bridges topologies (e.g. WAN sender ↔ LAN-only reader
 * via a mutual contact). Fire-and-forget; never blocks ingress.
 */
async function feedGossipRelay(
  innerFrame: Uint8Array,
  nextHops: number,
  skipDid: string,
  authorDid: string,
): Promise<void> {
  // v4.32.214 (Audit-43 H3): snapshot profile generation at entry. If a
  // profile switch completes while we await listContacts or the fan-out
  // runs, we must not leak outbound relay traffic tied to the old identity's
  // contact graph into the new profile's network session.
  const genAtEntry = feedProfileGen;
  try {
    const wrapped = wrapFeedRelay(innerFrame, nextHops);
    if (!wrapped) return;
    const contacts = await listContacts();
    if (feedRebinding || feedProfileGen !== genAtEntry) {
      log.debug('feed_gossip_relay_dropped_profile_switched');
      return;
    }
    let fanout = 0;
    // v4.32.211 (Audit-40 #2): cap fan-out at FEED_GOSSIP_FANOUT_LIMIT to
    // bound per-hop network amplification. Post mesh still converges since
    // 64 contacts × network size covers typical social graphs.
    const FEED_GOSSIP_FANOUT_LIMIT = 64;
    for (const c of contacts) {
      if (fanout >= FEED_GOSSIP_FANOUT_LIMIT) break;
      try {
        const pk = publicKeyFromB64(c.peerPublicKey);
        if (!pk) continue;
        const did = publicKeyToDidKey(pk);
        if (!did) continue;
        if (did === skipDid || did === authorDid) continue;
        void multiTransportRouter.send(wrapped, did).catch(() => { /* ignore */ });
        fanout += 1;
      } catch { /* ignore one bad contact */ }
    }
    log.info('feed_gossip_relayed', { hops: nextHops, fanout, author: authorDid.slice(-16) });
  } catch (e) {
    log.warn('feed_gossip_relay_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

function emitFeedUpdate(): void {
  try { onUpdateCb?.(); } catch { /* noop */ }
}

// v4.32.92: callback для in-app banner уведомлений о новых постах/комментариях.
// Регистрируется из App.tsx, вызывается внутри receiveFeedEnvelope.
export type FeedNotifyEvent =
  | { kind: 'post'; authorDid: string; authorName: string | null; preview: string }
  | { kind: 'comment'; authorDid: string; authorName: string | null; preview: string; postId: string };
let feedNotifyCb: ((ev: FeedNotifyEvent) => void) | null = null;
export function setFeedNotifyCallback(cb: ((ev: FeedNotifyEvent) => void) | null): void {
  feedNotifyCb = cb;
}
function emitFeedNotify(ev: FeedNotifyEvent): void {
  try { feedNotifyCb?.(ev); } catch { /* noop */ }
}

async function loadPublishQueue(): Promise<QueuedFeedItem[]> {
  const raw = await kvGet(FEED_QUEUE_KEY);
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    // v4.32.66: migrate-in-place — items с postId уже имеют байты в kvStore
    // (`feed_inline_media:<postId>:<i>`); стираем их imageBase64s чтобы убрать
    // gigant-JSON, из-за которого kvGet блокировал SQLite на 30с+.
    const arr = p as QueuedFeedItem[];
    let migrated = false;
    // v4.32.xx: агрессивная миграция — стираем imageBase64s у ВСЕХ items,
    // не только с postId. Items без postId — из pre-v4.32.29 и давно протухли
    // (TTL 14 дней; реальные items там месяцами висят с MB-сайз base64).
    for (const item of arr) {
      if (item.imageBase64s && item.imageBase64s.length > 0) {
        delete item.imageBase64s;
        migrated = true;
      }
    }
    if (migrated) {
      // v4.32.456: урезанная версия НЕ пишется здесь. Запись мимо `updateQueue`
      // — это и есть тот самый «прочитал старое, записал поверх нового», от
      // которого ушли; урезанное сохранит первая же транзакция.
      log.info('feed_queue_migrated_strip_base64_all', { count: arr.length });
    }
    return arr;
  } catch {
    return [];
  }
}

/**
 * Единственный владелец файла очереди (v4.32.456).
 *
 * Правило одно: очередь читают и записывают одной неделимой операцией, и между
 * чтением и записью не ждут ничего внешнего. Поэтому `apply` — синхронная: в неё
 * нельзя случайно вписать сетевой вызов, а значит нельзя и заново завести
 * «прочитал старое, записал поверх нового». Тому, кому нужна сеть (рассылке),
 * остаётся принести готовые решения и слить их через `mergeQueue`.
 */
let queueTx: Promise<unknown> = Promise.resolve();
async function updateQueue<T>(apply: (q: QueuedFeedItem[]) => { next: QueuedFeedItem[]; value: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const { next, value } = apply(await loadPublishQueue());
    await savePublishQueue(next);
    return value;
  };
  const started = queueTx.then(run, run);
  queueTx = started.catch(() => { /* очередь транзакций не рвётся об одну неудачу */ });
  return started;
}

async function savePublishQueue(q: QueuedFeedItem[]): Promise<void> {
  await kvSet(FEED_QUEUE_KEY, JSON.stringify(q));
  // v4.32.xx: синхронизируем cached length — getFeedPublishQueueLength()
  // читает этот маленький ключ вместо MB-сайз JSON.
  try { await kvSet(FEED_QUEUE_LEN_KEY, JSON.stringify(countByAuthor(q))); } catch { /* noop */ }
}

/**
 * Сколько постов ждёт отправки У ЭТОГО ключа (v4.32.459).
 *
 * Очередь одна на всё приложение, профилей несколько. Раньше здесь считались
 * все записи подряд, и человек видел «в очереди 2» после переключения профиля,
 * хотя оба поста принадлежали другому: «Отправить сейчас» ничего не делал,
 * а счётчик держался до TTL в 14 дней. Считаем только то, что этот ключ
 * действительно может отправить.
 *
 * v4.32.xx: читает отдельный tiny-ключ FEED_QUEUE_LEN_KEY вместо всего JSON
 * (который мог блокировать JS thread на 2+ сек из-за MB-сайз base64 изображений).
 */
export async function getFeedPublishQueueLength(pair: KeyPairBytes): Promise<number> {
  const myDid = publicKeyToDidKey(pair.publicKey);
  const cached = parseQueueCounts(await kvGet(FEED_QUEUE_LEN_KEY));
  if (cached) return sendableCount(cached, myDid);
  // Cold path: один раз прочитать полную очередь, закешировать счёт по авторам.
  const counts = countByAuthor(await loadPublishQueue());
  try { await kvSet(FEED_QUEUE_LEN_KEY, JSON.stringify(counts)); } catch { /* noop */ }
  return sendableCount(counts, myDid);
}

/** Записи очереди, которые может отправить этот ключ. */
async function myQueueItems(pair: KeyPairBytes): Promise<QueuedFeedItem[]> {
  return ownedByKey(await loadPublishQueue(), publicKeyToDidKey(pair.publicKey));
}

/** Немедленная попытка отправить очередь (кнопка «Отправить сейчас»). */
export function flushFeedQueueNow(pair: KeyPairBytes): void {
  feedRetryPair = pair;
  clearFeedRetryTimer();
  void (async () => {
    await flushFeedPublishQueue(pair);
    // v4.32.459: чужие записи не будят наш таймер повтора — отправить их мы всё
    // равно не можем, а таймер крутился бы до их TTL.
    if ((await myQueueItems(pair)).length > 0) {
      scheduleFeedPublishRetry(pair, RETRY_DELAY_MS);
    }
  })();
}

async function enqueuePendingFeedPost(pair: KeyPairBytes, data: {
  postId?: string;
  text: string;
  authorName: string;
  imageBase64s?: string[];
  imageMimes?: string[];
  /** v4.32.67: DID'ы, которым initial broadcast УЖЕ доставил пост —
   *  первый retry эти пропустит и нацелится только на недоставленных. */
  deliveredTo?: string[];
}): Promise<void> {
  // Автор берётся из ключа, которым кладут в очередь, а не из аргумента —
  // так вызывающему нечего перепутать (см. authorDid в QueuedFeedItem).
  const authorDid = publicKeyToDidKey(pair.publicKey);
  await updateQueue((q) => {
    // v4.32.29: дедупликация по postId — если retry уже в очереди, не создаём второй item.
    // v4.32.67: при дедупе мёрджим deliveredTo — если тот же пост успел доставиться новым
    // контактам с момента первого enqueue, не повторяем рассылку им.
    if (data.postId) {
      // v4.32.439: дедуп только со своими записями (и с неразмеченными старыми) —
      // иначе deliveredTo чужого профиля мёрджился бы с нашим.
      const existingIdx = q.findIndex(
        (x) => x.postId === data.postId && (x.authorDid === undefined || x.authorDid === authorDid),
      );
      if (existingIdx >= 0) {
        if (data.deliveredTo && data.deliveredTo.length > 0) {
          const merged = new Set(q[existingIdx].deliveredTo ?? []);
          for (const d of data.deliveredTo) merged.add(d);
          q[existingIdx] = { ...q[existingIdx], deliveredTo: [...merged] };
        }
        return { next: q, value: undefined };
      }
    }
    // v4.32.66: если у нас есть postId, байты медиа уже сохранены в kvStore
    // (`feed_inline_media:${postId}:${i}`) — дублировать их в queue-JSON нельзя,
    // иначе блоб разрастается до МБ и SQLite лочится на десятки секунд при каждом
    // kvGet(FEED_QUEUE_KEY). Оставляем только MIME-типы (они весят копейки) + postId.
    // Старые items без postId (из версий до v4.32.29) — продолжаем хранить base64
    // для совместимости; их постепенно выдавит MAX_QUEUE_RETRIES.
    const hasPostId = !!data.postId;
    q.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      postId: data.postId,
      text: data.text,
      authorName: data.authorName,
      authorDid,
      imageBase64s: hasPostId ? undefined : data.imageBase64s,
      imageMimes: data.imageMimes,
      deliveredTo: data.deliveredTo && data.deliveredTo.length > 0 ? [...data.deliveredTo] : undefined,
      retries: 0,
      createdAt: Date.now(),
    });
    return { next: q, value: undefined };
  });
}

/**
 * Повторная попытка публикации очереди. Экспоненциальная задержка по числу неудачных попыток первого элемента.
 * При каждом новом enqueue таймер сбрасывается, чтобы не ждать лишние 45 с.
 */
function scheduleFeedPublishRetry(pair: KeyPairBytes, delayMs: number): void {
  feedRetryPair = pair;
  // v4.32.175: монотонность. Если таймер уже стоит с бо́льшим delay (backoff),
  // не сбрасываем — новый enqueue не должен откатывать backoff к 30 с.
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void (async () => {
      const p = feedRetryPair;
      if (!p) return;
      await flushFeedPublishQueue(p);
      const q = await myQueueItems(p);
      if (q.length > 0) {
        const r = q[0]?.retries ?? 0;
        const nextDelay = Math.min(RETRY_DELAY_MS * Math.pow(2, Math.min(r, 6)), 180_000);
        scheduleFeedPublishRetry(p, nextDelay);
      }
    })();
  }, delayMs);
}

async function rebuildImageUrisFromQueue(item: QueuedFeedItem): Promise<string[] | undefined> {
  if (!item.imageBase64s?.length) return undefined;
  const uris: string[] = [];
  for (let i = 0; i < item.imageBase64s.length; i++) {
    const path = `${FileSystem.cacheDirectory ?? ''}feed_q_${item.id}_${i}.img`;
    await FileSystem.writeAsStringAsync(path, item.imageBase64s[i], {
      encoding: FileSystem.EncodingType.Base64,
    });
    uris.push(path);
  }
  return uris;
}

/**
 * Максимальное число постов, публикуемых одновременно из очереди.
 * 2 — баланс между скоростью и нагрузкой на IPFS + сеть.
 */
const FLUSH_CONCURRENCY = 2;

/**
 * Таймаут на публикацию одного поста из очереди.
 * tryPublishFeedPostComplete = IPFS upload + notifyContactsFeed; на 3G может зависнуть.
 */
const FLUSH_ITEM_TIMEOUT_MS = 20_000;

/**
 * v4.32.29: идемпотентный retry. Каждый queue-item хранит свой postId, так что
 * повторная попытка НЕ создаёт новый локальный пост, а только ре-шлёт envelope.
 * Если пост уже был удалён локально (redo не нужен) — item тихо дропаем.
 *
 * v4.32.67: targeted retry — `optsTarget?` ограничивает рассылку одним/несколькими DID'ами
 * (вызывается из presence-триггера когда контакт появился в LAN). На выходе мутирует
 * `item.deliveredTo`, добавляя свежедоставленных получателей — чтобы следующие retry
 * не спамили их повторно.
 *
 * Возвращаемое значение:
 *   - `fullyDelivered: true`  → пост доставлен ВСЕМ контактам (либо контактов 0) → item удаляется из очереди.
 *   - `fullyDelivered: false` → есть ещё недоставленные → item остаётся, ждём следующую попытку.
 *   - `foreign: true` (v4.32.439) → запись другого профиля: ничего не отправлено,
 *     item остаётся в очереди нетронутым и попытку не тратит.
 */
async function republishQueuedItem(
  pair: KeyPairBytes,
  item: QueuedFeedItem,
  optsTarget?: { onlyDids?: Set<string> },
): Promise<{ fullyDelivered: boolean; foreign?: boolean }> {
  const myDid = publicKeyToDidKey(pair.publicKey);
  // v4.32.439: проверка владельца стоит ЗДЕСЬ, в единственном месте, через которое
  // очередь вообще уходит в эфир (обычный flush и точечный flush по peer'у зовут
  // только его) — новую ветку разбора очереди уже нельзя написать в обход.
  // `foreign` для вызывающего значит «не наша запись»: её оставляют лежать как есть,
  // не отправляют и не тратят на неё попытку.
  if (typeof item.authorDid === 'string' && item.authorDid !== myDid) {
    return { fullyDelivered: false, foreign: true };
  }
  // v4.32.458: лента могла смениться, пока рассылка шла по сети. Проверка стоит
  // до любой работы с базой — и до старого пути публикации, который тоже пишет
  // пост в ленту активного профиля.
  const own = await ensureStorage();
  if (!feedStorageBelongsTo(pair)) {
    log.info('feed_queue_profile_switched_kept', { id: item.id, postId: item.postId?.slice(0, 24) ?? null });
    return { fullyDelivered: false, foreign: true };
  }

  // Если item старой версии без postId — fallback на полный путь публикации (создаст дубликат,
  // но старых items в очереди быть не должно после первого flush'а v4.32.29).
  if (!item.postId) {
    if (item.authorDid === undefined) {
      // Ни отметки автора, ни postId — опознать владельца нечем, а этот путь
      // подписывает текст и фотографии заново активным ключом. Молчим до TTL.
      log.warn('feed_queue_legacy_unowned_kept', { id: item.id });
      return { fullyDelivered: false, foreign: true };
    }
    const imageUris = await rebuildImageUrisFromQueue(item);
    const tryRes = await tryPublishFeedPostComplete(pair, {
      text: item.text,
      authorName: item.authorName,
      imageUris,
    });
    return { fullyDelivered: !!tryRes.postId };
  }

  const existing = await own.getPost(item.postId);
  if (!existing) {
    if (item.authorDid === undefined) {
      // Запись без отметки автора, и поста нет в ленте активного профиля. Это не
      // «автор удалил» — это чужая запись, которую до v4.32.439 мы бы здесь стёрли.
      log.info('feed_queue_legacy_foreign_kept', { id: item.id, postId: item.postId.slice(0, 24) });
      return { fullyDelivered: false, foreign: true };
    }
    // Пост был удалён автором локально — retry бессмысленен.
    log.info('feed_queue_postId_missing_drop', { id: item.id, postId: item.postId.slice(0, 24) });
    return { fullyDelivered: true }; // возвращаем "успех" чтобы item удалился из очереди
  }

  // v4.32.47: диагностический лог возраста retry — помогает понять сколько пост
  // жил в очереди и с каким ts он уйдёт получателям. Сам ts envelope'а намеренно
  // берётся от оригинала (existing.timestamp) — иначе у получателей при retry
  // через 3 часа пост бы прыгал на верх ленты «будущим» timestamp'ом.
  const retryAgeMs = Date.now() - existing.timestamp;
  log.info('feed_queue_retry_age', {
    postId: item.postId.slice(0, 24),
    retries: item.retries,
    ageMs: retryAgeMs,
  });

  // Собираем envelope с сохранёнными данными (тот же postId, тот же ts).
  // v4.32.66: читаем base64 медиа напрямую из kvStore (`feed_inline_media:<postId>:<i>`),
  // а не из item.imageBase64s. Это снимает нагрузку с очереди: теперь queue-JSON весит
  // ~1KB на item вместо нескольких МБ, и `getFeedPublishQueueLength()` (60с tick в UI)
  // больше не лочит SQLite на десятки секунд. Fallback на item.imageBase64s оставлен
  // для старых items из версий до v4.32.66.
  let media: string[] = [];
  let mediaMime: string[] = [];
  if (existing.mediaCids && existing.mediaCids.length > 0) {
    for (let i = 0; i < existing.mediaCids.length; i++) {
      const cid = existing.mediaCids[i];
      // Парсим inline-CID формата `inline:<mime>;<i>:<postId>`.
      const m = /^inline:([^;]+);\d+:/.exec(cid);
      const mime = m ? m[1] : (item.imageMimes?.[i] ?? 'image/jpeg');
      try {
        const b64 = await kvGetInlineAttachment(`feed_inline_media:${item.postId}:${i}`);
        if (b64 && b64.length > 0) {
          media.push(b64);
          mediaMime.push(mime);
        }
      } catch (e) {
        log.warn('feed_queue_media_read_failed', {
          postId: item.postId.slice(0, 24), idx: i,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  // Backward-compat: если kvStore пуст (старый item), используем payload из самого item.
  if (media.length === 0 && item.imageBase64s && item.imageBase64s.length > 0) {
    media = item.imageBase64s;
    mediaMime = item.imageMimes ?? [];
  }
  // v4.32.554: очередь хранит только текст и mime, а тип записи узнаётся из
  // самой строки ленты. Раньше репост из очереди уходил обычным постом: у
  // получателя пропадала ссылка на оригинал и имя его автора. Теперь по
  // repostOf собирается тот же конверт, что и при первой отправке.
  const repostOf = typeof existing.repostOf === 'string' && existing.repostOf.length > 0
    ? existing.repostOf
    : null;
  const repostAuthorDid = typeof existing.repostAuthorDid === 'string' && existing.repostAuthorDid.length > 0
    ? existing.repostAuthorDid
    : null;
  let payload: FeedEnvelopePayload;
  if (repostOf && repostAuthorDid) {
    const repostData: FeedRepostData = {
      kind: 'repost',
      text: existing.text,
      authorName: item.authorName,
      originalPostId: repostOf,
      originalAuthorDid: repostAuthorDid,
      originalAuthorName: existing.repostAuthorName ?? null,
      originalText: existing.text,
      originalMedia: existing.mediaCids && existing.mediaCids.length > 0 ? existing.mediaCids : null,
      originalMediaBase64: media.length > 0 ? media : undefined,
      originalMediaBase64Mime: media.length > 0 ? mediaMime : undefined,
    };
    payload = {
      type: 'feed_repost',
      postId: item.postId,
      authorDid: myDid,
      ts: existing.timestamp,
      data: repostData,
    };
  } else {
    const postData: FeedPostData = {
      kind: 'post',
      text: item.text,
      authorName: item.authorName,
      media: media.length > 0 ? media : undefined,
      mediaMime: media.length > 0 ? mediaMime : undefined,
    };
    payload = {
      type: 'feed_post',
      postId: item.postId,
      authorDid: myDid,
      ts: existing.timestamp, // важно: не новый Date.now — иначе у контактов дубликат во времени
      data: postData,
    };
  }
  // v4.32.67: передаём skip/only-фильтры чтобы не стрелять повторно в уже-доставленных.
  const skipDids = new Set(item.deliveredTo ?? []);
  const broadcastOpts: { skipDids?: Set<string>; onlyDids?: Set<string> } = {};
  if (optsTarget?.onlyDids) {
    // Вычитаем из onlyDids тех, кому уже доставили.
    const filtered = new Set<string>();
    for (const d of optsTarget.onlyDids) if (!skipDids.has(d)) filtered.add(d);
    if (filtered.size === 0) return { fullyDelivered: false }; // всем из target'а уже доставлено
    broadcastOpts.onlyDids = filtered;
  } else if (skipDids.size > 0) {
    broadcastOpts.skipDids = skipDids;
  }

  const res = await signAndBroadcastFeedEnvelope(pair, payload, broadcastOpts);
  if (!res) return { fullyDelivered: false };

  // Накопительный учёт доставленных адресатов.
  if (res.delivered.successDids.length > 0) {
    const acc = new Set(item.deliveredTo ?? []);
    for (const d of res.delivered.successDids) acc.add(d);
    item.deliveredTo = [...acc];
  }

  // Проверяем: доставили ли ВСЕМ текущим контактам? Если да — item можно дропать.
  try {
    const contacts = await listContacts();
    const allContactDids = new Set<string>();
    for (const c of contacts) {
      // v4.32.427: try/catch здесь был мёртвым — Buffer.from не бросает, а
      // publicKeyToDidKey кодирует любое число байт. Порченый контакт добавлял
      // в набор DID, которого не существует, и «доставлено» никогда не сходилось.
      const peerDid = didFromPubB64(c.peerPublicKey);
      if (peerDid) allContactDids.add(peerDid);
    }
    const delivered = new Set(item.deliveredTo ?? []);
    let remaining = 0;
    for (const d of allContactDids) if (!delivered.has(d)) remaining += 1;

    // Edge-case: контактов нет → пост локальный, доставлять нечего.
    if (allContactDids.size === 0) return { fullyDelivered: true };

    log.info('feed_queue_retry_result', {
      postId: item.postId.slice(0, 24),
      deliveredNow: res.delivered.successDids.length,
      deliveredTotal: delivered.size,
      remaining,
      contacts: allContactDids.size,
    });
    return { fullyDelivered: remaining === 0 };
  } catch {
    // Если не смогли посчитать — используем старую логику: хоть один успех = продолжаем, 0 = пробуем ещё.
    return { fullyDelivered: res.delivered.success > 0 && !optsTarget };
  }
}

/**
 * Отправить очередь неотправленных постов. С v4.32.29 — идемпотентный: без создания
 * дубликатов постов у автора.
 */
// v4.32.172: мьютекс. Ранее flush мог быть вызван одновременно из: (a) FeedScreen
// focus, (b) retry-таймер, (c) mDNS peer discovery (flushFeedQueueForPeer), (d)
// networkReconnectWatcher. Каждая ветка делала loadPublishQueue → мутация →
// savePublishQueue(remaining). Последний writer выигрывал → потерянные
// deliveredTo-апдейты (уже-доставленные получали спам), двойной инкремент
// retries, TTL-дропы могли возвращаться.
// v4.32.456: пункт (c) на самом деле шёл мимо мьютекса — комментарий выше
// утверждал обратное полторы сотни версий. Теперь гейт один на все рассылки, и
// точечная рассылка по пиру не отбрасывается (она нужна ради «доставки на
// пробуждение»), а встаёт в очередь за общей.
/** Идёт какая-нибудь рассылка очереди: двух одновременно быть не должно — они
 *  разошлют одни и те же конверты дважды. */
let flushBusy: Promise<void> | null = null;
/** Общая рассылка вдобавок склеивается: пять триггеров подряд — одна рассылка. */
let generalFlush: Promise<void> | null = null;

function runFlushExclusively(run: () => Promise<void>): Promise<void> {
  const prev = flushBusy ?? Promise.resolve();
  const started = prev.then(run, run);
  flushBusy = started.catch(() => { /* цепочка не рвётся об одну неудачу */ });
  return started;
}

/**
 * Записать итоги рассылки, не затирая то, что попало в очередь пока она шла.
 *
 * Рассылка держит свой снимок очереди десятки секунд; запись этого снимка
 * поверх файла стирала посты, добавленные за это время, — молча и навсегда
 * (см. feedQueueCommit.ts). Поэтому она приносит решения по своим записям, а
 * очередь перечитывается в момент записи.
 */
async function commitFlushOutcomes(
  snapshot: readonly QueuedFeedItem[],
  outcomes: readonly (QueuedFeedItem | null)[],
): Promise<void> {
  const decisions = new Map<string, QueueDecision<QueuedFeedItem>>();
  snapshot.forEach((item, i) => decisions.set(item.id, outcomes[i] ?? null));
  await updateQueue((q) => ({ next: mergeQueue(q, decisions), value: undefined }));
}

export async function flushFeedPublishQueue(pair: KeyPairBytes): Promise<void> {
  if (generalFlush) return generalFlush;
  const started = runFlushExclusively(() => _flushFeedPublishQueueImpl(pair));
  generalFlush = started;
  void started.catch(() => { /* исход интересует вызывающего, не гейт */ }).then(() => {
    if (generalFlush === started) generalFlush = null;
  });
  return started;
}

async function _flushFeedPublishQueueImpl(pair: KeyPairBytes): Promise<void> {
  const list = await loadPublishQueue();
  if (list.length === 0) return;

  const now = Date.now();
  const outcomes = await runWithConcurrency(
    list,
    FLUSH_CONCURRENCY,
    async (item): Promise<QueuedFeedItem | null> => {
      // v4.32.67: TTL dead-letter — пост в очереди дольше 14 дней дропается,
      // даже если retry'ев ещё не исчерпано (MAX_QUEUE_RETRIES=200 — просто safety cap).
      if (now - item.createdAt > FEED_QUEUE_TTL_MS) {
        log.warn('feed_queue_ttl_dropped', {
          id: item.id,
          postId: item.postId?.slice(0, 24) ?? null,
          ageMs: now - item.createdAt,
          retries: item.retries,
        });
        return null;
      }
      try {
        // v4.32.67: republishQueuedItem возвращает { fullyDelivered }. Если хотя бы
        // один контакт ещё не получил — item остаётся в очереди до следующего retry
        // или до presence-триггера (mDNS onPeerDiscovered → flushFeedQueueForPeer).
        const result = await Promise.race([
          republishQueuedItem(pair, item),
          new Promise<{ fullyDelivered: boolean; foreign?: boolean }>((_, reject) =>
            setTimeout(
              () => reject(new Error(`flush_item_timeout_${FLUSH_ITEM_TIMEOUT_MS}ms`)),
              FLUSH_ITEM_TIMEOUT_MS,
            ),
          ),
        ]);

        // Чужая запись ждёт своего профиля: не отправлена и попытку не потратила.
        if (result.foreign) return item;

        if (result.fullyDelivered) {
          log.info('feed_queue_item_published', {
            id: item.id,
            postId: item.postId?.slice(0, 24) ?? null,
            deliveredTo: item.deliveredTo?.length ?? 0,
          });
          return null;
        }

        // Преобразуем next: spread копирует всё, включая мутированное republishQueuedItem'ом
        // поле `deliveredTo` — следующие retry не будут спамить уже-доставленных.
        const next: QueuedFeedItem = { ...item, retries: item.retries + 1 };
        if (next.retries >= MAX_QUEUE_RETRIES) {
          log.warn('feed_queue_item_dropped_max_retries', {
            id: item.id,
            retries: next.retries,
            deliveredTo: next.deliveredTo?.length ?? 0,
          });
          return null;
        }
        return next;
      } catch (e) {
        log.warn('feed_queue_item_error', {
          id: item.id,
          err: e instanceof Error ? e.message : String(e),
        });
        const next: QueuedFeedItem = { ...item, retries: item.retries + 1 };
        return next.retries < MAX_QUEUE_RETRIES ? next : null;
      }
    },
  );

  await commitFlushOutcomes(list, outcomes);
}

/**
 * v4.32.67: targeted flush — вызывается при mDNS discovery (contact онлайн в LAN).
 * Для каждого item в очереди делает retry, нацеленный ТОЛЬКО на этот peerDid.
 * Это даёт «доставку на пробуждение»: контакт подключился к Wi-Fi → сразу получает
 * посты, пропущенные за время оффлайна (до 14 дней).
 */
export async function flushFeedQueueForPeer(pair: KeyPairBytes, peerDid: string): Promise<void> {
  return runFlushExclusively(() => _flushFeedQueueForPeerImpl(pair, peerDid));
}

async function _flushFeedQueueForPeerImpl(pair: KeyPairBytes, peerDid: string): Promise<void> {
  const list = await loadPublishQueue();
  if (list.length === 0) return;

  const onlyDids = new Set<string>([peerDid]);
  const now = Date.now();
  const outcomes = await runWithConcurrency(
    list,
    FLUSH_CONCURRENCY,
    async (item): Promise<QueuedFeedItem | null> => {
      if (now - item.createdAt > FEED_QUEUE_TTL_MS) {
        log.warn('feed_queue_ttl_dropped', {
          id: item.id, postId: item.postId?.slice(0, 24) ?? null,
          ageMs: now - item.createdAt, retries: item.retries,
        });
        return null;
      }
      // Уже доставлено этому peer'у? Пропускаем без retry.
      if (item.deliveredTo && item.deliveredTo.includes(peerDid)) {
        return item;
      }
      try {
        const result = await Promise.race([
          republishQueuedItem(pair, item, { onlyDids }),
          new Promise<{ fullyDelivered: boolean; foreign?: boolean }>((_, reject) =>
            setTimeout(
              () => reject(new Error(`peer_flush_timeout_${FLUSH_ITEM_TIMEOUT_MS}ms`)),
              FLUSH_ITEM_TIMEOUT_MS,
            ),
          ),
        ]);
        // fullyDelivered here проверяет ВСЕХ контактов — для targeted retry это оверкилл,
        // но корректно: если этот peer был последним недоставленным, дропаем item.
        if (result.fullyDelivered) {
          log.info('feed_queue_item_published_via_peer', {
            id: item.id, postId: item.postId?.slice(0, 24) ?? null, peerDid: peerDid.slice(0, 24),
          });
          return null;
        }
        // item.deliveredTo уже обновлён мутацией внутри republishQueuedItem — spread сохранит.
        return { ...item };
      } catch (e) {
        log.warn('feed_queue_peer_flush_error', {
          id: item.id, peerDid: peerDid.slice(0, 24),
          err: e instanceof Error ? e.message : String(e),
        });
        return item; // оставляем как было, без инкремента retries (таргет-ретрай)
      }
    },
  );

  await commitFlushOutcomes(list, outcomes);
}

/**
 * v4.32.24: публикация через multiTransportRouter (LAN+WebRTC), не IPFS.
 * Возвращает locid (стабильный ID поста = post.id в БД) при успешной рассылке
 * ХОТЯ БЫ одному контакту ИЛИ если контактов нет (локальный пост). При провале
 * всех транспортов возвращает null — caller кладёт в очередь.
 * v4.32.29: опционально заполняет `outMedia` — caller использует их при enqueue
 * (идемпотентный retry без повторного чтения файлов).
 */
type TryPublishResult = {
  postId: string | null;
  tooLarge?: boolean;
  // v4.32.48: число фото, которые были выбраны, но отброшены из-за превышения
  // FEED_MEDIA_MAX_BASE64_BYTES. UI покажет предупреждение пользователю.
  mediaDropped?: number;
};

async function tryPublishFeedPostComplete(
  pair: KeyPairBytes,
  opts: { text: string; imageUris?: string[]; authorName?: string; documents?: FeedDocumentInput[] },
  outSavedState?: { postId?: string; media?: string[]; mediaMime?: string[] },
): Promise<TryPublishResult> {
  const text = opts.text.trim();
  log.info('feed_try_publish_enter', {
    textLen: text.length,
    textPreview: text.slice(0, 80),
    imageUrisLen: opts.imageUris?.length ?? 0,
    docsLen: opts.documents?.length ?? 0,
  });
  if (!text && (!opts.imageUris || opts.imageUris.length === 0) && (!opts.documents || opts.documents.length === 0)) {
    log.warn('feed_try_publish_empty');
    return { postId: null };
  }
  // v4.32.65: явный лимит на длину текста поста. Хотя envelope pre-check (SAFE_LIMIT=1.84MB)
  // ловит гиганты, cap в 10K символов даёт юзеру понятную ошибку до I/O.
  if (text.length > FEED_POST_MAX_CHARS) {
    log.warn('feed_try_publish_text_too_long', { len: text.length, limit: FEED_POST_MAX_CHARS });
    return { postId: null, tooLarge: true };
  }
  // Параллельное чтение медиа в base64 — важно для UX (иначе 4 фото × 300ms последовательно = 1.2с).
  const mediaResults =
    opts.imageUris && opts.imageUris.length > 0
      ? await runWithConcurrency(opts.imageUris, FEED_IMAGE_READ_CONCURRENCY, (uri) => readMediaAsBase64(uri))
      : [];
  const media: string[] = [];
  const mediaMime: string[] = [];
  let mediaDropped = 0;
  for (const m of mediaResults) {
    if (m) {
      media.push(m.b64);
      mediaMime.push(m.mime);
    } else {
      mediaDropped += 1;
    }
  }
  // v4.32.48: если все фото превысили лимит — не публикуем пустой пост. Пропускаем
  // только если пользователь собирался отправить медиа + текст, но медиа не прошло.
  if (mediaDropped > 0 && media.length === 0 && !text && (!opts.documents || opts.documents.length === 0)) {
    log.warn('feed_publish_all_media_too_large', { dropped: mediaDropped });
    return { postId: null, tooLarge: true, mediaDropped };
  }

  // v4.32.48: чтение документов. Ограничение FEED_DOC_MAX_PER_POST + per-doc size guard.
  const docs: { name: string; mime: string; size: number; b64: string }[] = [];
  if (opts.documents && opts.documents.length > 0) {
    const limited = opts.documents.slice(0, FEED_DOC_MAX_PER_POST);
    for (const input of limited) {
      const read = await readDocumentAsBase64(input);
      if (read) docs.push(read);
    }
  }

  const myDid = publicKeyToDidKey(pair.publicKey);
  const name = opts.authorName?.trim() || 'Вы';
  const postId = generateFeedPostId();
  const ts = Date.now();

  // v4.32.47: pre-check размера envelope ДО сохранения + подписи (экономия CPU на
  // сигнатуре и UX — понятная ошибка пользователю, не silent «ок, но не доставлено»).
  // FEED_ENVELOPE_MAX_BYTES = 2MB; оценка грубая (base64 уже считается в байтах,
  // +overhead JSON/signature ~512B). Если превышаем 90% лимита — отклоняем.
  const SAFE_LIMIT = Math.floor(2 * 1024 * 1024 * 0.9); // 1.84 MB
  const estimatedBytes =
    text.length * 2 /* UTF-8 worst case для кириллицы */ +
    media.reduce((acc, b) => acc + b.length, 0) /* base64 ≈ байт */ +
    docs.reduce((acc, d) => acc + d.b64.length, 0) /* v4.32.48: документы */ +
    1024; /* overhead подписи + JSON-обвязки */
  if (estimatedBytes > SAFE_LIMIT) {
    log.warn('feed_publish_payload_too_large', {
      estimatedBytes,
      limit: SAFE_LIMIT,
      mediaN: media.length,
      docsN: docs.length,
    });
    // v4.32.48: вернуть tooLarge=true — caller покажет конкретную ошибку вместо generic.
    return { postId: null, tooLarge: true, mediaDropped };
  }

  // 1. Сохранить локально НЕМЕДЛЕННО — оптимистично. Пост виден у автора даже если
  //    доставка провалится; ретрай будет попыткой довезти до контактов.
  const s = await ensureStorage();
  await s.savePost({
    id: postId,
    authorDid: myDid,
    authorName: name,
    text,
    mediaCids: media.length > 0 ? media.map((_, i) => `inline:${mediaMime[i]};${i}:${postId}`) : null,
    timestamp: ts,
    read: 1,
    cid: null,
    documents: docs.length > 0 ? docs.map((d) => ({ name: d.name, mime: d.mime, size: d.size })) : null,
  });

  // v4.32.29: сохраняем base64 для рендера в kvStore — у автора был баг, inline media не отрисовывалось
  // (cid начинается с `inline:`, но рендер шёл через IPFS gateway URL). Теперь автор видит своё медиа
  // так же, как получатели.
  // v4.32.133 (AUDIT P1): if any inline-media write fails mid-loop, the post
  // is already in the DB but media is incomplete — UI would render the post
  // and then hit nulls on missing `feed_inline_media:*` keys. Roll back the
  // post + any already-written media so the author never sees a half-post.
  // v4.32.146 (AUDIT P2 S4): extend the rollback to inline-doc slots. Previously
  // doc writes only warned on failure, leaving the post persisted with metadata
  // but no backing `feed_inline_doc:*` bytes — broken doc tiles forever. Both
  // loops now share one `written[]` list so ANY failure purges ALL prior writes.
  if (media.length > 0 || docs.length > 0) {
    const written: string[] = [];
    try {
      // v4.32.341: этот откат не срабатывал никогда. kvSet гасит собственную
      // ошибку и возвращает void — бросать было нечему, и пост оставался в базе
      // с записью о фотографии, которой на диске нет. kvSetInlineAttachment
      // сообщает, легло ли значение, и отказ наконец доходит до catch ниже.
      for (let i = 0; i < media.length; i++) {
        const k = `feed_inline_media:${postId}:${i}`;
        if (!(await kvSetInlineAttachment(k, media[i]))) {
          throw new Error(`inline media write failed at ${i}`);
        }
        written.push(k);
      }
      for (let i = 0; i < docs.length; i++) {
        const k = `feed_inline_doc:${postId}:${i}`;
        if (!(await kvSetInlineAttachment(k, docs[i].b64))) {
          throw new Error(`inline doc write failed at ${i}`);
        }
        written.push(k);
      }
    } catch (e) {
      log.warn('feed_inline_write_failed', {
        postId: postId.slice(0, 24),
        written: written.length,
        total: media.length + docs.length,
        mediaN: media.length,
        docsN: docs.length,
        err: e instanceof Error ? e.message : String(e),
      });
      const failedKeys: string[] = [];
      for (const k of written) {
        try { await kvDelete(k); } catch { failedKeys.push(k); }
      }
      if (failedKeys.length > 0) {
        log.error('feed_inline_rollback_incomplete', {
          postId: postId.slice(0, 24),
          remaining: failedKeys.length,
        });
      }
      try { await s.deletePost(postId); } catch { /* best effort */ }
      throw e;
    }
  }

  // v4.32.29: выдаём caller'у postId/media для idempotent enqueue (retry без дубликатов).
  if (outSavedState) {
    outSavedState.postId = postId;
    outSavedState.media = media;
    outSavedState.mediaMime = mediaMime;
  }

  // 2. Разослать envelope контактам через multiTransportRouter.
  const postData: FeedPostData = {
    kind: 'post',
    text,
    authorName: name,
    media: media.length > 0 ? media : undefined,
    mediaMime: media.length > 0 ? mediaMime : undefined,
    documents: docs.length > 0
      ? docs.map((d) => ({ name: d.name, mime: d.mime, size: d.size, data: d.b64 }))
      : undefined,
  };
  const payload: FeedEnvelopePayload = {
    type: 'feed_post',
    postId,
    authorDid: myDid,
    ts,
    data: postData,
  };
  // v4.32.554: без сети рассылку не начинаем — ответ известен заранее, а пост
  // уже лежит в базе. Возвращаем postId: null, и вызывающий положит запись в
  // очередь повторов ровно тем же путём, что и при неудачной доставке.
  const online = await checkOnlineWrite();
  if (!shouldAttemptBroadcast(online.ok)) {
    log.info('feed_publish_queued_offline', {
      postId: postId.slice(0, 24),
      reachability: online.reachability,
      disposition: dispositionOf('skipped-offline'),
    });
    return { postId: null, mediaDropped };
  }

  const result = await signAndBroadcastFeedEnvelope(pair, payload);
  if (!result) {
    // Envelope слишком большой или подпись провалилась — откатывать локальный пост НЕ будем,
    // но дадим caller'у понять что ретрай имеет смысл только если проблема временная.
    log.warn('feed_publish_envelope_null', { postId });
    return { postId: null, mediaDropped };
  }

  // Успешной считаем публикацию если контактов нет (локальная лента) или хоть один транспорт сработал.
  const contactsCount = result.delivered.total;
  const attempt = classifyBroadcast(true, contactsCount, result.delivered.success);
  if (attempt === 'no-recipients') {
    log.info('feed_publish_local_only', { postId });
    return { postId, mediaDropped };
  }
  if (attempt !== 'failed') {
    // v4.32.47: partial delivery → ставим в очередь для последующего ретрая.
    // enqueuePendingFeedPost дедуплицирует по postId; republishQueuedItem идемпотентен
    // (то же postId + тот же ts). Получатели дропнут дубль через `INSERT OR IGNORE`
    // в savePost, но те кто пропустил первый broadcast — получат.
    if (needsRetryQueue(attempt)) {
      log.info('feed_publish_partial', {
        postId: postId.slice(0, 24),
        delivered: result.delivered.success,
        total: contactsCount,
      });
      try {
        await enqueuePendingFeedPost(pair, {
          postId,
          text,
          authorName: name,
          imageBase64s: media.length > 0 ? media : undefined,
          imageMimes: media.length > 0 ? mediaMime : undefined,
          // v4.32.67: передаём список успешно-доставленных DID'ов — следующий retry
          // нацелится только на недоставленных, без повторных envelope к онлайн-контактам.
          deliveredTo: result.delivered.successDids,
        });
        // Запускаем retry в фоне — caller получит postId как успех.
        scheduleFeedPublishRetry(pair, RETRY_DELAY_MS);
      } catch (e) {
        log.warn('feed_publish_partial_enqueue_failed', { err: e instanceof Error ? e.message : String(e) });
      }
    } else {
      log.info('feed_publish_ok', { postId: postId.slice(0, 24), delivered: result.delivered.success, total: contactsCount });
    }
    return { postId, mediaDropped };
  }
  log.warn('feed_publish_no_delivery', { postId, contacts: contactsCount });
  return { postId: null, mediaDropped };
}

/**
 * Опубликовать пост и разослать через multiTransportRouter.
 * При полном сбое доставки — пост ставится в очередь, попытки продолжаются по экспоненте.
 * Локально пост уже сохранён внутри tryPublishFeedPostComplete, даже если вернули null —
 * автор увидит его в своей ленте сразу.
 */
export async function publishFeedPost(
  pair: KeyPairBytes,
  opts: { text: string; imageUris?: string[]; authorName?: string; documents?: FeedDocumentInput[] }
): Promise<PublishFeedResult> {
  // v4.32.554: проверка сети стояла здесь, до всякой записи, и набранный без
  // интернета пост исчезал вместе с фотографиями — при том, что ниже уже была
  // очередь повторов ровно на этот случай. Теперь пост всегда сохраняется
  // локально, а сеть спрашивают у шага рассылки.
  const text = opts.text.trim();
  log.info('feed_publish_enter', {
    textLen: text.length,
    imageUrisLen: opts.imageUris?.length ?? 0,
    docsLen: opts.documents?.length ?? 0,
    hasPairSecret: !!pair?.secretKey,
  });
  if (!text
      && (!opts.imageUris || opts.imageUris.length === 0)
      && (!opts.documents || opts.documents.length === 0)) {
    log.warn('feed_publish_empty_input');
    return { ok: false, reason: 'empty' };
  }
  // v4.32.29: outSavedState ловит postId+media, сохранённые внутри tryPublish. Даже
  // если broadcast провалился, пост уже в SQLite — для retry достаточно переиспользовать
  // эти данные, а не перечитывать файлы (авто-дубликаты устранены).
  const savedState: { postId?: string; media?: string[]; mediaMime?: string[] } = {};
  const tryResult = await tryPublishFeedPostComplete(pair, opts, savedState);
  log.info('feed_publish_complete', { postIdShort: tryResult.postId?.slice(0, 24) ?? null, ok: !!tryResult.postId, tooLarge: !!tryResult.tooLarge });
  // v4.32.48: если пост отказан из-за размера — не ставим в очередь (retry бесполезен),
  // возвращаем reason='too_large' чтобы UI показал конкретный Alert.
  if (tryResult.tooLarge) {
    return { ok: false, reason: 'too_large', mediaDropped: tryResult.mediaDropped };
  }
  if (tryResult.postId) {
    emitFeedUpdate();
    return { ok: true, cid: tryResult.postId, mediaDropped: tryResult.mediaDropped };
  }
  try {
    await enqueuePendingFeedPost(pair, {
      postId: savedState.postId,
      text: opts.text,
      authorName: opts.authorName?.trim() || 'Вы',
      imageBase64s: savedState.media,
      imageMimes: savedState.mediaMime,
    });
    scheduleFeedPublishRetry(pair, RETRY_DELAY_MS);
    emitFeedUpdate();
    // v4.32.554: mediaDropped доносим и здесь — иначе человек, у которого часть
    // фотографий не влезла, узнавал об этом только при удачной отправке.
    return { ok: true, queued: true, mediaDropped: tryResult.mediaDropped };
  } catch (e) {
    log.warn('feed_enqueue_failed', { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, reason: 'other' };
  }
}

/**
 * Добавить реакцию локально и разослать FeedEnvelope контактам.
 * v4.32.24: сигнатура расширена до (pair, postId, emoji) — нужен secretKey для подписи.
 * Существующий вариант (postId, emoji, myDid) оставлен через overload для обратной
 * совместимости, но требует дополнительный pair (передаётся через setFeedSigningPair).
 */
export async function addAndBroadcastReaction(
  pair: KeyPairBytes,
  postId: string,
  emoji: string,
): Promise<void> {
  // v4.32.553: реакция — запись в свою базу плюс рассылка. Проверка сети
  // стояла перед записью и отменяла обе половины сразу: в Wi-Fi без интернета
  // нельзя было поставить эмодзи даже себе. Очереди повторов у реакции на
  // пост нет, поэтому оффлайн — это 'write-only'.
  const myDid = publicKeyToDidKey(pair.publicKey);
  // Save locally first
  const s = await ensureStorage();
  await s.addReaction(postId, emoji, myDid);
  emitFeedUpdate();

  const online = await checkOnlineWrite();
  if (!shouldAttemptBroadcast(online.ok)) {
    log.info('feed_reaction_local_only', { action: offlineAction('local-first', false) });
    return;
  }

  const data: FeedReactionData = { kind: 'reaction', emoji };
  const payload: FeedEnvelopePayload = {
    type: 'feed_reaction',
    postId,
    authorDid: myDid,
    ts: Date.now(),
    data,
  };
  await signAndBroadcastFeedEnvelope(pair, payload);
}

/**
 * Репост чужого поста — своя локальная запись + envelope feed_repost.
 * v4.32.24: без IPFS. repostOf = id оригинального поста, repostAuthorDid — автор оригинала.
 */
export async function publishRepost(
  pair: KeyPairBytes,
  opts: {
    originalPost: FeedPostRow;
    authorName: string;
  }
): Promise<PublishFeedResult> {
  // v4.32.554: репост терялся без сети так же, как обычный пост. Запись
  // делается всегда, а рассылка — по обстоятельствам.
  const myDid = publicKeyToDidKey(pair.publicKey);
  const { originalPost, authorName } = opts;
  const repostText = originalPost.text;
  const newPostId = generateFeedPostId();
  const ts = Date.now();

  // v4.32.29: читаем base64 медиа оригинала из kvStore и копируем под новый postId.
  // Без этого репост терял картинку как только оригинал удалялся.
  const origCids = originalPost.mediaCids ?? [];
  const mediaBase64s: string[] = [];
  const mediaMimes: string[] = [];
  const newMediaCids: string[] = [];
  for (let i = 0; i < origCids.length; i++) {
    const c = origCids[i];
    if (!c?.startsWith('inline:')) {
      // Legacy IPFS CID — переиспользуем как есть; байты недоступны.
      newMediaCids.push(c);
      continue;
    }
    // parse inline:<mime>;<origIdx>:<origPostId>
    const rest = c.slice('inline:'.length);
    const semi = rest.indexOf(';');
    if (semi < 0) continue;
    const mime = rest.slice(0, semi);
    const afterSemi = rest.slice(semi + 1);
    const colon = afterSemi.indexOf(':');
    if (colon < 0) continue;
    const origIdx = afterSemi.slice(0, colon);
    const origPostId = afterSemi.slice(colon + 1);
    const b64 = await kvGetInlineAttachment(`feed_inline_media:${origPostId}:${origIdx}`);
    if (!b64) continue;
    const newI = mediaBase64s.length;
    mediaBase64s.push(b64);
    mediaMimes.push(mime);
    const newCid = `inline:${mime};${newI}:${newPostId}`;
    newMediaCids.push(newCid);
    await kvSetInlineAttachment(`feed_inline_media:${newPostId}:${newI}`, b64);
  }

  // Локально сохранить запись-репост.
  const s = await ensureStorage();
  await s.savePost({
    id: newPostId,
    authorDid: myDid,
    authorName,
    text: repostText,
    mediaCids: newMediaCids.length > 0 ? newMediaCids : null,
    timestamp: ts,
    read: 1,
    cid: null,
    repostOf: originalPost.cid ?? originalPost.id,
    repostAuthorName: originalPost.authorName ?? null,
    repostAuthorDid: originalPost.authorDid,
  });

  const data: FeedRepostData = {
    kind: 'repost',
    text: repostText,
    authorName,
    originalPostId: originalPost.cid ?? originalPost.id,
    originalAuthorDid: originalPost.authorDid,
    originalAuthorName: originalPost.authorName ?? null,
    originalText: originalPost.text,
    originalMedia: newMediaCids.length > 0 ? newMediaCids : null,
    originalMediaBase64: mediaBase64s.length > 0 ? mediaBase64s : undefined,
    originalMediaBase64Mime: mediaMimes.length > 0 ? mediaMimes : undefined,
  };
  const payload: FeedEnvelopePayload = {
    type: 'feed_repost',
    postId: newPostId,
    authorDid: myDid,
    ts,
    data,
  };
  const online = await checkOnlineWrite();
  const result = shouldAttemptBroadcast(online.ok)
    ? await signAndBroadcastFeedEnvelope(pair, payload)
    : null;
  const attempt = result
    ? classifyBroadcast(true, result.delivered.total, result.delivered.success)
    : classifyBroadcast(shouldAttemptBroadcast(online.ok), 0, 0);
  if (shouldAttemptBroadcast(online.ok) && !result) {
    // Конверт не собрался — репост в ленте есть, но повторять нечего.
    log.warn('feed_repost_envelope_null', { postId: newPostId.slice(0, 24) });
    emitFeedUpdate();
    return { ok: false };
  }

  emitFeedUpdate();
  if (needsRetryQueue(attempt)) {
    // v4.32.554: репост кладётся в ту же очередь, что и пост. Пересобрать из
    // неё именно репост-конверт умеет republishQueuedItem — по полю repostOf
    // сохранённой строки.
    log.info('feed_repost_queued', {
      postId: newPostId.slice(0, 24),
      attempt,
      reachability: online.reachability,
    });
    try {
      await enqueuePendingFeedPost(pair, {
        postId: newPostId,
        text: repostText,
        authorName,
        imageMimes: mediaMimes.length > 0 ? mediaMimes : undefined,
        deliveredTo: result?.delivered.successDids,
      });
      scheduleFeedPublishRetry(pair, RETRY_DELAY_MS);
    } catch (e) {
      log.warn('feed_repost_enqueue_failed', { err: e instanceof Error ? e.message : String(e) });
    }
    return { ok: true, cid: newPostId, queued: true };
  }
  log.info('feed_repost_ok', { postId: newPostId.slice(0, 24), delivered: result?.delivered.success ?? 0 });
  return { ok: true, cid: newPostId };
}

/**
 * Страница ленты либо `null`, если прочитать не удалось (v4.32.528).
 *
 * Раньше здесь возвращался пустой массив, и для вызывающего секундная
 * блокировка SQLite выглядела как «постов нет»: экран стирал всё, до чего
 * человек долистал, и отключал подгрузку. Подробности — в docblock
 * `readResult.ts`; тип обязан заставлять проверять исход.
 */
export async function loadFeedPosts(limit = 50, offset = 0): Promise<DbRead<FeedPostRow>> {
  try {
    const s = await ensureStorage();
    return await s.getFeed(limit, offset);
  } catch (e) {
    log.warn('feed_load_posts_failed', {
      err: e instanceof Error ? e.message : String(e),
      limit,
      offset,
    });
    return null;
  }
}

/**
 * Пометить запись прочитанной. `true` — пометка легла в базу.
 *
 * v4.32.537: раньше отсюда возвращалось `void`, а любая ошибка молча гасилась.
 * Экран при этом успевал записать запись в свой список «уже помечено» ДО
 * вызова, так что провал закрывал вопрос навсегда: счётчик непрочитанного не
 * сходился с лентой, полоса «N новых» не уходила после прокрутки, и понять
 * почему было нельзя — в журнале не оставалось ни строчки. Теперь исход виден
 * вызывающему, и он вправе попробовать снова.
 */
export async function markFeedPostRead(postId: string): Promise<boolean> {
  try {
    const s = await ensureStorage();
    await s.markAsRead(postId);
    return true;
  } catch (e) {
    log.warn('feed_mark_read_failed', {
      postId: postId.slice(0, 24),
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * v4.32.68: просмотр поста. Вызывается при первом открытии ленты где этот пост
 * виден (read 0 → 1). Шлёт feed_view envelope ТОЛЬКО автору поста (targeted через
 * onlyDids) и ТОЛЬКО один раз на пост (флаг в kvStore `feed_view_sent:<postId>`).
 *
 * Для своих постов не делает ничего: автор виден списком в feed_post_views только
 * если его увидели другие. Для чужих постов чей authorDid отсутствует в наших
 * контактах (пример: репост от дальнего контакта, сам автор не в адресной книге) —
 * tоже skip, потому что multiTransportRouter не найдёт маршрут.
 *
 * На принимающей стороне (автор поста) — handler в receiveFeedEnvelope пишет
 * viewer в feed_post_views. Envelope авторизуется подписью sender'а (viewer =
 * senderDid = payload.authorDid), поэтому нельзя «вписать» чужой просмотр.
 *
 * v4.32.537: возвращает «вопрос закрыт» — своя запись, отметка уже стояла или
 * envelope доставлен. `false` значит «попробуйте ещё раз»: маршрута к автору не
 * нашлось или отправка сорвалась. Раньше возврата не было вовсе, и написанное
 * ниже правило «ставим guard только при успешной доставке, иначе retry при
 * следующем открытии» не работало: экран вносил запись в свой session-кеш ДО
 * вызова, так что второй попытки в этой сессии не случалось никогда. Автор,
 * который был оффлайн в момент просмотра, терял его насовсем.
 *
 * Тогда же отметка переехала под номер профиля. Просмотр — это про конкретного
 * зрителя: на одном телефоне два аккаунта, и общая отметка позволяла первому
 * закрыть вопрос за второго.
 */
export async function notifyFeedPostViewed(
  pair: KeyPairBytes,
  post: { id: string; authorDid: string },
  viewerName: string,
): Promise<boolean> {
  try {
    const myDid = publicKeyToDidKey(pair.publicKey);
    // Свой пост — просмотр не трекаем.
    if (post.authorDid === myDid) return true;
    // Idempotency: один envelope на (этот viewer, этот пост).
    // Номер берётся от ключа отправителя и фиксируется ДО первого ожидания:
    // между чтением отметки и её записью человек успевает переключить аккаунт.
    const viewerPid = ownerPidByDid(
      myDid,
      profileManager.getActiveProfile(),
      () => profileManager.getAllProfiles(),
    ) ?? currentProfileId;
    const guardKey = feedViewSentKey(post.id);
    if (viewerPid === null) {
      // Чей это ключ — неизвестно. Писать отметку некуда: «первый попавшийся»
      // номер и есть чужой, а чужая отметка отняла бы просмотр у другого
      // аккаунта. Отправляем без отметки: у автора зрители складываются в
      // множество, лишний envelope там ничего не испортит.
      log.warn('feed_view_pid_unknown', { postId: post.id.slice(0, 24) });
    } else {
      const prev = await scopedKvTryGetFor(viewerPid, guardKey);
      if (prev === null) {
        // Прочитать не удалось — по той же причине отправляем: молчание
        // потеряет просмотр совсем.
        log.warn('feed_view_guard_unreadable', { postId: post.id.slice(0, 24) });
      } else if (prev.value === '1') {
        return true;
      }
    }

    // Targeted delivery: только автору поста, не всем контактам.
    const onlyDids = new Set<string>([post.authorDid]);
    const trimmedName = (viewerName ?? '').trim().slice(0, 80);
    const data: FeedViewData = {
      kind: 'view',
      viewerName: trimmedName || undefined,
    };
    const payload: FeedEnvelopePayload = {
      type: 'feed_view',
      postId: post.id,
      authorDid: myDid,
      ts: Date.now(),
      data,
    };
    const result = await signAndBroadcastFeedEnvelope(pair, payload, { onlyDids });
    // Ставим guard только при УСПЕШНОЙ доставке — иначе retry при следующем открытии.
    // Если автор оффлайн, попробуем в следующий раз (пост будет viewed=1 до тех пор
    // пока envelope не долетит; это приемлемо — экономия на 1 лишнем envelope не стоит
    // пропуска счётчика у автора).
    if (result && result.delivered.success > 0) {
      if (viewerPid !== null) await scopedKvSetFor(viewerPid, guardKey, '1');
      log.info('feed_view_sent', { postId: post.id.slice(0, 24), authorDid: post.authorDid.slice(0, 24) });
      return true;
    }
    log.info('feed_view_send_no_route', {
      postId: post.id.slice(0, 24),
      authorDid: post.authorDid.slice(0, 24),
    });
    return false;
  } catch (e) {
    log.warn('feed_view_notify_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * v4.32.333: один пост по идентификатору.
 *
 * Нужен восстановлению черновика: экран правки держит саму строку поста, а
 * пережить убийство активности может только идентификатор. Возвращает null и
 * когда поста нет, и когда его не удалось прочитать — вызывающий обязан
 * различать «правим этот пост» и «не знаем, что правим», а не подставлять
 * вместо второго публикацию нового.
 */
export async function getFeedPost(postId: string): Promise<FeedPostRow | null> {
  try {
    const s = await ensureStorage();
    return await s.getPost(postId);
  } catch (e) {
    log.warn('feed_get_post_failed', { postId: postId.slice(0, 24), err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

// v4.32.377: поштучный getFeedPostViewCount убран. Лента считает просмотры
// сразу для всего списка (getFeedPostViewCountsMap — одна SQL вместо N), и
// поштучного счётчика не спрашивал никто.

/**
 * v4.32.68: батч-счётчики для списка постов — одна SQL вместо N.
 */
export async function getFeedPostViewCountsMap(postIds: string[]): Promise<Record<string, number>> {
  try {
    const s = await ensureStorage();
    return await s.getViewCountsForPosts(postIds);
  } catch {
    return {};
  }
}

/**
 * v4.32.68: список viewer'ов конкретного поста. UI откроет модалку со списком.
 * Имена резолвятся через contacts (viewer_name из envelope'а — fallback если
 * у автора нет контакта). Если ни того ни другого — показывается short-DID.
 */
export async function listFeedPostViewers(postId: string): Promise<FeedViewerRow[]> {
  try {
    const s = await ensureStorage();
    return await s.getViewers(postId);
  } catch {
    return [];
  }
}

export async function getUnreadFeedCount(): Promise<number> {
  try {
    const s = await ensureStorage();
    return await s.getUnreadCount();
  } catch {
    return 0;
  }
}

export async function setFeedPostBookmarked(postId: string, bookmarked: boolean): Promise<void> {
  try {
    const s = await ensureStorage();
    await s.setBookmarked(postId, bookmarked);
  } catch { /* noop */ }
}

/** v4.32.528: `null` — прочитать не удалось; пустой список означал бы «закладок нет». */
export async function listBookmarkedFeedPosts(): Promise<DbRead<FeedPostRow>> {
  try {
    const s = await ensureStorage();
    return await s.listBookmarked();
  } catch (e) {
    log.warn('feed_bookmarked_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * v4.32.34: локальная архивация поста. Доступна для любого поста (своего и чужого).
 * В отличие от deleteFeedPost, в сеть ничего не шлёт — просто UPDATE archived=1.
 */
export async function setFeedPostArchived(postId: string, archived: boolean): Promise<void> {
  try {
    const s = await ensureStorage();
    await s.setArchived(postId, archived);
  } catch { /* noop */ }
}

export async function listArchivedFeedPosts(
  limit = 40,
  offset = 0,
): Promise<DbRead<FeedPostRow>> {
  try {
    const s = await ensureStorage();
    return await s.listArchived(limit, offset);
  } catch (e) {
    log.warn('feed_archived_read_failed', {
      err: e instanceof Error ? e.message : String(e),
      limit,
      offset,
    });
    return null;
  }
}

/**
 * v4.32.34: локальное удаление чужого поста (не бродкастит feed_delete envelope).
 * Для своих постов используется `deleteFeedPost(pair, postId)` который шлёт envelope
 * получателям. Для чужих — только локально прячем из БД, чтобы не остался в Архиве.
 */
export async function deleteFeedPostLocal(postId: string): Promise<void> {
  try {
    const s = await ensureStorage();
    await s.deletePost(postId);
    emitFeedUpdate();
  } catch { /* noop */ }
}

/**
 * v4.32.24: входящий FeedEnvelope — главная точка входа из lanCoordinator.
 * Диспетчит по типу, сохраняет в SQLite, эмитит UI-обновление.
 *
 * Безопасность: `parseAndVerifyFeedEnvelope` уже проверил подпись и что
 * payload.authorDid === senderDid. delete/edit дополнительно проверяют что
 * пост принадлежит автору события (нельзя удалить чужой пост).
 */
export async function receiveFeedEnvelope(frame: Uint8Array, senderDid: string): Promise<void> {
  // v4.32.132 (AUDIT P1): drop envelopes arriving during stop→rebind→start.
  if (feedRebinding) {
    log.debug('feed_envelope_dropped_during_rebind');
    return;
  }
  // v4.32.208 (Bridge Stage 2): if frame is a 0xF1 relay wrapper, unwrap to
  // get the inner signed 0xF0 frame + current hops count; otherwise treat
  // as direct delivery with hops=0.
  let innerFrame: Uint8Array = frame;
  let incomingHops = 0;
  let relayed = false;
  if (isFeedRelayWrapper(frame)) {
    const unwrapped = unwrapFeedRelay(frame);
    if (!unwrapped) {
      log.warn('feed_relay_unwrap_failed');
      return;
    }
    innerFrame = unwrapped.inner;
    incomingHops = unwrapped.hops;
    relayed = true;
  }
  const genAtEntry = feedProfileGen;
  // v4.32.209: for relayed frames the transport-hop DID (senderDid) is NOT
  // the author — verify signature against the authorDid embedded in the
  // signed payload. For direct 0xF0 delivery keep the stricter author==hop
  // check (extra integrity at the LAN/internet transport layer).
  //
  // v4.32.472: у интернет-ретранслятора отправителя нет вовсе. Заголовок
  // X-Sender там не отправляют намеренно (v4.32.216: ретранслятор не должен
  // видеть, кто кому пишет), и приёмник передаёт сюда пустую строку. Строгая
  // ветка на пустой строке спотыкалась о parseDidKey('') и молча роняла КАЖДЫЙ
  // конверт ленты, пришедший через интернет: посты, комментарии, реакции. У
  // отправителя при этом всё выглядело доставленным — ретранслятор принял
  // запрос, запись ушла из очереди. То есть лента работала только в общей
  // Wi-Fi-сети, а по интернету не работала вообще.
  //
  // Пустой отправитель — это «транспорт не может его назвать», а не «отправитель
  // неизвестного вида». Проверять в таком случае надо ровно то же, что и у
  // пересланных конвертов: подпись против authorDid из подписанного тела.
  // Строгая сверка «автор == сосед по транспорту» остаётся там, где сосед
  // назван, — в локальной сети.
  const authorFromBody = relayed || senderDid === '';
  const payload = authorFromBody
    ? await parseAndVerifyRelayedFeedEnvelope(innerFrame)
    : await parseAndVerifyFeedEnvelope(innerFrame, senderDid);
  if (!payload) return;

  // v4.32.208: dedup by (type, postId, authorDid, ts). Feed envelopes are
  // signed so identical (author, type, postId, ts) tuples are the same
  // logical event. Prevents processing the same post twice after gossip
  // and suppresses relay loops.
  // v4.32.213 (Audit-42 C1): include hash of payload.data in dedup key.
  // Without this, same-ts signed envelopes with different data (e.g. edit
  // newText, reaction emoji) collide and the second is dropped.
  const dataHash = fnv1a32Hex(JSON.stringify((payload as { data?: unknown }).data ?? null));
  const dedupKey = `${payload.type}|${payload.postId}|${payload.authorDid}|${payload.ts}|${dataHash}`;
  if (feedSeenMarkOrHas(dedupKey)) {
    log.debug('feed_envelope_dedup_drop', { key: dedupKey.slice(0, 80) });
    return;
  }

  // v4.32.213 (Audit-42 H2): mute check MOVED above gossip relay. Previously
  // muted authors' traffic still amplified through our node before being
  // dropped at savePost — now we suppress both save AND relay.
  // v4.32.293: разбор и границы списка — в social/mutedAuthors, там же кэш
  // (эта проверка идёт на каждый входящий конверт).
  if (await isAuthorMuted(payload.authorDid)) {
    log.info('feed_envelope_muted_drop', {
      type: payload.type,
      authorDid: payload.authorDid.slice(0, 24),
    });
    return;
  }

  // v4.32.208: mesh-gossip re-broadcast. If hop-limit not reached, wrap the
  // signed inner frame with hops+1 and fan out to our contacts (excluding
  // the sender we got it from and the original author). Fire-and-forget.
  //
  // v4.32.211 (Audit-40 #3): skip gossip for feed_view events. Views are
  // high-volume / low-value (a popular post gets thousands) and multi-hop
  // relay would flood the mesh. Views still reach the author via direct
  // broadcast; mesh bridging is reserved for posts/comments/reactions/edits.
  if (incomingHops < FEED_RELAY_MAX_HOPS && payload.type !== 'feed_view') {
    void feedGossipRelay(innerFrame, incomingHops + 1, senderDid, payload.authorDid);
  }
  // v4.32.133: recheck — a rebind can have run to completion during the
  // parseAndVerify await, swapping the storage context out from under us.
  if (feedRebinding || feedProfileGen !== genAtEntry) {
    log.debug('feed_envelope_dropped_profile_switched');
    return;
  }

  try {
    const s = await ensureStorage();
    // v4.32.527: профиль фиксируется здесь же, где и хранилище, и дальше по
    // разбору берётся только отсюда. Живая модульная переменная читалась уже
    // после нескольких await, а переключение профиля меняет её посреди
    // обработки — голос в опросе, прилетевший ровно в этот момент, ложился в
    // чужой аккаунт: в открытом опросе счётчик не двигался, а в соседнем
    // профиле появлялся голос-призрак. Запасного `?? 1` здесь быть не может:
    // ensureStorage выше именно поэтому бросает, а не подставляет первый
    // попавшийся профиль (см. её докблок).
    const envelopePid = currentProfileId;
    if (envelopePid == null) {
      log.warn('feed_envelope_profile_unset', { type: payload.type });
      return;
    }

    switch (payload.type) {
      case 'feed_post': {
        const d = payload.data as FeedPostData;
        // v4.32.191 (Round-21 #3): cap untrusted feed_post fields so a
        // single peer can't bloat SQLite + kvStore with a 50MB post.
        // v4.32.527: потолок общий с публикацией. Прежние 8 000 были меньше
        // разрешённых автору 10 000 — законный длинный пост терял хвост у
        // каждого получателя, и автор об этом не узнавал.
        const postText = clampFeedPostText(d.text);
        if (postText !== null) d.text = postText;
        const postName = clampFeedAuthorName(d.authorName);
        if (postName !== null) d.authorName = postName;
        if (Array.isArray(d.media)) {
          d.media = d.media
            .filter((m): m is string => typeof m === 'string')
            .slice(0, 10)
            .filter((m) => m.length <= 3 * 1024 * 1024); // ~2MB decoded per base64
        }
        if (Array.isArray(d.documents)) {
          d.documents = d.documents
            .filter((doc) => doc && typeof doc === 'object')
            .slice(0, 5)
            .filter((doc) => typeof doc.data !== 'string' || doc.data.length <= 14 * 1024 * 1024); // ~10MB decoded
        }
        // Синтетические mediaCids как `inline:<mime>;<i>:<postId>` — так UI отличит inline-медиа
        // от старых IPFS-CID и сможет отрендерить base64 напрямую.
        const mediaCids = d.media && d.media.length > 0
          ? d.media.map((_, i) => `inline:${d.mediaMime?.[i] ?? 'application/octet-stream'};${i}:${payload.postId}`)
          : null;
        // v4.32.48: документы — метаданные в таблицу feed.documents, base64 в kvStore.
        const docsMeta = d.documents && d.documents.length > 0
          ? d.documents.map((doc) => ({
              name: typeof doc.name === 'string' ? doc.name.slice(0, 200) : 'document',
              mime: typeof doc.mime === 'string' ? doc.mime.slice(0, 100) : 'application/octet-stream',
              size: typeof doc.size === 'number' ? doc.size : 0,
            }))
          : null;
        await s.savePost({
          id: payload.postId,
          authorDid: payload.authorDid,
          authorName: d.authorName || null,
          text: d.text,
          mediaCids,
          timestamp: payload.ts,
          read: 0,
          cid: null,
          documents: docsMeta,
        });
        // Сохранить сам base64 отдельно (для рендера). TODO v4.32.25: отдельная таблица feed_media.
        // Пока кладём в kvStore по ключу inline:<postId>:<i>.
        if (d.media && d.media.length > 0) {
          for (let i = 0; i < d.media.length; i++) {
            // Отказ записи здесь не отменяет пост: текст уже сохранён, а место
            // фотографии останется пустым — reconcileOrphanInlineMedia потом
            // подчистит ссылку. Но узнать о нём надо: раньше kvSet гасил
            // ошибку молча, и «пустая картинка у контакта» не имела следа.
            if (!(await kvSetInlineAttachment(`feed_inline_media:${payload.postId}:${i}`, d.media[i]))) {
              log.warn('feed_inline_media_receive_save_failed', {
                postId: payload.postId.slice(0, 24),
                idx: i,
              });
            }
          }
        }
        // v4.32.48: сохранить base64 документов в kvStore (для последующего «Скачать/Поделиться»).
        if (d.documents && d.documents.length > 0) {
          for (let i = 0; i < d.documents.length; i++) {
            try {
              const data = d.documents[i].data;
              // v4.32.194 (Round-24 #4): strict base64 charset check — peer
              // can embed arbitrary bytes that later crash Buffer.from during
              // decode. Length must be multiple of 4.
              if (
                typeof data === 'string' &&
                data.length > 0 &&
                data.length % 4 === 0 &&
                /^[A-Za-z0-9+/]+={0,2}$/.test(data)
              ) {
                if (!(await kvSetInlineAttachment(`feed_inline_doc:${payload.postId}:${i}`, data))) {
                  log.warn('feed_inline_doc_receive_save_failed', {
                    postId: payload.postId.slice(0, 24),
                    idx: i,
                    err: 'kv_write_failed',
                  });
                }
              }
            } catch (e) {
              log.warn('feed_inline_doc_receive_save_failed', { postId: payload.postId.slice(0, 24), idx: i, err: e instanceof Error ? e.message : String(e) });
            }
          }
        }
        log.info('feed_post_received', { postId: payload.postId.slice(0, 24), authorDid: payload.authorDid.slice(0, 32), docsN: d.documents?.length ?? 0 });
        // v4.32.92: in-app banner для новых постов контактов.
        emitFeedNotify({
          kind: 'post',
          authorDid: payload.authorDid,
          authorName: d.authorName ?? null,
          preview: (d.text ?? '').slice(0, 80) || '(медиа)',
        });
        break;
      }
      case 'feed_reaction': {
        const d = payload.data as FeedReactionData;
        // v4.32.191 (Round-21 #4): cap emoji string — a peer can send a 1MB
        // "emoji" to bloat post_reactions. Real emoji fit in ≤16 chars.
        if (typeof d.emoji !== 'string' || d.emoji.length === 0 || d.emoji.length > 16) break;
        if (typeof payload.postId !== 'string' || payload.postId.length === 0 || payload.postId.length > 128) break;
        if (d.remove) {
          await s.removeReaction(payload.postId, d.emoji, payload.authorDid);
          log.info('feed_unreaction_received', { postId: payload.postId.slice(0, 16), emoji: d.emoji });
        } else {
          await s.addReaction(payload.postId, d.emoji, payload.authorDid);
          log.info('feed_reaction_received', { postId: payload.postId.slice(0, 16), emoji: d.emoji });
        }
        break;
      }
      case 'feed_comment_reaction': {
        const d = payload.data as FeedCommentReactionData;
        if (
          typeof d.commentId !== 'string' || d.commentId.length === 0 || d.commentId.length > 128 ||
          typeof payload.postId !== 'string' || payload.postId.length === 0 || payload.postId.length > 128 ||
          typeof d.emoji !== 'string' || d.emoji.length === 0 || d.emoji.length > 16 ||
          (d.remove !== undefined && typeof d.remove !== 'boolean')
        ) break;
        const meta = await s.getCommentMeta(d.commentId);
        if (!meta || meta.postId !== payload.postId) break;
        const reactions: Record<string, string[]> = meta.reactions ? { ...meta.reactions } : {};
        const existing = Array.isArray(reactions[d.emoji]) ? reactions[d.emoji] : [];
        if (d.remove) {
          const remaining = existing.filter((did) => did !== payload.authorDid);
          if (remaining.length > 0) reactions[d.emoji] = remaining;
          else delete reactions[d.emoji];
        } else {
          if (!existing.includes(payload.authorDid)) {
            if (!(d.emoji in reactions) && Object.keys(reactions).length >= 64) break;
            if (existing.length >= 512) break;
            reactions[d.emoji] = [...existing, payload.authorDid];
          }
        }
        await s.updateCommentReactions(d.commentId, reactions);
        log.info('feed_comment_reaction_received', {
          postId: payload.postId.slice(0, 16),
          commentId: d.commentId.slice(0, 16),
          emoji: d.emoji,
          remove: d.remove === true,
        });
        break;
      }
      case 'feed_comment': {
        const d = payload.data as FeedCommentData;
        // v4.32.191 (Round-21 #1+#2): strict shape validation + orphan-postId
        // rejection so an attacker can't spam comments pointing at nonexistent
        // posts to bloat feed_comments unboundedly.
        if (typeof d.commentId !== 'string' || d.commentId.length === 0 || d.commentId.length > 128) break;
        if (typeof payload.postId !== 'string' || payload.postId.length === 0 || payload.postId.length > 128) break;
        // v4.32.527: 2 000, как и в форме ответа. Прежние 8 000 были вчетверо
        // больше того, что вообще может отправить честный клиент, — этот запас
        // оставался только тому, кто собирает конверт руками.
        const commentText = clampFeedCommentText(d.text);
        if (commentText === null) break;
        d.text = commentText;
        const commentName = clampFeedAuthorName(d.authorName);
        if (commentName !== null) d.authorName = commentName;
        try {
          const exists = await s.getPost(payload.postId);
          if (!exists) {
            log.info('feed_comment_rejected_orphan', { postId: payload.postId.slice(0, 16), commentId: d.commentId.slice(0, 16) });
            break;
          }
        } catch { /* fall through — addComment will still enforce FK if set */ }
        await s.addComment({
          id: d.commentId,
          postId: payload.postId,
          authorDid: payload.authorDid,
          authorName: d.authorName || null,
          text: d.text,
          timestamp: payload.ts,
        });
        log.info('feed_comment_received', { postId: payload.postId.slice(0, 16), commentId: d.commentId.slice(0, 16) });
        // v4.32.92: banner только если это комментарий под постом контакта, которого я вижу
        // (не под моим — авторство поста сложнее проверить без доп. lookup). Простейший
        // вариант: показываем всегда, App-уровень суппрессит при tab === 'feed'.
        emitFeedNotify({
          kind: 'comment',
          authorDid: payload.authorDid,
          authorName: d.authorName ?? null,
          preview: (d.text ?? '').slice(0, 80),
          postId: payload.postId,
        });
        break;
      }
      case 'feed_comment_delete': {
        // v4.32.162: распространённое удаление комментария. Auth: отправитель envelope'а
        // должен быть автором комментария ИЛИ автором поста (модерация в своей ленте).
        // v4.32.163 P2#3: если комментарий ещё не дошёл (out-of-order delivery), пишем
        // tombstone с postId из envelope'а — опоздавший `feed_comment` увидит его в
        // addComment() и не воскреснет.
        const d = payload.data as FeedCommentDeleteData;
        if (
          typeof d.commentId !== 'string' || d.commentId.length === 0 || d.commentId.length > 128 ||
          typeof payload.postId !== 'string' || payload.postId.length === 0 || payload.postId.length > 128
        ) break;
        const meta = await s.getCommentMeta(d.commentId);
        if (!meta) {
          // Without the comment row, only the post author can be authenticated.
          // Never let an arbitrary peer plant a tombstone for a future comment.
          const post = await s.getPost(payload.postId);
          const isPostAuthor = !!post && post.authorDid === payload.authorDid;
          if (!isPostAuthor) break;
          await s.addCommentTombstone(d.commentId, payload.postId);
          log.info('feed_comment_delete_tombstone_preemptive', {
            commentId: d.commentId.slice(0, 24),
            postId: payload.postId.slice(0, 16),
            sender: payload.authorDid.slice(0, 24),
          });
          break;
        }
        if (meta.postId !== payload.postId) break;
        const post = await s.getPost(meta.postId);
        const isCommentAuthor = meta.authorDid === payload.authorDid;
        const isPostAuthor = !!post && post.authorDid === payload.authorDid;
        if (!isCommentAuthor && !isPostAuthor) {
          log.warn('feed_comment_delete_auth_mismatch', {
            commentId: d.commentId.slice(0, 24),
            commentAuthor: meta.authorDid.slice(0, 24),
            sender: payload.authorDid.slice(0, 24),
          });
          break;
        }
        await s.deleteComment(d.commentId);
        log.info('feed_comment_delete_received', { commentId: d.commentId.slice(0, 24), postId: meta.postId.slice(0, 16) });
        emitFeedUpdate();
        break;
      }
      case 'feed_repost': {
        const d = payload.data as FeedRepostData;
        // v4.32.199 (Round-29 #4): cap all untrusted fields. Parity with
        // feed_post inline-doc validation at line ~1546; previously an
        // attacker could ship 1000 inline media blobs per repost envelope
        // or megabyte-long strings bloating SQLite+kv on every receiver.
        const safeText = typeof d.text === 'string' ? d.text.slice(0, 8_000) : '';
        const safeAuthorName = typeof d.authorName === 'string' ? d.authorName.slice(0, 128) : null;
        const safeOrigAuthorName = typeof d.originalAuthorName === 'string' ? d.originalAuthorName.slice(0, 128) : d.originalAuthorName;
        let mediaCids: string[] | null = null;
        if (Array.isArray(d.originalMedia)) {
          mediaCids = d.originalMedia
            .filter(isPlainCid)
            .slice(0, 10);
          if (mediaCids.length === 0) mediaCids = null;
        }
        if (Array.isArray(d.originalMediaBase64) && d.originalMediaBase64.length > 0) {
          const newCids: string[] = [];
          const cappedBlobs = d.originalMediaBase64.slice(0, 10);
          for (let i = 0; i < cappedBlobs.length; i++) {
            const data = cappedBlobs[i];
            if (typeof data !== 'string' || data.length === 0 || data.length > 2 * 1024 * 1024) continue;
            if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
            const rawMime = d.originalMediaBase64Mime?.[i];
            const mime = typeof rawMime === 'string' && rawMime.length <= 64 ? rawMime : 'application/octet-stream';
            // v4.32.341: ссылка добавлялась до записи байтов и оставалась даже
            // тогда, когда запись не удалась, — репост показывал пустую плитку
            // без надежды когда-нибудь наполниться. Порядок обратный.
            if (!(await kvSetInlineAttachment(`feed_inline_media:${payload.postId}:${i}`, data))) {
              log.warn('feed_repost_inline_media_save_failed', {
                postId: payload.postId.slice(0, 24),
                idx: i,
              });
              continue;
            }
            newCids.push(`inline:${mime};${i}:${payload.postId}`);
          }
          if (newCids.length > 0) mediaCids = newCids;
        }
        await s.savePost({
          id: payload.postId,
          authorDid: payload.authorDid,
          authorName: safeAuthorName,
          text: safeText,
          mediaCids,
          timestamp: payload.ts,
          read: 0,
          cid: null,
          repostOf: d.originalPostId,
          repostAuthorName: safeOrigAuthorName,
          repostAuthorDid: d.originalAuthorDid,
        });
        log.info('feed_repost_received', { postId: payload.postId.slice(0, 24), mediaN: mediaCids?.length ?? 0 });
        break;
      }
      case 'feed_delete': {
        // v4.32.29: auth-check — удалять можно только СВОЙ пост. Раньше любой контакт мог
        // подписать feed_delete{postId: чужой} и стереть чужой пост локально у всех.
        const existing = await s.getPost(payload.postId);
        if (!existing) {
          // v4.32.546: раньше здесь был просто выход, и «удалить у всех»
          // проигрывало гонку с доставкой самого поста: конверт `feed_post`
          // приходил следом (ретрай автора, второй транспорт, переигранное
          // окно ретеншена) и публикация оставалась у получателя навсегда.
          // Надгробие запоминает удаление до того, как пост появился.
          await s.savePostTombstone(payload.postId, payload.authorDid, payload.ts);
          log.info('feed_delete_tombstoned', { postId: payload.postId.slice(0, 24) });
          break;
        }
        if (existing.authorDid !== payload.authorDid) {
          log.warn('feed_delete_auth_mismatch', {
            postId: payload.postId.slice(0, 24),
            owner: existing.authorDid.slice(0, 24),
            attacker: payload.authorDid.slice(0, 24),
          });
          break;
        }
        await cleanupInlinePayloads(payload.postId);
        await s.deletePost(payload.postId);
        log.info('feed_delete_received', { postId: payload.postId.slice(0, 24) });
        break;
      }
      case 'feed_edit': {
        const d = payload.data as FeedEditData;
        // v4.32.29: auth-check — редактировать можно только свой пост.
        const existing = await s.getPost(payload.postId);
        if (!existing) {
          log.info('feed_edit_unknown_post', { postId: payload.postId.slice(0, 24) });
          break;
        }
        if (existing.authorDid !== payload.authorDid) {
          log.warn('feed_edit_auth_mismatch', {
            postId: payload.postId.slice(0, 24),
            owner: existing.authorDid.slice(0, 24),
            attacker: payload.authorDid.slice(0, 24),
          });
          break;
        }
        // v4.32.65: last-write-wins по ts envelope'а. Если у нас уже есть более
        // свежая правка (пришла раньше, но edited_at/timestamp новее) — дропаем
        // старый envelope. Защита от out-of-order доставки при multi-device edit.
        const lastEditTs = existing.editedAt ?? existing.timestamp;
        if (payload.ts < lastEditTs) {
          log.info('feed_edit_stale_skipped', {
            postId: payload.postId.slice(0, 24),
            envelopeTs: payload.ts,
            localLastEditTs: lastEditTs,
          });
          break;
        }
        // v4.32.527: единственное место, где текст из реле шёл в базу вообще
        // без проверки — ни типа, ни длины. Транспорт оставляет на конверт
        // около двух мегабайт, а у каждой правки свой ts, то есть свой ключ
        // дедупликации: одну и ту же строку можно было раздувать повторно.
        if (!isEditableFeedText(d.newText)) {
          // Тип поля в FeedEditData объявлен строкой, поэтому длину здесь
          // TypeScript уже считает недостижимой — но пришло-то оно из сети,
          // и объявление о содержимом конверта ничего не знает.
          log.warn('feed_edit_bad_text', {
            postId: payload.postId.slice(0, 24),
            type: typeof (d as { newText?: unknown }).newText,
            len: String((d as { newText?: unknown }).newText ?? '').length,
          });
          break;
        }
        await s.updatePostText(payload.postId, d.newText, payload.ts);
        log.info('feed_edit_received', { postId: payload.postId.slice(0, 24) });
        break;
      }
      case 'feed_poll_vote': {
        // v4.32.51: голос в опросе. До этого setPollVote писал только локально у
        // голосующего — остальные получатели видели у себя счётчик "Всего: 1" (только
        // свой голос). Теперь envelope переносит {postId, optionIndex, remove?} всем
        // контактам автора голоса, receiver пишет у себя в poll_votes через setPollVote.
        const d = payload.data as FeedPollVoteData;
        const existing = await s.getPost(payload.postId);
        if (!existing) {
          log.info('feed_poll_vote_unknown_post', { postId: payload.postId.slice(0, 24) });
          break;
        }
        if (!existing.text || !existing.text.startsWith(POLL_PREFIX)) {
          log.warn('feed_poll_vote_not_poll', { postId: payload.postId.slice(0, 24) });
          break;
        }
        const poll = parsePollText(existing.text);
        if (!poll) {
          log.warn('feed_poll_vote_parse_failed', { postId: payload.postId.slice(0, 24) });
          break;
        }
        // v4.32.133 (AUDIT P2): require integer. A float optionIndex would pass
        // `typeof === 'number'` + bounds check but get silently cast when
        // written to the INTEGER column, corrupting tallies on receivers.
        if (!Number.isInteger(d.optionIndex) || d.optionIndex < 0 || d.optionIndex >= poll.options.length) {
          log.warn('feed_poll_vote_bad_index', { postId: payload.postId.slice(0, 24), idx: d.optionIndex });
          break;
        }
        // Для учёта голоса нам нужен pubB64 голосующего, а пришёл DID. Конвертируем.
        const voterPk = parseDidKey(payload.authorDid);
        if (!voterPk) {
          log.warn('feed_poll_vote_bad_did', { did: payload.authorDid.slice(0, 24) });
          break;
        }
        const voterPubB64 = Buffer.from(voterPk).toString('base64');
        const pid = envelopePid;
        if (d.remove) {
          await deletePollVote(payload.postId, voterPubB64, d.optionIndex, pid);
          log.info('feed_poll_unvote_received', { postId: payload.postId.slice(0, 24), idx: d.optionIndex });
        } else {
          await setPollVote(payload.postId, voterPubB64, d.optionIndex, pid, poll.allowMultiple);
          log.info('feed_poll_vote_received', { postId: payload.postId.slice(0, 24), idx: d.optionIndex, multi: poll.allowMultiple });
        }
        break;
      }
      case 'feed_view': {
        // v4.32.68: входящий просмотр. Sender — viewer (payload.authorDid).
        // Envelope адресно приходит автору (notifyFeedPostViewed шлёт с onlyDids=[authorDid]),
        // но в теории может прийти и сюда по другому маршруту. Записываем viewer'а
        // безусловно — UI при показе счётчика сам проверит, что пост принадлежит активному
        // профилю. parseAndVerifyFeedEnvelope уже проверил что senderDid === authorDid,
        // поэтому нельзя «вписать» чужой просмотр от имени кого-то другого.
        const existing = await s.getPost(payload.postId);
        if (!existing) {
          log.info('feed_view_unknown_post', { postId: payload.postId.slice(0, 24) });
          break;
        }
        // Self-view — не считаем (viewer === автор поста). Дополнительная защита
        // к guard'у в notifyFeedPostViewed (авторы своих постов envelope не шлют).
        if (existing.authorDid === payload.authorDid) {
          log.info('feed_view_self_skip', { postId: payload.postId.slice(0, 24) });
          break;
        }
        const d = payload.data as FeedViewData;
        const viewerName = (d.viewerName ?? '').trim().slice(0, 80) || null;
        await s.recordView(payload.postId, payload.authorDid, viewerName, payload.ts);
        log.info('feed_view_received', {
          postId: payload.postId.slice(0, 24),
          viewer: payload.authorDid.slice(0, 24),
        });
        break;
      }
      default:
        log.warn('feed_envelope_unknown_type', { type: (payload as FeedEnvelopePayload).type });
        return;
    }

    emitFeedUpdate();
  } catch (e) {
    log.warn('feed_envelope_ingest_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Зарегистрировать callback для UI-обновлений. Фактическая доставка идёт через
 * receiveFeedEnvelope (вызывается из lanCoordinator). Сам listener теперь — просто
 * регистрация onUpdate + установка профиля. Старый IPFS-pubsub путь удалён в v4.32.24.
 */
// v4.32.132 (AUDIT P1): race guard for profile switch. See `feedRebinding`
// declaration near the top of the module — we flip it true in stop/rebind and
// clear it once the new profile context is committed.
export async function startFeedInboxListener(
  myDid: string,
  profileId: number,
  onUpdate: () => void
): Promise<void> {
  void myDid; // oldAPI совместимость; myDid больше не нужен (идентификация через lanCoordinator)
  feedProfileGen++;
  try {
    await setFeedProfileContext(profileId);
    onUpdateCb = onUpdate;
    inboxUnsub = () => { onUpdateCb = null; };
  } finally {
    feedRebinding = false;
  }
}

export function stopFeedInboxListener(): void {
  feedRebinding = true;
  feedProfileGen++;
  // v4.32.213 (Audit-42 H1): feedSeenKeys is module-global — clearing on
  // profile unbind prevents cross-profile suppression (profile A's seen
  // envelope silently dropped when profile B re-subscribes).
  feedSeenKeys.clear();
  try {
    inboxUnsub?.();
  } finally {
    inboxUnsub = null;
    onUpdateCb = null;
  }
}

/** Служебно: обновить контекст БД при смене профиля из App. */
export async function rebindFeedToProfile(profileId: number): Promise<void> {
  feedRebinding = true;
  feedProfileGen++;
  // v4.32.213 (Audit-42 H1): see stopFeedInboxListener — same rationale.
  feedSeenKeys.clear();
  try {
    await setFeedProfileContext(profileId);
  } finally {
    feedRebinding = false;
  }
}

/**
 * v4.32.49: вычистить все feed-данные профиля — вызывается из
 * profileManager.deleteProfile ДО удаления профиля из state.
 *
 * Порядок важен:
 * 1. Открываем feed DB удаляемого профиля (отдельный FeedStorage-instance,
 *    не текущий активный — ctx не трогаем, активный профиль может отличаться).
 * 2. Собираем все postId'ы — нужны для поиска orphaned kv-записей
 *    (`feed_inline_media:<postId>:*` и `feed_inline_doc:<postId>:*`).
 * 3. Для каждого postId удаляем соответствующие kv-префиксы.
 * 4. Удаляем feed DB файл (`airchat_feed_p${id}.db`).
 *
 * Errors логируются, но не throw'им — деplete профиля всё равно должен
 * продолжиться, orphaned данные лучше, чем залипший профиль.
 */
/**
 * v4.32.136 (AUDIT P1): boot-time recovery for crash-mid-publish orphans.
 *
 * Scenario: `tryPublishFeedPostComplete` saves the post row (with
 * `mediaCids: ['inline:...:0', 'inline:...:1']`) to SQLite, then loops
 * `kvSet('feed_inline_media:<postId>:<i>', ...)`. If the process is killed
 * between savePost and the kvSet loop completion (OOM-kill, force-stop),
 * the next boot sees a post row pointing at keys that don't exist in
 * kvStore — FeedScreen would render blank media slots forever, with no
 * path to self-heal (rollback in the publish fn only runs on in-process
 * throws, not on process death).
 *
 * This sweep runs once per identity bind, right after rebindFeedToProfile
 * and before startFeedInboxListener. For each post whose mediaCids include
 * `inline:` entries, we verify every referenced kvStore key exists. Any
 * missing key = orphan → purge the post + any partial inline-media/doc
 * writes. The post is already undelivered (crash happened before broadcast),
 * so purging it is safe and restores the feed to a consistent state.
 */
/**
 * Номера постов ВСЕХ профилей.
 *
 * v4.32.433: ключи вложений лежат в общей таблице kv и префикса профиля не
 * несут, а посты — в отдельной базе на профиль. Значит по одному только
 * списку активного профиля «чей это ключ» не определить, и чужие вложения
 * выглядят как байты удалённых постов. null — хотя бы один список не
 * прочитался: тогда вызывающий сирот не ищет вовсе.
 */
async function listPostIdsEverywhere(): Promise<string[] | null> {
  const ids = profileManager.getProfileIds();
  if (ids.length === 0) return null;
  const out: string[] = [];
  for (const id of ids) {
    // v4.32.521: соединение закрывается после просмотра. Обход идёт по ВСЕМ
    // профилям и повторяется на каждой привязке личности, а expo-sqlite не
    // открывает файл заново — она отдаёт то же соединение и считает ссылки.
    // Незакрытые ссылки копились от запуска к запуску, и это не только память:
    // deleteDatabaseAsync отказывается удалять базу, на которую есть хоть одна
    // ссылка, — то есть после первого же обхода ленту удалённого профиля стало
    // бы не убрать вовсе. Заодно перестаёт расти WAL: он усекается при закрытии.
    const s = new FeedStorage(id);
    try {
      await s.init();
      out.push(...(await s.listAllPostIds()));
    } catch (e) {
      log.warn('feed_postids_scan_failed', { profileId: id, err: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      try {
        await s.close();
      } catch (e) {
        log.warn('feed_postids_scan_close_failed', {
          profileId: id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return out;
}

export async function reconcileOrphanInlineMedia(profileId: number): Promise<void> {
  void profileId; // ensureStorage uses the already-bound profile context.
  const s = await ensureStorage();
  const postIds = await s.listAllPostIds();

  // v4.32.333: наличие вложений проверяется по списку КЛЮЧЕЙ, а не чтением
  // значений. Раньше на каждый слот делался kvGet — то есть в память тянулись
  // сами байты (до 14 МБ base64 на документ, до пяти на пост), и всё это ради
  // сравнения с null. Пост из пяти документов — 70 МБ строк; лента из двух
  // десятков таких постов — больше гигабайта выделений на старте, в JS-потоке,
  // до первого кадра. Теперь это два запроса на весь профиль.
  const mediaKeys = await kvTryListKeysByPrefix(INLINE_MEDIA_PREFIX);
  const docKeys = await kvTryListKeysByPrefix(INLINE_DOC_PREFIX);
  if (mediaKeys === null || docKeys === null) {
    // Не прочиталось — не значит «пропало». По пустому списку мы удалили бы
    // ВСЕ посты с вложениями, безвозвратно, из-за секундной блокировки базы.
    log.warn('feed_reconcile_skipped_kv_unreadable', { profileId });
    return;
  }
  const inlineKeys = [...mediaKeys, ...docKeys];

  const posts: InlinePostRef[] = [];
  for (const postId of postIds) {
    const post = await s.getPost(postId);
    if (!post) continue;
    const documents = (post as { documents?: unknown[] }).documents;
    posts.push({
      postId,
      mediaCids: post.mediaCids ?? [],
      documentsCount: Array.isArray(documents) ? documents.length : 0,
    });
  }

  // Список постов всех профилей, а не только своего: см. listPostIdsEverywhere.
  const knownPostIdsEverywhere = await listPostIdsEverywhere();
  const { purgePosts, orphanKeys } = scanInlineOrphans({ posts, inlineKeys, knownPostIdsEverywhere });

  let purged = 0;
  for (const p of purgePosts) {
    try {
      await s.deletePost(p.postId);
      await kvDeleteByPrefix(`${INLINE_MEDIA_PREFIX}${p.postId}:`);
      await kvDeleteByPrefix(`${INLINE_DOC_PREFIX}${p.postId}:`);
      purged++;
      log.warn('feed_orphan_post_purged', {
        postId: p.postId.slice(0, 24),
        missing: p.missing,
        mediaN: p.mediaN,
        docsN: p.docsN,
      });
    } catch (e) {
      log.warn('feed_orphan_post_purge_failed', {
        postId: p.postId.slice(0, 24),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (purged > 0) {
    log.info('feed_reconcile_done', { profileId, scanned: postIds.length, purged });
  }

  // v4.32.137: вторая половина — байты, чей пост уже удалён. Закрывает утечку,
  // когда rollback в tryPublishFeedPostComplete не смог убрать kv-запись
  // (SQLITE_FULL, locked DB) или пост удалили в обход cleanupFeedStorageForProfile.
  let orphanKeysPurged = 0;
  for (const key of orphanKeys) {
    try {
      await kvDelete(key);
      orphanKeysPurged++;
    } catch (e) {
      // v4.32.333: ключ целиком в лог больше не пишется — в нём postId, а по
      // нему из отчёта о диагностике восстанавливается, что человек публиковал.
      log.warn('feed_orphan_kv_purge_failed', {
        postId: (postIdFromInlineKey(key) ?? '').slice(0, 24),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (orphanKeysPurged > 0) {
    log.info('feed_orphan_kv_purged', { profileId, count: orphanKeysPurged });
  }
}

/**
 * Убрать ленту удалённого профиля (v4.32.521 — исправление).
 *
 * Дефект: файл базы удалялся при открытом соединении. Ради списка постов здесь
 * открывалась `new FeedStorage(profileId)`, и она оставалась открытой — а
 * expo-sqlite на открытой базе отказывает наверняка: «Unable to delete database
 * … that is currently open. Close it prior to deletion.» Отказ подхватывал
 * общий catch, писал одну строчку в журнал — и вся лента удалённого аккаунта,
 * посты с комментариями и вложениями, оставалась лежать файлом
 * airchat_feed_p<id>.db. Навсегда: другого места, где её удаляют, нет.
 *
 * Соединений при этом бывает два. Второе — рабочее: удаляют обычно активный
 * профиль, а модуль ещё держит его ленту (или как раз открывает её, если
 * переключение в полёте). Закрывать надо оба, иначе первое же оставшееся
 * повторяет ту же историю.
 *
 * Удаление базы вынесено из-под catch намеренно. Неудача уборки kv-записей —
 * это осиротевшие байты вложений, их подберёт сверка ленты; неудача удаления
 * базы — это данные удалённого аккаунта, оставшиеся на устройстве, и знать о
 * ней вызывающий обязан.
 */
export async function cleanupFeedStorageForProfile(profileId: number): Promise<void> {
  if (currentProfileId === profileId || ctxPromiseForId === profileId) {
    try {
      await closeFeedStorage();
    } catch (e) {
      log.warn('feed_cleanup_active_close_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const tmp = new FeedStorage(profileId);
  try {
    await tmp.init();
    const postIds = await tmp.listAllPostIds();
    for (const pid of postIds) {
      await kvDeleteByPrefix(`${INLINE_MEDIA_PREFIX}${pid}:`);
      await kvDeleteByPrefix(`${INLINE_DOC_PREFIX}${pid}:`);
    }
    log.info('feed_cleanup_profile', { profileId, posts: postIds.length });
  } catch (e) {
    log.warn('feed_cleanup_profile_failed', { profileId, err: e instanceof Error ? e.message : String(e) });
  } finally {
    // В finally, а не после try: список постов мог и не прочитаться, но базу
    // всё равно предстоит снести, а снести её при открытом соединении нельзя.
    try {
      await tmp.close();
    } catch (e) {
      log.warn('feed_cleanup_tmp_close_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  await deleteFeedDbForProfile(profileId);
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export { type FeedCommentRow };

// v4.32.527: обе величины переехали в feedTextLimit — вместе с приёмом.
// Здесь они были только у отправки, а разбор входящего конверта пользовался
// своими числами, и числа разъехались в обе стороны сразу.

/**
 * Комментарий к посту: локально + envelope всем контактам.
 * v4.32.24: сигнатура (pair, postId, text, myName) — нужен secretKey для подписи.
 * v4.32.64: валидация длины — пустые/слишком длинные комменты throw'ают,
 * а не улетают в сеть молча (раньше 50KB комментарий разбухал envelope >2MB
 * и ронял `signAndBroadcast` без сигнала юзеру).
 */
export async function addAndBroadcastComment(
  pair: KeyPairBytes,
  postId: string,
  text: string,
  myName: string,
): Promise<FeedCommentRow> {
  // v4.32.553: комментарий пишется локально и, если доставка не удалась,
  // уходит в очередь повторов — ту самую, что завели в v4.32.164 ради
  // отсутствия сети. Проверка сети первой строкой отменяла и запись, и
  // очередь; теперь она решает только, пробовать ли рассылку сейчас.
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error('Комментарий пустой');
  if (trimmed.length > FEED_COMMENT_MAX_CHARS) {
    throw new Error(`Комментарий слишком длинный (макс. ${FEED_COMMENT_MAX_CHARS} символов)`);
  }
  // v4.32.527: то же число, что и на приёме. Своё (120) обрезало имя на
  // восемь символов раньше, чем принимающая сторона вообще возражала.
  const safeName = clampFeedAuthorName(myName) ?? 'Аноним';
  const myDid = publicKeyToDidKey(pair.publicKey);
  const s = await ensureStorage();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = Date.now();
  const row: FeedCommentRow = { id, postId, authorDid: myDid, authorName: safeName, text: trimmed, timestamp };
  await s.addComment(row);
  emitFeedUpdate();

  const data: FeedCommentData = { kind: 'comment', commentId: id, text: trimmed, authorName: safeName };
  const payload: FeedEnvelopePayload = {
    type: 'feed_comment',
    postId,
    authorDid: myDid,
    ts: timestamp,
    data,
  };
  let res: Awaited<ReturnType<typeof signAndBroadcastFeedEnvelope>> = null;
  const online = await checkOnlineWrite();
  if (shouldAttemptBroadcast(online.ok)) {
    try {
      res = await signAndBroadcastFeedEnvelope(pair, payload);
      // v4.32.114 T2: параллельно с контактным broadcast'ом публикуем в pubsub-топик поста —
      // любой наблюдатель (даже не из контактов комментатора) получит коммент, если открыл модалку.
      if (res) void publishToPostCommentsTopic(postId, res.frame);
    } catch (e) {
      // Local persistence succeeded. A transport/signing exception must still
      // enter the outbox, otherwise the comment becomes permanently local-only.
      log.warn('feed_comment_broadcast_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  } else {
    log.info('feed_comment_queued_offline', { reachability: online.reachability });
  }
  // v4.32.164 P1#2: если доставка не удалась (нет контактов в сети / serialization failed /
  // частичная), — кладём envelope в outbox для retry. Логика drain — в scheduleCommentOutboxRetry.
  if (!res || res.delivered.success < res.delivered.total) {
    try {
      await enqueueCommentOutboxItem(pair, {
        kind: 'comment',
        commentId: id,
        postId,
        text: trimmed,
        authorName: safeName,
        ts: timestamp,
      });
      scheduleCommentOutboxRetry(pair, RETRY_DELAY_MS);
    } catch (e) {
      log.warn('feed_comment_outbox_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
  return row;
}

export async function getFeedComments(postId: string): Promise<FeedCommentRow[]> {
  const s = await ensureStorage();
  return s.getComments(postId);
}

/**
 * v4.32.64: локальное удаление комментария. Auth-guard: удалять можно только свой
 * комментарий ИЛИ комментарий под своим постом (модерация в своей ленте).
 * До этого любой мог вызвать `deleteFeedComment(любой_id)` и стереть чужой комментарий
 * локально (envelope не рассылался, но UX был сбивающим).
 */
export async function deleteFeedComment(pair: KeyPairBytes, commentId: string): Promise<void> {
  // v4.32.553: заголовок этой функции с v4.32.64 обещает «локальное удаление»,
  // а первая строка ждала сети, чтобы стереть строку в своей же базе. Рассылка
  // тумбстоуна и очередь повторов ниже — они и решают, когда уйдёт в сеть.
  const myDid = publicKeyToDidKey(pair.publicKey);
  const s = await ensureStorage();
  const meta = await s.getCommentMeta(commentId);
  if (!meta) return;
  if (meta.authorDid !== myDid) {
    // Разрешаем также удаление если юзер — автор ПОСТА (модерация своей ленты).
    const post = await s.getPost(meta.postId);
    if (!post || post.authorDid !== myDid) {
      log.warn('feed_comment_delete_not_owner', {
        commentId: commentId.slice(0, 24),
        commentAuthor: meta.authorDid.slice(0, 24),
        me: myDid.slice(0, 24),
      });
      return;
    }
  }
  await s.deleteComment(commentId);
  emitFeedUpdate();

  // v4.32.162: рассылаем envelope об удалении — иначе коммент "живёт" у других
  // юзеров локально до следующего fresh-sync'а (а он для комментов не делается),
  // то есть фактически навсегда. authorDid envelope'а = текущий юзер; получатель
  // в receiveFeedEnvelope auth-чекнет (authorDid == meta.authorDid ИЛИ authorDid == post.authorDid).
  const data: FeedCommentDeleteData = { kind: 'comment_delete', commentId };
  const payload: FeedEnvelopePayload = {
    type: 'feed_comment_delete',
    postId: meta.postId,
    authorDid: myDid,
    ts: Date.now(),
    data,
  };
  let res: Awaited<ReturnType<typeof signAndBroadcastFeedEnvelope>> = null;
  const online = await checkOnlineWrite();
  if (shouldAttemptBroadcast(online.ok)) {
    try {
      res = await signAndBroadcastFeedEnvelope(pair, payload);
      // v4.32.162: та же pubsub-публикация, что и для addAndBroadcastComment —
      // подписчики топика поста (open comment-modal у не-контактов) тоже получат delete.
      if (res) void publishToPostCommentsTopic(meta.postId, res.frame);
    } catch (e) {
      // The local delete is already committed; retain a retryable tombstone when
      // the first network attempt throws before returning a delivery result.
      log.warn('feed_comment_delete_broadcast_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  } else {
    log.info('feed_comment_delete_queued_offline', { reachability: online.reachability });
  }
  // v4.32.164 P1#2: delete без retry = вечно-живой коммент у оффлайн-получателей.
  // Аналогично addAndBroadcastComment — enqueue если доставка неполная.
  if (!res || res.delivered.success < res.delivered.total) {
    try {
      await enqueueCommentOutboxItem(pair, {
        kind: 'comment_delete',
        commentId,
        postId: meta.postId,
        ts: Date.now(),
      });
      scheduleCommentOutboxRetry(pair, RETRY_DELAY_MS);
    } catch (e) {
      log.warn('feed_comment_delete_outbox_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ─── v4.32.164 P1#2: Outbox retry для feed_comment / feed_comment_delete ────
// Отдельная лёгкая очередь (не FEED_QUEUE_KEY) — envelopes комментов не содержат
// media, payload'ы маленькие, семантика проще (нет deliveredTo-per-DID — ретраим
// всему списку контактов, receiver-side дедуп через INSERT OR IGNORE + tombstones
// делает повторную доставку идемпотентной).

const COMMENT_OUTBOX_KEY = 'feed_comment_outbox_v1';
/** TTL 7 дней — коммент старше недели не имеет смысла доставлять. */
const COMMENT_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMMENT_OUTBOX_MAX_RETRIES = 12;
const COMMENT_OUTBOX_MAX_ITEMS = 200;

type CommentOutboxItem = {
  /** Уникальный ключ очереди. Для reaction ключ также включает emoji. */
  key: string;
  /**
   * Чей это коммент (v4.32.438).
   *
   * Очередь лежит в общей записи kv, одной на всё приложение, а разбирает её
   * тот ключ, который активен в момент разбора. До этого поля недоставленный
   * коммент личного профиля уходил, подписанный РАБОЧИМ ключом и рабочим
   * контактам: текст чужой, автор — другая личность. Разделение профилей на
   * этом месте не работало вовсе.
   */
  authorDid: string;
  kind: 'comment' | 'comment_delete' | 'comment_reaction';
  commentId: string;
  postId: string;
  /** Для 'comment': текст + имя автора. Для 'comment_delete' отсутствуют. */
  text?: string;
  authorName?: string;
  emoji?: string;
  remove?: boolean;
  /** ts исходного envelope'а; сохраняем чтобы при retry отправить тот же ts (порядок на стороне получателя). */
  ts: number;
  retries: number;
  createdAt: number;
};

let commentOutboxTimer: ReturnType<typeof setTimeout> | null = null;

function clearCommentOutboxTimer(): void {
  if (commentOutboxTimer) {
    clearTimeout(commentOutboxTimer);
    commentOutboxTimer = null;
  }
}

async function loadCommentOutbox(): Promise<CommentOutboxItem[]> {
  const raw = await kvGet(COMMENT_OUTBOX_KEY);
  if (!raw) return [];
  let dropped = 0;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    // v4.32.198 (Round-28 #3): per-row validation. Corrupt/migrated kv rows
    // otherwise flow into _flushCommentOutboxImpl fanout with non-string
    // commentId/oversized text → SQL/wire errors per retry cycle.
    const clean: CommentOutboxItem[] = [];
    for (const e of p as unknown[]) {
      if (clean.length >= COMMENT_OUTBOX_MAX_ITEMS) break;
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      if (typeof r.key !== 'string' || r.key.length === 0 || r.key.length > 160) continue;
      if (r.kind !== 'comment' && r.kind !== 'comment_delete' && r.kind !== 'comment_reaction') continue;
      if (typeof r.commentId !== 'string' || r.commentId.length === 0 || r.commentId.length > 128) continue;
      if (typeof r.postId !== 'string' || r.postId.length === 0 || r.postId.length > 128) continue;
      if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) continue;
      if (typeof r.retries !== 'number' || !Number.isFinite(r.retries) || r.retries < 0) continue;
      if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) continue;
      if (r.text != null && (typeof r.text !== 'string' || r.text.length > 4096)) continue;
      if (r.authorName != null && (typeof r.authorName !== 'string' || r.authorName.length > 128)) continue;
      if (r.kind === 'comment_reaction' && (typeof r.emoji !== 'string' || r.emoji.length === 0 || r.emoji.length > 16)) continue;
      if (r.remove != null && typeof r.remove !== 'boolean') continue;
      // Записи до v4.32.438 автора не несут. Проставить им нынешний — ровно та
      // подмена личности, ради которой поле и заводится, поэтому такие записи
      // отбрасываются: коммент остаётся на своём посте, не доехал только он.
      if (typeof r.authorDid !== 'string' || !r.authorDid.startsWith('did:')) { dropped += 1; continue; }
      clean.push(e as CommentOutboxItem);
    }
    if (dropped > 0) log.info('comment_outbox_legacy_dropped', { count: dropped });
    return clean;
  } catch {
    return [];
  }
}

async function saveCommentOutbox(q: CommentOutboxItem[]): Promise<void> {
  try { await kvSet(COMMENT_OUTBOX_KEY, JSON.stringify(q)); } catch { /* noop */ }
}

/**
 * Единственный владелец файла очереди комментариев (v4.32.471).
 *
 * Тот же порядок, что у очереди публикации: читаем и пишем одной неделимой
 * операцией, а `apply` синхронна — в неё нельзя случайно вписать поход в сеть,
 * а значит нельзя и снова завести «прочитал старое, записал поверх нового».
 */
let commentQueueTx: Promise<unknown> = Promise.resolve();
async function updateCommentOutbox<T>(
  apply: (q: CommentOutboxItem[]) => { next: CommentOutboxItem[]; value: T }
): Promise<T> {
  const run = async (): Promise<T> => {
    const { next, value } = apply(await loadCommentOutbox());
    await saveCommentOutbox(next);
    return value;
  };
  const started = commentQueueTx.then(run, run);
  commentQueueTx = started.catch(() => { /* очередь транзакций не рвётся об одну неудачу */ });
  return started;
}

async function enqueueCommentOutboxItem(
  pair: KeyPairBytes,
  data: Omit<CommentOutboxItem, 'key' | 'retries' | 'createdAt' | 'authorDid'>
): Promise<void> {
  // Автор берётся из ключевой пары здесь, а не у вызывающего: забыть его тогда
  // просто негде.
  const authorDid = publicKeyToDidKey(pair.publicKey);
  const key = data.kind === 'comment_delete'
    ? `del:${data.commentId}`
    : data.kind === 'comment_reaction'
      ? `react:${data.commentId}:${data.emoji ?? ''}`
      : data.commentId;
  const createdAt = Date.now();
  const size = await updateCommentOutbox((q) => {
    // Dedup по key. Для comment_delete это стирает предыдущий 'comment' для того же id —
    // это ок: если мы удаляем то, что ещё не было доставлено, receiver всё равно получит
    // delete envelope и никогда не увидит коммент. Оптимизация трафика.
    const filtered = q.filter(
      (x) => x.key !== key && !(data.kind === 'comment_delete' && (
        x.key === data.commentId || x.key.startsWith(`react:${data.commentId}:`)
      ))
    );
    filtered.push({ ...data, authorDid, key, retries: 0, createdAt });
    // Cap на случай если очередь разрослась (DoS-guard от зависшей сети).
    const capped = filtered.slice(-COMMENT_OUTBOX_MAX_ITEMS);
    return { next: capped, value: capped.length };
  });
  log.info('comment_outbox_enqueued', { key: key.slice(0, 24), size });
}

let _commentFlushInFlight: Promise<void> | null = null;
async function flushCommentOutbox(pair: KeyPairBytes): Promise<void> {
  if (_commentFlushInFlight) return _commentFlushInFlight;
  _commentFlushInFlight = (async () => {
    try { await _flushCommentOutboxImpl(pair); }
    finally { _commentFlushInFlight = null; }
  })();
  return _commentFlushInFlight;
}

async function _flushCommentOutboxImpl(pair: KeyPairBytes): Promise<void> {
  const q = await loadCommentOutbox();
  if (q.length === 0) return;
  const myDid = publicKeyToDidKey(pair.publicKey);
  const now = Date.now();
  /**
   * Решения по записям снимка: `null` — убрать, запись — оставить в этом виде.
   * Свой снимок рассылка больше не записывает: между чтением и записью стоит
   * сеть, и комментарий, написанный за это время, стирался бы молча (v4.32.471).
   */
  const decisions = new Map<string, CommentOutboxItem | null>();
  const drop = (item: CommentOutboxItem): void => { decisions.set(item.key, null); };
  const keep = (item: CommentOutboxItem): void => { decisions.set(item.key, item); };
  for (const item of q) {
    if (now - item.createdAt > COMMENT_OUTBOX_TTL_MS) {
      log.info('comment_outbox_ttl_drop', { key: item.key.slice(0, 24), ageHours: Math.round((now - item.createdAt) / 3600_000) });
      drop(item);
      continue;
    }
    if (item.retries >= COMMENT_OUTBOX_MAX_RETRIES) {
      log.warn('comment_outbox_max_retries', { key: item.key.slice(0, 24), retries: item.retries });
      drop(item);
      continue;
    }
    // Чужая запись ждёт своего профиля: не отправляется и попытку не тратит.
    // Отправить её отсюда значило бы подписать чужой текст этим ключом и
    // разослать его контактам этого профиля.
    if (item.authorDid !== myDid) {
      keep(item);
      continue;
    }
    let payload: FeedEnvelopePayload;
    if (item.kind === 'comment') {
      const data: FeedCommentData = {
        kind: 'comment',
        commentId: item.commentId,
        text: item.text ?? '',
        authorName: item.authorName ?? '',
      };
      payload = { type: 'feed_comment', postId: item.postId, authorDid: myDid, ts: item.ts, data };
    } else if (item.kind === 'comment_delete') {
      const data: FeedCommentDeleteData = {
        kind: 'comment_delete',
        commentId: item.commentId,
      };
      payload = { type: 'feed_comment_delete', postId: item.postId, authorDid: myDid, ts: item.ts, data };
    } else {
      const data: FeedCommentReactionData = {
        kind: 'comment_reaction',
        commentId: item.commentId,
        emoji: item.emoji ?? '',
        remove: item.remove,
      };
      payload = { type: 'feed_comment_reaction', postId: item.postId, authorDid: myDid, ts: item.ts, data };
    }
    try {
      const res = await signAndBroadcastFeedEnvelope(pair, payload);
      if (res && res.delivered.success >= res.delivered.total && res.delivered.total > 0) {
        // Полная доставка — удаляем из outbox, публикуем в pubsub как завершающий штрих.
        void publishToPostCommentsTopic(item.postId, res.frame);
        log.info('comment_outbox_sent', { key: item.key.slice(0, 24), delivered: res.delivered.success });
        drop(item);
        continue;
      }
      if (res && res.delivered.total === 0) {
        // Контактов нет вообще — продолжаем ждать (не считаем retry, contact list мог
        // просто ещё не загрузиться при cold start).
        keep(item);
        continue;
      }
      // Частичная или нулевая доставка при непустом total — увеличиваем retries.
      if (res) void publishToPostCommentsTopic(item.postId, res.frame);
      keep({ ...item, retries: item.retries + 1 });
    } catch (e) {
      log.warn('comment_outbox_flush_failed', { key: item.key.slice(0, 24), err: e instanceof Error ? e.message : String(e) });
      keep({ ...item, retries: item.retries + 1 });
    }
  }
  await updateCommentOutbox((cur) => ({ next: mergeOutbox(cur, decisions), value: undefined }));
}

/** Ключ, которым будет отправлять таймер отложенных комментариев (v4.32.462). */
let commentRetryPair: KeyPairBytes | null = null;

function scheduleCommentOutboxRetry(pair: KeyPairBytes, delayMs: number): void {
  commentRetryPair = pair;
  clearCommentOutboxTimer();
  commentOutboxTimer = setTimeout(() => {
    commentOutboxTimer = null;
    void (async () => {
      const p = commentRetryPair;
      if (!p) return;
      await flushCommentOutbox(p);
      const q = await loadCommentOutbox();
      if (q.length > 0) {
        const r = q[0]?.retries ?? 0;
        // Экспоненциальная задержка, потолок 30 мин.
        const nextDelay = Math.min(RETRY_DELAY_MS * Math.pow(2, Math.min(r, 6)), 30 * 60_000);
        scheduleCommentOutboxRetry(p, nextDelay);
      }
    })();
  }, delayMs);
}

/**
 * v4.32.164: публичный API для App.tsx — вызвать из startFeedInboxListener или onAppResume,
 * чтобы дренировать оставшиеся с прошлого запуска comment-envelope'ы. Не ждёт результата.
 */
export function resumeCommentOutbox(pair: KeyPairBytes): void {
  commentRetryPair = pair;
  void (async () => {
    const q = await loadCommentOutbox();
    if (q.length === 0) return;
    log.info('comment_outbox_resume', { size: q.length });
    await flushCommentOutbox(pair);
    const tail = await loadCommentOutbox();
    if (tail.length > 0) scheduleCommentOutboxRetry(pair, RETRY_DELAY_MS);
  })();
}

export async function getFeedCommentCounts(postIds: string[]): Promise<Record<string, number>> {
  const s = await ensureStorage();
  const counts: Record<string, number> = {};
  await Promise.all(postIds.map(async (id) => {
    counts[id] = await s.getCommentCount(id);
  }));
  return counts;
}

/** Сколько контактов приняли `feed_delete`: `total` — кому слали, `success` — кто принял. */
export type FeedDeleteReach = { total: number; success: number };

/**
 * Удалить свой пост локально + разослать feed_delete.
 * v4.32.24: pair нужен чтобы подписать delete-envelope. Удалять можно только свой пост.
 * v4.32.29: предварительная auth-проверка на уровне SQL (на случай если UI вызвал для чужого)
 * + очистка kvStore от inline media.
 * v4.32.546: возвращает охват рассылки. Удаление «у всех» — доставка, а не команда
 * серверу: контакт, до которого конверт не дошёл вообще (нет ни сети, ни реле),
 * останется с публикацией, и человек имеет право это знать сразу, а не гадать.
 */
export async function deleteFeedPost(pair: KeyPairBytes, postId: string): Promise<FeedDeleteReach> {
  const myDid = publicKeyToDidKey(pair.publicKey);
  const s = await ensureStorage();
  const existing = await s.getPost(postId);
  if (!existing) return { total: 0, success: 0 };
  if (existing.authorDid !== myDid) {
    log.warn('feed_delete_not_owner', { postId: postId.slice(0, 24) });
    return { total: 0, success: 0 };
  }
  await cleanupInlinePayloads(postId);
  await s.deletePost(postId);
  emitFeedUpdate();

  const data: FeedDeleteData = { kind: 'delete' };
  const payload: FeedEnvelopePayload = {
    type: 'feed_delete',
    postId,
    authorDid: myDid,
    ts: Date.now(),
    data,
  };
  const res = await signAndBroadcastFeedEnvelope(pair, payload);
  return { total: res?.delivered.total ?? 0, success: res?.delivered.success ?? 0 };
}

/**
 * v4.32.29: toggle-реакция. Если пользователь уже реагировал этим эмодзи — снять;
 * иначе — поставить. Возвращает `true` если поставили, `false` если сняли.
 * Broadcast отправляется всегда — получатели делают ту же toggle-логику,
 * потому что `addReaction` в feedStorage уже был идемпотентным (не добавлял
 * дубликат тот же did). Для unreact шлём envelope `feed_unreaction` (новый тип).
 */
/** v4.32.64: throttle-карта per-post реакций — защита от флуд-спама envelope'ов
 *  (автотыкалки / ошибки UI-кода / accidental double-tap). Ключ — postId, значение —
 *  timestamp последней реакции. Меньше 400мс между тычками = отклоняется. */
const REACTION_THROTTLE_MS = 400;
const lastReactionAt = new Map<string, number>();

export async function toggleAndBroadcastReaction(
  pair: KeyPairBytes,
  postId: string,
  emoji: string,
): Promise<boolean> {
  const now = Date.now();
  const prev = lastReactionAt.get(postId) ?? 0;
  if (now - prev < REACTION_THROTTLE_MS) {
    log.info('feed_reaction_throttled', { postId: postId.slice(0, 24), dt: now - prev });
    // Возвращаем текущее состояние (без изменения) — не бросаем, чтобы UI не падал с Alert'ом.
    const s0 = await ensureStorage();
    const cur = await s0.getPost(postId);
    const myDid0 = publicKeyToDidKey(pair.publicKey);
    return !!cur?.reactions?.[emoji]?.includes(myDid0);
  }
  lastReactionAt.set(postId, now);
  // GC: держим только последние ~100 записей (иначе при длинных сессиях map растёт).
  if (lastReactionAt.size > 200) {
    const cutoff = now - 60_000;
    for (const [k, t] of lastReactionAt) { if (t < cutoff) lastReactionAt.delete(k); }
  }

  const myDid = publicKeyToDidKey(pair.publicKey);
  const s = await ensureStorage();
  const existing = await s.getPost(postId);
  const alreadyReacted = !!existing?.reactions?.[emoji]?.includes(myDid);
  if (alreadyReacted) {
    await s.removeReaction(postId, emoji, myDid);
  } else {
    await s.addReaction(postId, emoji, myDid);
  }
  emitFeedUpdate();

  // Даже если сняли — broadcast, чтобы у контактов тоже обновилось.
  const data: FeedReactionData = { kind: 'reaction', emoji, remove: alreadyReacted };
  const payload: FeedEnvelopePayload = {
    type: 'feed_reaction',
    postId,
    authorDid: myDid,
    ts: Date.now(),
    data,
  };
  await signAndBroadcastFeedEnvelope(pair, payload);
  return !alreadyReacted;
}

/**
 * v4.32.51: рассылает feed_poll_vote envelope всем контактам. Локальный INSERT/DELETE
 * в poll_votes должен быть выполнен caller'ом ДО этого (оптимистический update UI);
 * здесь — только сетевой броадкаст. Для toggle-unvote (multi-select) передайте `remove=true`.
 *
 * Безопасность: envelope подписан ключом голосующего (pair.publicKey = authorDid); у
 * получателя `parseAndVerifyFeedEnvelope` проверит что senderDid=authorDid — невозможно
 * подделать голос от чужого имени. Дубликаты голоса при retry идемпотентны — у receiver'а
 * setPollVote делает INSERT OR REPLACE.
 */
/** v4.32.65: throttle-карта per-post голосов в опросах. Симметрично reaction-throttle:
 *  2 быстрых тапа за <400мс сливаются в один envelope, чтобы не флудить контактов
 *  и не получать out-of-order сетевых событий при fast-click / retry-loops. */
const POLL_VOTE_THROTTLE_MS = 400;
const lastPollVoteAt = new Map<string, number>();

export async function broadcastPollVote(
  pair: KeyPairBytes,
  postId: string,
  optionIndex: number,
  remove = false,
): Promise<void> {
  const key = `${postId}:${optionIndex}`;
  const now = Date.now();
  const prev = lastPollVoteAt.get(key) ?? 0;
  if (now - prev < POLL_VOTE_THROTTLE_MS) {
    log.info('feed_poll_vote_throttled', { postId: postId.slice(0, 24), idx: optionIndex, dt: now - prev });
    return;
  }
  lastPollVoteAt.set(key, now);
  if (lastPollVoteAt.size > 200) {
    const cutoff = now - 60_000;
    for (const [k, t] of lastPollVoteAt) { if (t < cutoff) lastPollVoteAt.delete(k); }
  }
  const myDid = publicKeyToDidKey(pair.publicKey);
  const data: FeedPollVoteData = { kind: 'poll_vote', optionIndex, remove: remove || undefined };
  const payload: FeedEnvelopePayload = {
    type: 'feed_poll_vote',
    postId,
    authorDid: myDid,
    ts: Date.now(),
    data,
  };
  const result = await signAndBroadcastFeedEnvelope(pair, payload);
  log.info('feed_poll_vote_broadcast', {
    postId: postId.slice(0, 24),
    idx: optionIndex,
    remove,
    success: result?.delivered?.success ?? 0,
    total: result?.delivered?.total ?? 0,
  });
}

/**
 * Редактировать свой пост + разослать feed_edit.
 * v4.32.47: auth-guard — перед локальным UPDATE и бродкастом проверяем что постом
 * владеет текущий DID. До этого любой клиент мог вызвать `editFeedPost(pair, чужой_id, ...)`
 * и у себя на экране подменить текст чужого поста (бродкаст получатели отбрасывали через
 * auth-check в `receiveFeedEnvelope`, но локально UPDATE проходил).
 */
export async function editFeedPost(pair: KeyPairBytes, postId: string, newText: string): Promise<void> {
  const trimmed = (newText ?? '').trim();
  if (!trimmed) throw new Error('Текст не может быть пустым');
  if (trimmed.length > FEED_POST_MAX_CHARS) {
    throw new Error(`Текст слишком длинный (макс. ${FEED_POST_MAX_CHARS} символов)`);
  }
  const myDid = publicKeyToDidKey(pair.publicKey);
  const s = await ensureStorage();
  const existing = await s.getPost(postId);
  // v4.32.534: отказ обязан выглядеть как отказ. Раньше правка исчезнувшей или
  // чужой записи возвращалась обычным способом, и вызывающий код не мог отличить
  // её от удавшейся: экран закрывал редактор, стирал черновик и перечитывал
  // ленту — а текст оставался прежним. Правка пропадала молча.
  if (!existing) {
    log.warn('feed_edit_post_missing', { postId: postId.slice(0, 24) });
    throw new Error('Запись не найдена — возможно, она уже удалена');
  }
  if (existing.authorDid !== myDid) {
    log.warn('feed_edit_not_owner', {
      postId: postId.slice(0, 24),
      owner: existing.authorDid.slice(0, 24),
      me: myDid.slice(0, 24),
    });
    throw new Error('Изменить можно только свою запись');
  }
  await s.updatePostText(postId, newText);
  emitFeedUpdate();

  const data: FeedEditData = { kind: 'edit', newText };
  const payload: FeedEnvelopePayload = {
    type: 'feed_edit',
    postId,
    authorDid: myDid,
    ts: Date.now(),
    data,
  };
  await signAndBroadcastFeedEnvelope(pair, payload);
}

/**
 * v4.32.64: сигнатура изменена — DID извлекается из `pair.publicKey` (было: передача
 * `authorDid` отдельным параметром, что позволяло вызвать `toggleCommentReaction(id, pid, emoji, чужой_did)`
 * и локально поставить реакцию от чужого имени). Сейчас вызов нельзя подделать в
 * пределах приложения.
 */
const commentReactionOperations = new Map<string, Promise<FeedCommentRow[]>>();

export function toggleCommentReaction(
  pair: KeyPairBytes,
  commentId: string,
  postId: string,
  emoji: string,
): Promise<FeedCommentRow[]> {
  if (
    typeof commentId !== 'string' || commentId.length === 0 || commentId.length > 128 ||
    typeof postId !== 'string' || postId.length === 0 || postId.length > 128 ||
    typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 16
  ) {
    return Promise.reject(new Error('Недопустимая реакция'));
  }
  const operationKey = `${postId}\u0000${commentId}\u0000${emoji}`;
  const previous = commentReactionOperations.get(operationKey) ?? Promise.resolve<FeedCommentRow[]>([]);
  const operation = previous.catch(() => []).then(async () => {
    // v4.32.553: та же форма, что и у комментария — локальная запись плюс
    // очередь повторов; проверка сети переехала к рассылке.
    const authorDid = publicKeyToDidKey(pair.publicKey);
    const s = await ensureStorage();
    const comments = await s.getComments(postId);
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return comments;
    const reactions: Record<string, string[]> = comment.reactions ? { ...comment.reactions } : {};
    const existing = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
    const remove = existing.includes(authorDid);
    if (remove) {
      const remaining = existing.filter((did) => did !== authorDid);
      if (remaining.length > 0) reactions[emoji] = remaining;
      else delete reactions[emoji];
    } else {
      // v4.32.205 (Round-35 #2): cap distinct emoji keys at 64 and authors per
      // emoji at 512. Without caps a hostile peer can bloat the comment row.
      if (!(emoji in reactions) && Object.keys(reactions).length >= 64) return comments;
      if (existing.length >= 512) return comments;
      reactions[emoji] = [...existing, authorDid];
    }
    await s.updateCommentReactions(commentId, reactions);
    emitFeedUpdate();

    const payload: FeedEnvelopePayload = {
      type: 'feed_comment_reaction',
      postId,
      authorDid,
      ts: Date.now(),
      data: { kind: 'comment_reaction', commentId, emoji, remove },
    };
    let res: Awaited<ReturnType<typeof signAndBroadcastFeedEnvelope>> = null;
    const online = await checkOnlineWrite();
    if (shouldAttemptBroadcast(online.ok)) {
      try {
        res = await signAndBroadcastFeedEnvelope(pair, payload);
        if (res) void publishToPostCommentsTopic(postId, res.frame);
      } catch (e) {
        log.warn('feed_comment_reaction_broadcast_failed', { err: e instanceof Error ? e.message : String(e) });
      }
    } else {
      log.info('feed_comment_reaction_queued_offline', { reachability: online.reachability });
    }
    if (!res || res.delivered.success < res.delivered.total) {
      try {
        await enqueueCommentOutboxItem(pair, {
          kind: 'comment_reaction',
          commentId,
          postId,
          emoji,
          remove,
          ts: payload.ts,
        });
        scheduleCommentOutboxRetry(pair, RETRY_DELAY_MS);
      } catch (e) {
        log.warn('feed_comment_reaction_outbox_failed', { err: e instanceof Error ? e.message : String(e) });
      }
    }
    return s.getComments(postId);
  });
  const tracked = operation.finally(() => {
    if (commentReactionOperations.get(operationKey) === tracked) commentReactionOperations.delete(operationKey);
  });
  commentReactionOperations.set(operationKey, tracked);
  return tracked;
}
