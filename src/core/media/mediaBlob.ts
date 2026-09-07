/**
 * mediaBlob — E2E-encrypted media transport over the ntfy relay's attachment
 * store, for mobile where IPFS is kill-switched and the ntfy text channel is
 * capped at 3 KB (too small for audio/images/files).
 *
 * Flow:
 *   upload:   plaintext bytes --XChaCha20Poly1305(randomKey)--> ciphertext
 *             --base64--> PUT https://<relay>/<random-topic> (ntfy attachment)
 *             --> { url, key } descriptor (the key travels ONLY inside the
 *             already-E2E-encrypted DM/group envelope, never in cleartext).
 *   download: GET url --base64 decode--> ciphertext --decrypt(key)--> bytes
 *             --> cached local file:// for the player/viewer.
 *
 * The attachment URL on ntfy.sh is unauthenticated and retained ~3h, so the
 * blob MUST be encrypted before upload — which it is, with a fresh random key
 * per blob. An eavesdropper with the URL gets only ciphertext.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { randomBytes } from '@noble/hashes/utils.js';
import { encryptSymmetric, decryptSymmetric, SYMMETRIC_KEY_BYTES } from '../crypto/encrypt';
import { getInternetTransportSingleton } from '../transport/internet/internetTransport';
import { log } from '../logger';
import { blobCacheName, BLOB_CACHE_PREFIX, cachedBlobIdOf, isBlobRef, MAX_BLOB_BYTES, type BlobRef } from './blobRef';
import { cacheFileBlobId, classifyCacheFile, sweepVerdict } from './cacheSweepPolicy';
import { fileSizeBytes } from './fileSize';
import { isAllowedBlobUrl, isInsideCacheDir } from './mediaUrlPolicy';
import { getConfigSync } from '../config';
import { getMnemonicGeneration, getStoredMnemonic, deriveKeyPairFromMnemonic } from '../backup/seedPhrase';
import { downloadSyncMedia, uploadSyncMedia } from '../sync/syncApi';


/** Download cap: reject an oversized/abusive attachment before buffering it. */
const MAX_DOWNLOAD_B64_CHARS = 12_000_000;

/** Релей по умолчанию — тот же адрес, что в DEFAULT_CONFIG.internet. */
const DEFAULT_RELAY = 'https://ntfy.sh';

/** Decrypted/ciphertext blob cache file prefixes (this module + lanBlob). The
 *  source ntfy attachments only live ~3h, so a generous local TTL is plenty. */
const CACHE_PREFIXES = [BLOB_CACHE_PREFIX, 'airchat_blobcache_'];
const CACHE_TTL_MS = 24 * 60 * 60_000; // 24h

