/**
 * storyService — публикация и получение Stories (эфемерных сторис, 24ч).
 *
 * Протокол:
 * - Медиа уходит зашифрованным вложением (nb:), а при включённом IPFS — в IPFS.
 * - JSON-конверт (см. storyEnvelope) рассылается каждому контакту обычным
 *   зашифрованным личным сообщением с управляющим префиксом; получатель
 *   применяет его через handleIncomingStory и в переписке его не видит.
 * - Сторис истекают через 24 часа (expiresAt).
 *
 * v4.32.246: раньше конверт публиковался в pubsub-топик
 * "/airchat/v1/stories/<contactPubB64>", а pubsub работает поверх IPFS,
 * выключенного на телефоне с v4.32.19. Опубликованная сторис не уходила
 * никуда, а чужие не приходили никогда: pubsubSubscribe сразу возвращал null.
 * Топик оставлен для сборок с включённым IPFS — он теперь дополнение, а не
 * единственный путь.
 */

import { v4 as uuidv4 } from 'uuid';
import type { KeyPairBytes } from '../crypto/keyManager';
import { publicKeyToDidKey } from '../identity/did';
import { ownerPidForPublicKey } from '../identity/ownerPidLookup';
import { listContactsFor } from './contacts';
import { catFromIpfs } from '../transport/ipfs/node';
import { pubsubPublish, pubsubSubscribe } from '../transport/ipfs/pubsub';
import { insertStory, deleteExpiredStories, countActiveStoriesByAuthor, STORY_TTL_MS } from '../storage/local';
import { decodeStoryEnvelope, encodeStoryEnvelope, STORY_PREFIX, type StoryEnvelope } from './storyEnvelope';
import { isNbCid, parseNbCid, resolveBlobToLocalFile } from '../media/mediaBlob';
import { uploadMediaToCid } from '../media/mediaUpload';
import { IPFS_VIDEO_MAX_BYTES } from '../media/uploadRoute';
import type { StoryMediaFailure, StoryPublishOutcome } from './storyPublishOutcome';
import { log } from '../logger';

const STORY_TOPIC_PREFIX = '/airchat/v1/stories/';

/**
 * Потолок одновременно живых сторис от одного автора.
 *
 * v4.32.248: своих ограничений у приёма не было вовсе — сколько конвертов
 * контакт прислал, столько строк в базе и столько загрузок вложений (каждое
 * до 8 МБ) получатель и делал, ничего для этого не нажимая. Тридцать штук за
 * сутки жизни сторис — заведомо больше, чем публикует живой человек.
 */
const STORY_MAX_PER_AUTHOR = 30;

/**
 * Идентификатор строки для ЧУЖОЙ сторис.
 *
 * v4.32.248: id приходит из конверта, а вставка идёт INSERT OR IGNORE — то
 * есть первый пришедший занимает id навсегда. Контакт, получивший чужую
 * сторис, знал её id и мог тут же прислать свою с тем же id: у общего
 * знакомого настоящая сторис молча пропадала, а на её месте оказывалась
 * подставленная. Приписанный ключ автора делает столкновение невозможным.
 *
 * Идентификатор используется только на устройстве (отметка о просмотре и
 * удаление своей сторис) и наружу в таком виде не уходит.
 */
function localStoryId(authorPubB64: string, envelopeId: string): string {
  return `${authorPubB64}:${envelopeId}`;
}

let inboxUnsub: (() => void) | null = null;
// v4.32.191 (Round-21 #8): sentinel closes the double-subscription race
// where two calls to startStoryInboxListener fire before the first
// pubsubSubscribe resolves — both would succeed and we'd leak one unsub.
let inboxSubscribing = false;
/** Колбэк «пришла сторис» — общий для pubsub и для личных сообщений. */
let storyArrivalCb: (() => void) | null = null;

// ─── Story update event bus ───────────────────────────────────────────────────
const storyListeners = new Set<() => void>();

