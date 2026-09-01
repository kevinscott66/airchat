/**
 * blobRef — формат дескриптора зашифрованного вложения и его разбор.
 *
 * v4.32.244. Вынесено из mediaBlob: сам mediaBlob тянет expo-file-system и
 * транспорт, поэтому валидацию чужого дескриптора нельзя было ни проверить
 * тестом, ни позвать из слоя приёма групповых сообщений. Здесь только разбор
 * строк — ни сети, ни файлов, ни платформенных модулей.
 *
 * ВАЖНО: `nb:`-строка НЕСЁТ КЛЮЧ РАСШИФРОВКИ. Она допустима только внутри уже
 * зашифрованного конверта и никогда — в открытой внешней обёртке.
 */

// Единственный импорт — полифилл Buffer: им выводится имя файла кэша для
// дескриптора без blob-id, и повторять эту арифметику вручную значило бы
// разойтись с уже лежащими на диске файлами.
import { Buffer } from 'buffer';

import { cacheFileBlobId } from './cacheSweepPolicy';

export interface BlobRef {
  /** ntfy attachment URL (hosts the ciphertext). Может отсутствовать при
   *  чисто-LAN отправке без интернета — тогда обязателен `i`. */
  u?: string;
  /** base64 of the random XChaCha20-Poly1305 key. */
  k: string;
  /** optional MIME hint for the cached file. */
  m?: string;
  /** blob id (32 hex) — ключ LAN-доставки/локального кэша ciphertext'а. */
  i?: string;
}

const BLOB_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Потолок открытого содержимого вложения: ntfy принимает ~15 МБ, base64
 * раздувает на треть, поэтому 8 МБ — с запасом. Экран отправки обязан звать
 * тот же предел: иначе выбранный файл принимается, а отправка молча падает.
 */
export const MAX_BLOB_BYTES = 8_000_000;


/**
 * `nb:` pseudo-CID — a BlobRef serialized into the mediaCids/doc-cid slot so the
 * existing CID plumbing (rows, inner payload, renderers) can carry encrypted-blob
 * descriptors without schema changes. CARRIES THE DECRYPTION KEY: must only ever
 * travel inside AEAD-encrypted payloads, never in plaintext outer envelopes.
 */
export const NB_PREFIX = 'nb:';

export function isNbCid(s: string): boolean {
  return s.startsWith(NB_PREFIX);
}

export function makeNbCid(ref: BlobRef): string {
  return `${NB_PREFIX}${JSON.stringify(ref)}`;
}

/** Parse + shape-validate an `nb:` pseudo-CID (peer-controlled). */
export function parseNbCid(s: string): BlobRef | null {
  if (!isNbCid(s)) return null;
  try {
    const o = JSON.parse(s.slice(NB_PREFIX.length)) as unknown;
    return isBlobRef(o) ? o : null;
  } catch {
    return null;
  }
}

/** File extension (lowercase, ≤8 chars) from a filename, 'bin' fallback. */
export function fileExt(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : 'bin';
}

/** Shape-guard a parsed BlobRef coming from a peer-controlled envelope. */
export function isBlobRef(v: unknown): v is BlobRef {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const keyOk = typeof o.k === 'string' && o.k.length > 0 && o.k.length <= 64;
  const urlOk = typeof o.u === 'string' && o.u.length > 0 && o.u.length <= 512 && /^https?:\/\//.test(o.u);
  const idOk = typeof o.i === 'string' && BLOB_ID_RE.test(o.i);
  const mimeOk = o.m === undefined || (typeof o.m === 'string' && o.m.length <= 100);
  // Хотя бы один источник ciphertext'а: HTTP url (relay) или LAN blob id.
  return keyOk && mimeOk && (urlOk || idOk) && (o.u === undefined || urlOk) && (o.i === undefined || idOk);
}

/**
 * Имя файла в кэше расшифрованного вложения выводится из дескриптора:
 * `airchat_media_<id>.<ext>`. Один и тот же дескриптор обязан давать один и
 * тот же id, иначе каждое открытие снимка расшифровывало бы его заново.
 *
 * v4.32.272: вывод id жил внутри resolveBlobToLocalFile и был недоступен
 * ниоткуда больше — а он нужен, чтобы стереть кэш вложения вместе с исчезнувшим
 * сообщением. Возвращает null, если дескриптор негодный.
 */
export function blobCacheId(ref: BlobRef): string | null {
  if (!isBlobRef(ref)) return null;
  if (ref.i) return ref.i;
  if (!ref.u) return null;
  const m = ref.u.match(/\/file\/([A-Za-z0-9._-]+)/);
  if (m) return m[1].replace(/[^A-Za-z0-9._-]/g, '');
  return Buffer.from(ref.u).toString('hex').slice(0, 24);
}

/** Приставка файла расшифрованного вложения в кэше приложения. */
export const BLOB_CACHE_PREFIX = 'airchat_media_';