async function uploadCloudMediaCopy(idHex: string, cipher: Uint8Array, mime: string | undefined, generation: number): Promise<void> {
  if (!getConfigSync().cloudBackup?.enabled) return;
  try {
    if (getMnemonicGeneration() !== generation) return;
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic) return;
    if (getMnemonicGeneration() !== generation) return;
    const pair = deriveKeyPairFromMnemonic(mnemonic);
    // v4.32.617: ответ читается. uploadSyncMedia возвращает `response.ok`, и
    // отброшенный результат превращал сервер, ответивший `{"ok":false}`, в
    // запись `blob_upload_cloud_ok` — то есть в утверждение, что долговечная
    // копия есть, когда её нет.
    const stored = await uploadSyncMedia(mnemonic, pair, idHex, cipher, mime);
    if (!stored) {
      log.warn('blob_upload_cloud_rejected', { id: idHex.slice(0, 8), bytes: cipher.length });
      return;
    }
    log.info('blob_upload_cloud_ok', { id: idHex.slice(0, 8), bytes: cipher.length });
  } catch (e) {
    // The relay/LAN paths remain authoritative for this send. Cloud media is
    // best-effort so a temporary VPS outage cannot turn a message into a
    // failed send.
    log.warn('blob_upload_cloud_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

async function downloadCloudMediaCopy(idHex: string): Promise<Uint8Array | null> {
  if (!getConfigSync().cloudBackup?.enabled) return null;
  try {
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic) return null;
    return await downloadSyncMedia(mnemonic, deriveKeyPairFromMnemonic(mnemonic), idHex);
  } catch (e) {
    log.warn('blob_download_cloud_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Откуда уборщик узнаёт, на какие вложения ещё ссылается база.
 *
 * Параметром, а не импортом: хранилище само зовёт этот модуль, чтобы стереть
 * файлы удалённых сообщений, и статическая связь в обе стороны замкнула бы
 * кольцо. Отложенный `import()` кольцо бы разорвал, но ценой того, что сбой
 * этого импорта виден только в логе живого устройства — а для решения об
 * удалении файлов такая слепая зона недопустима. Кто зовёт уборку, тот и
 * передаёт источник: связь становится обычным аргументом.
 */
export type LiveBlobIdsLoader = () => Promise<ReadonlySet<string>>;

/**
 * Убрать файлы кэша вложений, которые отслужили своё.
 *
 * Зовётся один раз при запуске. Без уборки эти файлы копятся бесконечно (по
 * одному на полученный снимок, голос и документ, а на LAN-пути по два) и не попадают
 * под «Очистить кэш» в настройках.
 *
 * v4.32.518: одного возраста для удаления недостаточно. Здешние файлы — не
 * всегда кэш: у вложения, приехавшего по LAN, шифротекст здесь единственный в
 * природе, а у приехавшего с релея вложение на ntfy живёт около трёх часов —
 * к суткам расшифрованная копия тоже остаётся одна. Поэтому стирается только то,
 * на что не ссылается ни одна уцелевшая строка базы (см. cacheSweepPolicy).
 *
 * Порядок важен: сначала дешёвый проход по каталогу, и только если просроченное
 * вообще нашлось — расшифровка всей переписки ради списка живых ссылок. На
 * чистом кэше запуск стоит ровно одного чтения каталога, как и раньше.
 */
export async function sweepMediaCache(loadLiveIds: LiveBlobIdsLoader, ttlMs: number = CACHE_TTL_MS): Promise<void> {
  try {
    const dir = FileSystem.cacheDirectory;
    if (!dir) return;
    const names = await FileSystem.readDirectoryAsync(dir);
    const now = Date.now();
    const expired: string[] = [];
    for (const name of names) {
      if (cacheFileBlobId(name, CACHE_PREFIXES) === null) continue;
      try {
        const info = await FileSystem.getInfoAsync(`${dir}${name}`);
        // modificationTime is in SECONDS (epoch) per expo-file-system.
        const ageMs = info.exists && info.modificationTime ? now - info.modificationTime * 1000 : Infinity;
        if (classifyCacheFile(name, ageMs, ttlMs, CACHE_PREFIXES) === 'expired') expired.push(name);
      } catch { /* skip this file */ }
    }
    if (expired.length === 0) return;
    // Сбой — занятая база, недоступный ключ, битая строка — оставляет liveIds
    // равным null, а null останавливает уборку целиком. Место на диске
    // вернётся при следующем запуске, удалённое вложение не вернётся никогда.
    let liveIds: ReadonlySet<string> | null = null;
    try {
      liveIds = await loadLiveIds();
    } catch (e) {
      log.warn('media_cache_live_refs_failed', { err: e instanceof Error ? e.message : String(e) });
    }
    let removed = 0;
    for (const name of expired) {
      // Возраст уже проверен выше; передаётся Infinity, чтобы решение оставалось
      // целиком за sweepVerdict, а не располагалось пополам здесь и там.
      if (sweepVerdict(name, Infinity, ttlMs, CACHE_PREFIXES, liveIds) !== 'delete') continue;
      try {
        await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
        removed++;
      } catch { /* skip this file */ }
    }
    if (removed > 0) log.info('media_cache_swept', { removed, kept: expired.length - removed });
  } catch (e) {
    log.warn('media_cache_sweep_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

// Полная очистка кэша при сбросе устройства живёт в cacheFiles (v4.32.310):
// там же лежат имена всех временных файлов, а не только вложений. Отдельная
// purgeMediaCache здесь была бы вторым списком имён — ровно тем расхождением,
// из-за которого расшифрованная переписка и осталась неубранной.

/**
 * Стереть расшифрованные файлы кэша для перечисленных id вложений.
 *
 * v4.32.272: исчезающие сообщения удаляли строку в БД, а расшифрованный снимок,
 * голосовое или документ оставались лежать в кэше приложения до суточной чистки
 * sweepMediaCache. Из интерфейса до них было уже не добраться, но на диске они
 * были — открытым текстом, и функция, вся суть которой в удалении, обещанного
 * не выполняла.
 *
 * Ciphertext-кэш LAN (`airchat_blobcache_`) намеренно не трогаем: он без ключа
 * бесполезен, а ключ лежал в удалённой строке. Возвращает число удалённых
 * файлов. Best-effort: недоступный файл пропускается.
 */
export async function deleteCachedBlobs(ids: Iterable<string>): Promise<number> {
  // Пустая строка отсеивается намеренно: cachedBlobIdOf отдаёт null для чужого
  // файла, и попади '' в множество — под удаление ушёл бы весь кэш приложения.
  const wanted = new Set([...ids].filter((s) => s.length > 0));
  if (wanted.size === 0) return 0;
  try {
    const dir = FileSystem.cacheDirectory;
    if (!dir) return 0;
    const names = (await FileSystem.readDirectoryAsync(dir)).filter((n) => {
      const id = cachedBlobIdOf(n);
      return !!id && wanted.has(id);
    });
    let removed = 0;
    for (const name of names) {
      try {
        await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
        removed++;
      } catch { /* skip this file */ }
    }
    if (removed > 0) log.info('media_cache_disappeared_removed', { removed });
    return removed;
  } catch (e) {
    log.warn('media_cache_delete_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/**
 * Какие из перечисленных вложений вообще лежат в кэше расшифрованными.
 *
 * Дешёвая проверка одним чтением каталога. Нужна, чтобы не платить полным
 * проходом по всей переписке ради удаления текстового сообщения, у которого
 * вложений не было вовсе, — а таких подавляющее большинство.
 */
export async function cachedBlobIdsPresent(ids: Iterable<string>): Promise<string[]> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  try {
    const dir = FileSystem.cacheDirectory;
    if (!dir) return [];
    const found = new Set<string>();
    for (const name of await FileSystem.readDirectoryAsync(dir)) {
      const id = cachedBlobIdOf(name);
      if (id && wanted.has(id)) found.add(id);
    }
    return [...found];
  } catch {
    return [];
  }
}

/**
 * Стереть локальные файлы по их file:// адресам — но только те, что лежат в
 * кэше приложения.
 *
 * v4.32.274. Ограничение по каталогу здесь главное: адрес приходит из строки
 * сообщения, и без него функция стирала бы что угодно, до чего дотянется
 * приложение — в том числе оригинал снимка в галерее пользователя. Кэш
 * приложения — единственное место, куда файл кладём мы сами и где он
 * принадлежит ровно этому сообщению.
 */
export async function deleteCachedFileUris(uris: Iterable<string>): Promise<number> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return 0;
  let removed = 0;
  for (const uri of uris) {
    // v4.32.354: проверка по началу строки этого ограничения не давала —
    // `<кэш>/../databases/airchat.db` ей удовлетворял. См. isInsideCacheDir.
    if (!isInsideCacheDir(uri, dir)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      removed++;
    } catch { /* skip this file */ }
  }
  if (removed > 0) log.info('voice_recording_disappeared_removed', { removed });
  return removed;
}

/** Какие из перечисленных адресов кэша существуют на диске. */
export async function cachedFileUrisPresent(uris: Iterable<string>): Promise<string[]> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return [];
  const out: string[] = [];
  for (const uri of uris) {
    if (!isInsideCacheDir(uri, dir)) continue;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) out.push(uri);
    } catch { /* недоступный файл считаем отсутствующим */ }
  }
  return out;
}

// v4.32.244: формат дескриптора и его разбор живут в чистом модуле blobRef —
// оттуда их может звать слой приёма групповых сообщений, не подтягивая
// expo-file-system и транспорт. Здесь только реэкспорт, чтобы существующие
// импорты из mediaBlob продолжали работать.
export type { BlobRef } from './blobRef';
export { NB_PREFIX, MAX_BLOB_BYTES, isNbCid, makeNbCid, parseNbCid, fileExt, isBlobRef } from './blobRef';

function relayBase(): string {
  try {
    const r = getInternetTransportSingleton().getStatus().relay;
    if (r && /^https?:\/\//.test(r)) return r.replace(/\/+$/, '');
  } catch { /* fall through */ }
  return DEFAULT_RELAY;
}

/**
 * Адреса, с которых позволено забирать вложения (см. isAllowedBlobUrl).
 *
 * Три источника, потому что ни одного по отдельности не хватает: у транспорта
 * адрес актуальный, но только если транспорт уже поднят; в конфиге — тот, что
 * выбрал владелец устройства, и он нужен как раз до подъёма транспорта; ntfy.sh
 * — заводской, с которым приложение уходит с полки.
 */
function allowedRelayBases(): string[] {
  const bases = new Set<string>([relayBase(), DEFAULT_RELAY]);
  try {
    const configured = getConfigSync().internet?.relayBase;
    if (configured) bases.add(configured);
  } catch { /* конфиг недоступен — остаются транспортный и заводской */ }
  return [...bases];
}

/**
 * Encrypt the file at `uri` with a fresh random key and upload the ciphertext
 * to the relay's attachment store. Returns a descriptor to embed inside the
 * (E2E-encrypted) message envelope, or null on failure.
 */
export async function uploadEncryptedBlob(uri: string, mime?: string, targetDid?: string): Promise<BlobRef | null> {
  const generation = getMnemonicGeneration();
  try {
    // v4.32.358: размер спрашиваем до чтения. Проверка ниже смотрела на длину
    // уже поднятого в память файла — то есть от переполнения не защищала вовсе:
    // до неё успевали появиться base64-строка и два двоичных буфера, суммарно
    // втрое больше самого файла. Один stat дешевле любого из них.
    const declared = await fileSizeBytes(uri);
    if (declared !== null && (declared === 0 || declared > MAX_BLOB_BYTES)) {
      log.warn('blob_upload_bad_size', { bytes: declared, beforeRead: true });
      return null;
    }
    // v4.32.617: когда размер неизвестен, читается не весь файл, а предел плюс
    // байт. Проверка ниже была единственной защитой в этом случае, но
    // срабатывала уже ПОСЛЕ base64-строки и двух двоичных буферов — то есть
    // после втрое большего файла в памяти. Ровно тот же дефект, что описан на
    // пять строк выше, только на ветке `declared === null`, а её комментарий
    // прямо признаёт: размер файловая система сообщает не всегда.
    // position и length действуют только вместе и только для base64.
    const b64 = declared === null
      ? await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
          position: 0,
          length: MAX_BLOB_BYTES + 1,
        })
      : await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    const plain = new Uint8Array(Buffer.from(b64, 'base64'));
    // Лишний байт и ловится здесь: прочитали больше предела — файл больше.
    if (plain.length === 0 || plain.length > MAX_BLOB_BYTES) {
      log.warn('blob_upload_bad_size', { bytes: plain.length });
      return null;
    }
    const key = randomBytes(32);
    const cipher = encryptSymmetric(key, plain); // nonce||ct
    const idHex = Buffer.from(randomBytes(16)).toString('hex');
    // Локальный кэш ciphertext'а: идемпотентный LAN-push + повторная отправка.
    const { lanBlobCacheWrite, lanBlobPush } = await import('../transport/lan/lanBlob');
    // Отправку это не срывает — ciphertext уже в памяти, — но без кэша не
    // будет ни идемпотентного LAN-push, ни повторной отправки.
    if (!(await lanBlobCacheWrite(idHex, cipher))) {
      log.warn('blob_cache_write_failed', { id: idHex.slice(0, 8) });
    }
    // Keep the existing relay/LAN behavior responsive. The VPS receives the
    // same ciphertext asynchronously and never sees the per-blob key.
    void uploadCloudMediaCopy(idHex, cipher, mime, generation);
    // LAN-доставка пиру (fire-and-forget): на одном WiFi байты доедут даже без
    // интернета/relay; на разных сетях canReach=false и push мгновенно скипается.
    if (targetDid) {
      void lanBlobPush(targetDid, idHex, cipher);
    }
    const body = Buffer.from(cipher).toString('base64');
    // Random hosting topic — nobody subscribes to it; it is pure blob storage.
    const topic = `airchat-blob-${Buffer.from(randomBytes(9)).toString('hex')}`;
    const url = `${relayBase()}/${topic}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', Filename: 'b', Cache: 'no' },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as { attachment?: { url?: unknown } };
        const attUrl = json?.attachment?.url;
        // Адрес приходит из ответа релея и уезжает собеседнику, который откроет
        // его у себя. Релей, отдавший чужой хост, — либо чужой, либо испорченный;
        // в обоих случаях рассылать такую ссылку нельзя.
        if (typeof attUrl === 'string' && isAllowedBlobUrl(attUrl, allowedRelayBases())) {
          log.info('blob_upload_ok', { bytes: plain.length, url: attUrl.slice(0, 40) });
          return { u: attUrl, k: Buffer.from(key).toString('base64'), m: mime, i: idHex };
        }
        log.warn('blob_upload_bad_attachment_url', { present: typeof attUrl === 'string' });
      } else {
        log.warn('blob_upload_http_err', { status: res.status });
      }
    } catch (e) {
      log.warn('blob_upload_relay_unreachable', { err: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timeout);
    }
    // Relay недоступен (оффлайн). Если есть LAN-путь к получателю — отдаём
    // ref без url: ciphertext уедет (или уже уехал) по LAN, ключ — в E2E-конверте.
    if (targetDid) {
      const { getLanTransportSingleton } = await import('../transport/lan/lanTransport');
      const lan = getLanTransportSingleton();
      if (lan.isActive() && lan.canReach(targetDid)) {
        log.info('blob_upload_lan_only', { id: idHex.slice(0, 8), bytes: plain.length });
        return { k: Buffer.from(key).toString('base64'), m: mime, i: idHex };
      }
    }
    return null;
  } catch (e) {
    log.warn('blob_upload_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Download + decrypt a blob to a cached local file and return its file:// URI.
 * Idempotent: the cache path is derived from the URL so repeat plays reuse the
 * already-decrypted file. Returns null on failure.
 */
const blobResolveFlights = new Map<string, Promise<string | null>>();

export function resolveBlobToLocalFile(ref: BlobRef, ext = 'bin'): Promise<string | null> {
  const cacheDir = FileSystem.cacheDirectory ?? '';
  const name = isBlobRef(ref) ? blobCacheName(ref, ext) : null;
  if (!cacheDir || !name) return Promise.resolve(null);
  const key = `${cacheDir}${name}`;
  const existing = blobResolveFlights.get(key);
  if (existing) return existing;
  const flight = resolveBlobToLocalFileOnce(ref, ext).finally(() => {
    if (blobResolveFlights.get(key) === flight) blobResolveFlights.delete(key);
  });
  blobResolveFlights.set(key, flight);
  return flight;
}

async function resolveBlobToLocalFileOnce(ref: BlobRef, ext = 'bin'): Promise<string | null> {
  try {
    if (!isBlobRef(ref)) return null;
    const cacheDir = FileSystem.cacheDirectory ?? '';
    if (!cacheDir) return null;
    // Stable filename: blob id when present, else derived from the URL, плюс
    // отпечаток ключа.
    // v4.32.272: правило вывода id переехало в blobRef — по нему же ищется
    // файл, который нужно стереть вместе с исчезнувшим сообщением.
    // v4.32.615: к имени добавлен отпечаток ключа. Попадание в кэш возвращает
    // файл ДО расшифровки, то есть AEAD в этой ветке не проверяется вовсе, а
    // `i` выбирает отправитель — без отпечатка знающий чужой `i` занимал это
    // имя своим содержимым, и вложение соседа рисовалось его картинкой
    // (см. blobRef.blobKeyFingerprint).
    const dest = `${cacheDir}${blobCacheName(ref, ext) ?? ''}`;
    if (dest === cacheDir) return null;
    const existing = await FileSystem.getInfoAsync(dest);
    if (existing.exists && (existing.size ?? 0) > 0) return dest;

    const key = new Uint8Array(Buffer.from(ref.k, 'base64'));
    if (key.length !== SYMMETRIC_KEY_BYTES) {
      log.warn('blob_download_bad_key');
      return null;
    }

    const blobId = ref.i;
    const relayUrl = ref.u;

    // 1) LAN-доставленный (или свой отправленный) ciphertext в локальном кэше —
    //    работает полностью оффлайн, без relay.
    const loadLanCache = async (): Promise<Uint8Array | null> => {
      if (!blobId) return null;
      const { lanBlobCachedPath } = await import('../transport/lan/lanBlob');
      const cached = await lanBlobCachedPath(blobId);
      if (!cached) return null;
      const cb64 = await FileSystem.readAsStringAsync(cached, { encoding: FileSystem.EncodingType.Base64 });
      // v4.32.354: потолок стоял только на HTTP-ветке, хотя ciphertext в
      // локальном кэше кладёт туда пир по LAN — то есть ровно тот же чужой
      // ввод, и ограничен он был только свободным местом на диске.
      if (cb64.length === 0 || cb64.length > MAX_DOWNLOAD_B64_CHARS) {
        log.warn('blob_lan_cache_bad_size', { chars: cb64.length });
        return null;
      }
      const bytes = new Uint8Array(Buffer.from(cb64, 'base64'));
      log.info('blob_resolve_lan_cache', { id: blobId.slice(0, 8), bytes: bytes.length });
      return bytes;
    };

    // 2) HTTP с relay (если url есть).
    const loadRelay = async (): Promise<Uint8Array | null> => {
      if (!relayUrl) return null;
      // v4.32.354: адрес выбирает отправитель, а открывает его наше устройство
      // само, при отрисовке чата. Без ограничения по хосту это маячок:
      // отправитель узнаёт IP получателя и минуту открытия переписки.
      if (!isAllowedBlobUrl(relayUrl, allowedRelayBases())) {
        log.warn('blob_download_foreign_host', { url: relayUrl.slice(0, 64) });
        return null;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(relayUrl, { signal: controller.signal });
        if (!res.ok) {
          log.warn('blob_download_http_err', { status: res.status });
          return null;
        }
        // v4.32.354: потолок стоял только после чтения тела. Проверяем
        // content-length до res.text(), затем оставляем проверку строки.
        const declared = parseInt(res.headers?.get?.('content-length') ?? '', 10);
        if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_B64_CHARS) {
          log.warn('blob_download_too_large', { declared });
          return null;
        }
        const b64 = await res.text();
        if (b64.length === 0 || b64.length > MAX_DOWNLOAD_B64_CHARS) {
          log.warn('blob_download_bad_size', { chars: b64.length });
          return null;
        }
        return new Uint8Array(Buffer.from(b64, 'base64'));
      } catch (e) {
        log.warn('blob_download_relay_unreachable', { err: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        clearTimeout(timeout);
      }
    };

    // 3) Постоянная копия на сервере: тот же непрозрачный шифротекст, что и на
    // релее, — ключ по-прежнему живёт только внутри E2E-конверта сообщения.
    //
    // Она идёт последней, и это важно в обе стороны. Релей отвечает быстрее, и
    // медленный сервер не должен заставлять ждать там, где вложение доступно
    // сразу. Но и без релея копия обязана быть спрошена: вложение на ntfy живёт
    // часы, а сообщение — месяц, так что «зашёл через неделю» — это обычный
    // случай, а не край.
    //
    // v4.32.614: раньше тот же вызов стоял ещё и ВЫШЕ, под условием `!ref.u`, —
    // ровно то же самое, что делает эта ветка, потому что при отсутствии адреса
    // ветка релея не выполняется вовсе. Разницы в поведении не было ни одной,
    // кроме той, что при промахе запрос к серверу уходил дважды подряд.
    const loadCloud = async (): Promise<Uint8Array | null> => {
      if (!blobId) return null;
      const bytes = await downloadCloudMediaCopy(blobId);
      if (bytes) log.info('blob_resolve_cloud', { id: blobId.slice(0, 8), bytes: bytes.length });
      return bytes;
    };

    /**
     * Каждый источник расшифровывается отдельно (v4.32.615).
     *
     * Раньше первый отдавший байты источник становился единственным: если
     * расшифровка их не принимала, ответом было `null`, и до релея с сервером
     * очередь уже не доходила. А первым стоит кэш LAN, куда кадр кладёт пир —
     * без подписи, под именем из `idHex`, который виден в самом конверте.
     * Подложив туда произвольные байты под чужим `i`, сосед по сети закрывал
     * вложение навсегда: файл на диске оставался, и каждая следующая попытка
     * его открыть спотыкалась о него же.
     *
     * Теперь непринятый источник только записывается в лог, а подложенный файл
     * LAN-кэша стирается — место занимал он, и держать его незачем.
     */
    const sources: ReadonlyArray<{ name: 'lan' | 'relay' | 'cloud'; load: () => Promise<Uint8Array | null> }> = [
      { name: 'lan', load: loadLanCache },
      { name: 'relay', load: loadRelay },
      { name: 'cloud', load: loadCloud },
    ];

    let plain: Uint8Array | null = null;
    for (const source of sources) {
      let cipher: Uint8Array | null = null;
      try {
        cipher = await source.load();
      } catch (e) {
        log.warn('blob_source_failed', { src: source.name, err: e instanceof Error ? e.message : String(e) });
      }
      if (!cipher) continue;
      const attempt = decryptSymmetric(key, cipher);
      if (attempt) {
        plain = attempt;
        break;
      }
      log.warn('blob_source_decrypt_failed', { src: source.name, bytes: cipher.length });
      if (source.name === 'lan' && blobId) {
        const { lanBlobCacheDelete } = await import('../transport/lan/lanBlob');
        await lanBlobCacheDelete(blobId);
      }
    }
    if (!plain) {
      log.warn('blob_download_decrypt_failed');
      return null;
    }
    const temporary = `${dest}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await FileSystem.writeAsStringAsync(temporary, Buffer.from(plain).toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
    try {
      await FileSystem.moveAsync({ from: temporary, to: dest });
    } finally {
      // A failed move must not leave decrypted plaintext in the cache.
      await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => {});
    }
    log.info('blob_download_ok', { bytes: plain.length });
    return dest;
  } catch (e) {
    log.warn('blob_download_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