export function subscribeStoryUpdates(cb: () => void): () => void {
  storyListeners.add(cb);
  return () => storyListeners.delete(cb);
}

function notifyStoryListeners(): void {
  storyListeners.forEach((cb) => cb());
}

/**
 * Результат публикации.
 *
 * v4.32.360: раньше о медиа сообщал один `mediaFailed: boolean`, и экран
 * объяснял любую неудачу одинаково — «слишком большое, предел 8 МБ».
 * Оборванная загрузка выглядела как превышение размера, а сам предел зависит
 * от того, включён ли IPFS, и восемью мегабайтами не исчерпывается.
 *
 * `delivered`/`contacts` — сколько контактов получило конверт. Ноль при
 * непустом списке означает, что сторис осталась только на устройстве: строка
 * в базе создаётся до рассылки, поэтому автору она видна в любом случае.
 */
export type PublishStoryResult = StoryPublishOutcome & { storyId: string };

/** Encode a story envelope and broadcast to all contacts. */
export async function publishStory(
  pair: KeyPairBytes,
  mediaUri: string | null,
  text: string | null,
  mediaType: 'image' | 'video' = 'image'
): Promise<PublishStoryResult> {
  const myPubB64 = Buffer.from(pair.publicKey).toString('base64');
  const myDid = publicKeyToDidKey(pair.publicKey);
  const pid = ownerPidForPublicKey(pair.publicKey);
  const now = Date.now();

  // Медиа: общий путь загрузки — IPFS, если он включён, иначе зашифрованное
  // вложение.
  //
  // v4.32.360: здесь файл читался целиком в base64 БЕЗ единой проверки
  // размера, и только потом отдавался в addToIpfs — на телефоне тот всегда
  // возвращает null, после чего uploadEncryptedBlob читал тот же файл второй
  // раз. Минутное видео с камеры — это сотня мегабайт, а чтение в base64
  // стоит втрое больше самого файла: приложение падало по памяти ещё до
  // того, как хоть кто-то сравнил размер с пределом.
  let mediaCid: string | null = null;
  let mediaFailure: StoryMediaFailure | null = null;
  if (mediaUri) {
    const up = await uploadMediaToCid(mediaUri, {
      mime: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      ipfsMaxBytes: mediaType === 'video' ? IPFS_VIDEO_MAX_BYTES : undefined,
    });
    if (up.ok) mediaCid = up.cid;
    else {
      mediaFailure = { reason: up.reason, limitBytes: up.limitBytes };
      log.warn('story_media_upload_failed', { reason: up.reason, limit: up.limitBytes });
    }
  }

  const storyId = uuidv4();
  const envelope: StoryEnvelope = {
    id: storyId,
    authorPubB64: myPubB64,
    authorDid: myDid,
    mediaCid,
    mediaType,
    text,
    expiresAt: now + STORY_TTL_MS,
    createdAt: now,
  };

  // Save locally
  await insertStory({
    id: storyId,
    authorPubB64: myPubB64,
    mediaUri,
    mediaType,
    text,
    expiresAt: now + STORY_TTL_MS,
    viewedBy: null,
    ownerProfileId: pid,
    createdAt: now,
  });

  // Рассылка контактам. Основной путь — личное сообщение с управляющим
  // префиксом: он шифруется и доезжает через тот же транспорт, что переписка.
  const contacts = await listContactsFor(pid);
  const text2 = encodeStoryEnvelope(envelope);
  const payload = new TextEncoder().encode(JSON.stringify(envelope));
  const { getMessagingService } = await import('./messaging');
  const svc = getMessagingService();
  let delivered = 0;
  await Promise.allSettled(
    contacts.map(async (c) => {
      try {
        if (svc) {
          await svc.sendMessage(c.peerPublicKey, text2);
          delivered += 1;
        }
      } catch (e) {
        log.debug('story_send_failed', { contact: c.peerPublicKey.slice(0, 8) });
      }
      // Дополнительно — прежний pubsub-топик: в сборке с включённым IPFS он
      // по-прежнему работает, а на телефоне это холостой вызов.
      try {
        await pubsubPublish(`${STORY_TOPIC_PREFIX}${c.peerPublicKey}`, payload);
      } catch {
        /* pubsub недоступен — основной путь уже отработал */
      }
    })
  );

  log.info('story_published', { storyId: storyId.slice(0, 8), contacts: contacts.length, delivered });
  notifyStoryListeners();
  return { storyId, mediaFailure, contacts: contacts.length, delivered };
}