/**
 * Обратное к blobCacheId: `airchat_media_<id>.<ext>` → id, иначе null.
 *
 * v4.32.361: правило жило приватным в mediaBlob, а знать «наш ли это файл»
 * нужно и хранилищу — иначе, стирая медиа истёкшей сторис, оно удалило бы и
 * снимок, выбранный из галереи и лежащий в том же кэше.
 *
 * v4.32.518: разбор имени переехал в cacheSweepPolicy. Уборщику кэша нужно то
 * же самое, но ещё и для приставки LAN-шифротекста, а два разбора одного и
 * того же имени рано или поздно разошлись бы — и разошлись бы именно в том
 * месте, где один считает файл нашим, а другой нет.
 */
export function cachedBlobIdOf(fileName: string): string | null {
  return cacheFileBlobId(fileName, [BLOB_CACHE_PREFIX]);
}

/** Наш ли это файл расшифрованного вложения — по адресу, а не по имени. */
export function isDecryptedBlobUri(uri: string): boolean {
  const name = uri.split('?')[0]?.split('/').pop() ?? '';
  return cachedBlobIdOf(name) !== null;
}

/** id вложения из LAN-дескриптора (32 hex) и из ntfy-ссылки `/file/<id>`. */
const BLOB_ID_SCAN_RE = /[0-9a-f]{32}/g;
const BLOB_URL_SCAN_RE = /\/file\/([A-Za-z0-9._-]+)/g;

/**
 * Все id вложений, упомянутые в произвольной строке — колонке media_cids или
 * тексте сообщения (голосовое и документ несут дескриптор внутри своего JSON,
 * а не в media_cids).
 *
 * Намеренно сканирование по образцу, а не разбор JSON: префиксов у полезной
 * нагрузки полтора десятка, и стоит появиться новому — разбор бы его молча
 * пропустил, а вместе с ним и удаление кэша. Множество получается с запасом:
 * случайная 32-значная шестнадцатеричная последовательность в тексте тоже
 * попадёт сюда. Это безопасно ровно потому, что одна и та же функция считает и
 * «что удаляем», и «что ещё используется»: лишний id одинаково попадает в оба
 * множества, а файла `airchat_media_<лишний id>` на диске просто нет.
 *
 * Не покрывает дескриптор без `i` и без `/file/` в ссылке — там id выводится
 * хешированием всей ссылки. Промах означает, что файл кэша не удалён; потерять
 * чужое вложение промах не может.
 */
export function blobCacheIdsIn(s: string | null | undefined): string[] {
  if (!s) return [];
  const out = new Set<string>();
  for (const m of s.matchAll(BLOB_ID_SCAN_RE)) out.add(m[0]);
  for (const m of s.matchAll(BLOB_URL_SCAN_RE)) out.add(m[1].replace(/[^A-Za-z0-9._-]/g, ''));
  return [...out];
}

/**
 * Локальные записи голосовых сообщений, упомянутые в строке.
 *
 * v4.32.274: у голосового кроме зашифрованного блоба есть ещё и сама запись —
 * файл диктофона на устройстве отправителя. Конверт несёт его адрес, потому что
 * своё голосовое проигрывается именно с него (см. voiceUriPolicy), и после
 * исчезновения сообщения запись оставалась лежать на диске: сообщения нет, а
 * голос есть.
 *
 * Ищется ровно та форма, которую пишет makeVoiceText — `\x01voice:{"uri":"…`.
 * Разбирать JSON нельзя: голосовое встречается и вложенным (пересылка), а
 * сканирование находит его в любой обёртке. Промах означает, что файл не
 * удалён; удалить лишнее эта форма не может — она слишком узкая.
 *
 * Вложенная копия выглядит иначе, и это важнее, чем кажется: JSON.stringify
 * экранирует и кавычки, и сам управляющий префикс — `\x01` превращается в
 * буквальные шесть символов `\u0001`. Пересылка пересылки накладывает
 * экранирование ещё раз. Не узнай мы такую копию, она не попала бы в число
 * живых ссылок — и удаление оригинала унесло бы запись, которую она
 * проигрывает.
 */
// Управляющий символ в шаблоне намеренный: '\x01' — это префикс голосового в
// протоколе, и искать надо именно его, а не похожий текст.
// eslint-disable-next-line no-control-regex
const VOICE_FILE_URI_RE = /(?:\x01|\\+u0001)voice:\{\\*"uri\\*"\s*:\s*\\*"(file:\/\/[^"\\]+)/g;

export function voiceFileUrisIn(s: string | null | undefined): string[] {
  if (!s) return [];
  const out = new Set<string>();
  for (const m of s.matchAll(VOICE_FILE_URI_RE)) out.add(m[1]);
  return [...out];
}

/**
 * MIME-подсказка для снимка по расширению файла. Нужна только для имени
 * локального кэша и заголовка при открытии; неизвестное расширение — jpeg,
 * потому что камера отдаёт именно его.
 */
export function guessImageMime(uriOrName: string): string {
  const ext = fileExt(uriOrName.split('?')[0] ?? '');
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}