/**
 * Скачать медиа сторис и вернуть локальный адрес для показа.
 *
 * Два источника: зашифрованное вложение (`nb:`) — расшифровывается в файл
 * кэша; обычный CID — читается из IPFS и кладётся в data:-адрес.
 */
export async function resolveStoryMedia(mediaCid: string, mediaType: 'image' | 'video'): Promise<string | null> {
  if (isNbCid(mediaCid)) {
    const ref = parseNbCid(mediaCid);
    if (!ref) return null;
    // Файл кэша, а не data:-строка: видео сторис в base64 внутри SQLite —
    // десятки мегабайт в строке, на слабом устройстве это заметная пауза.
    return resolveBlobToLocalFile(ref, mediaType === 'video' ? 'mp4' : 'jpg');
  }
  const bytes = await catFromIpfs(mediaCid);
  if (!bytes) return null;
  // Потолок распакованного медиа: контакт может выложить в IPFS сотни
  // мегабайт и прислать CID — base64 в SQLite подвесил бы JS-поток.
  const max = mediaType === 'video' ? 40 * 1024 * 1024 : 10 * 1024 * 1024;
  if (bytes.byteLength > max) {
    log.warn('story_media_oversize_drop', { cid: mediaCid.slice(0, 12), bytes: bytes.byteLength });
    return null;
  }
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mediaType === 'video' ? 'video/mp4' : 'image/jpeg'};base64,${b64}`;
}

/**
 * Общая часть приёма: проверка автора, скачивание медиа, запись в базу.
 * Конверт к этому моменту уже разобран и проверен по форме.
 */
async function applyIncomingStory(envelope: StoryEnvelope, pid: number): Promise<void> {
  // Автор обязан быть в контактах: свои сторис пишутся напрямую в publishStory,
  // поэтому здесь остаются только чужие, и незнакомец ничего не подсунет.
  //
  // v4.32.361: обе проверки ниже раньше глотали свою ошибку и пропускали
  // конверт дальше — «не повод терять сторис». Разрешение по умолчанию: DM
  // приходит от кого угодно, знающего наш ключ, и единственное, что отделяет
  // ленту сторис от чужих картинок, — этот список контактов. Сбой чтения базы
  // делал ленту открытой, а следом та же база принимала запись — то есть
  // «не прочиталось» и «нечем сохранять» происходят вместе. Теперь конверт
  // отбрасывается: сторис живёт сутки, контакт публикует их пачками, и потеря
  // одной стоит несравнимо меньше принятой чужой.
  try {
    const contacts = await listContactsFor(pid);
    if (!contacts.some((c) => c.peerPublicKey === envelope.authorPubB64)) {
      log.debug('story_author_not_in_contacts_drop', { author: envelope.authorPubB64.slice(0, 8) });
      return;
    }
  } catch (e) {
    log.warn('story_contacts_unreadable_drop', { err: e instanceof Error ? e.message : String(e) });
    return;
  }

  // Потолок проверяется ДО скачивания медиа: именно загрузка вложения, а не
  // строка в базе, стоит дорого.
  try {
    const already = await countActiveStoriesByAuthor(envelope.authorPubB64, pid);
    if (already >= STORY_MAX_PER_AUTHOR) {
      log.warn('story_author_limit_drop', {
        author: envelope.authorPubB64.slice(0, 8),
        active: already,
      });
      return;
    }
  } catch (e) {
    log.warn('story_count_unreadable_drop', { err: e instanceof Error ? e.message : String(e) });
    return;
  }

  // Медиа скачивается СРАЗУ, а не при открытии сторис, и это не оплошность:
  // сторис живёт сутки, а вложение на relay — около трёх часов (см. mediaBlob).
  // Отложенная загрузка означала бы, что открытая вечером сторис пустая.
  let mediaUri: string | null = null;
  if (envelope.mediaCid) {
    try {
      mediaUri = await resolveStoryMedia(envelope.mediaCid, envelope.mediaType);
    } catch {
      // оффлайн — сторис покажется текстом
    }
  }

  await insertStory({
    id: localStoryId(envelope.authorPubB64, envelope.id),
    authorPubB64: envelope.authorPubB64,
    mediaUri,
    mediaType: envelope.mediaType,
    text: envelope.text,
    expiresAt: envelope.expiresAt,
    viewedBy: null,
    ownerProfileId: pid,
    createdAt: envelope.createdAt,
  });

  await deleteExpiredStories(pid);
  storyArrivalCb?.();
  notifyStoryListeners();
  log.info('story_received', { from: envelope.authorPubB64.slice(0, 8) });
}

/**
 * Входящая сторис личным сообщением. Возвращает true, если конверт наш, —
 * тогда messaging не сохраняет его как обычное сообщение переписки.
 *
 * Отправитель проверяется по DM-слою: конверт с чужим authorPubB64 не
 * принимается, иначе контакт публиковал бы сторис от имени другого контакта.
 */
export async function handleIncomingStory(
  text: string,
  senderPubB64: string,
  ownerPid: number
): Promise<boolean> {
  const envelope = decodeStoryEnvelope(text, Date.now());
  if (!envelope) return true;
  if (envelope.authorPubB64 !== senderPubB64) {
    log.warn('story_author_mismatch_drop', { from: senderPubB64.slice(0, 8), claimed: envelope.authorPubB64.slice(0, 8) });
    return true;
  }
  try {
    await applyIncomingStory(envelope, ownerPid);
  } catch (e) {
    log.warn('story_apply_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return true;
}

/** Subscribe to incoming stories from contacts. */
export function startStoryInboxListener(
  pair: KeyPairBytes,
  onNewStory: () => void
): void {
  storyArrivalCb = onNewStory;
  if (inboxUnsub || inboxSubscribing) return;
  inboxSubscribing = true;

  const myPubB64 = Buffer.from(pair.publicKey).toString('base64');
  const topic = `${STORY_TOPIC_PREFIX}${myPubB64}`;
  // Топик выведен из пары ключей — и профиль тоже, а не из активного.
  const ownerPid = ownerPidForPublicKey(pair.publicKey);

  void pubsubSubscribe(topic, async ({ data }) => {
    try {
      // Потолок до TextDecoder+JSON.parse: в топик пишет кто угодно, и 100 МБ
      // мусора не должны валить устройство. Настоящий конверт — пара килобайт.
      if (data.byteLength > 2 * 1024 * 1024) return;
      // Тот же кодек, что и у личных сообщений: топик открыт для любого
      // участника pubsub, поэтому конверт проверяется целиком, а автор обязан
      // быть в контактах (проверка в applyIncomingStory).
      const envelope = decodeStoryEnvelope(STORY_PREFIX + new TextDecoder().decode(data), Date.now());
      if (!envelope) return;
      await applyIncomingStory(envelope, ownerPid);
    } catch (e) {
      log.warn('story_inbox_parse_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }).then((unsub) => {
    // If stop was called while subscribe was in flight, immediately tear down.
    if (!inboxSubscribing) {
      try { unsub?.(); } catch { /* */ }
      return;
    }
    inboxUnsub = unsub ?? null;
    inboxSubscribing = false;
  }).catch((e) => {
    inboxSubscribing = false;
    log.warn('story_subscribe_failed', { err: e instanceof Error ? e.message : String(e) });
  });
}

export function stopStoryInboxListener(): void {
  inboxSubscribing = false;
  inboxUnsub?.();
  inboxUnsub = null;
}
