/**
 * lanBlob — доставка зашифрованных media-blob'ов напрямую по LAN (тот же
 * ciphertext, что уходит на ntfy attachment store), чтобы фото/голосовые/файлы
 * работали на одном WiFi БЕЗ интернета и relay.
 *
 * Протокол: payload LAN-кадра (внутри ACPT-framing) с magic-байтом 0xB1:
 *   [0]    0xB1 (BLOB_CHUNK — не пересекается с 0xF0/0xF1 ленты и '{' JSON)
 *   [1]    version = 1
 *   [2-17] blobId (16 raw bytes; в BlobRef.i — 32 hex chars)
 *   [18-19] chunkIndex  (u16 BE)
 *   [20-21] chunkCount  (u16 BE)
 *   [22-25] totalBytes  (u32 BE, размер всего ciphertext)
 *   [26..]  chunk bytes
 *
 * Чанк ≤ 512 KB — заведомо под receiver-guard LAN-кадра в 1 MB.
 * Получатель собирает чанки в памяти (с жёсткими капами) и пишет готовый
 * ciphertext в кэш-файл; mediaBlob.resolveBlobToLocalFile проверяет этот кэш
 * ДО похода в сеть.
 *
 * v4.32.337: разбор заголовка и накопитель чанков вынесены в чистый модуль
 * lanBlobAssembly — кадр приходит от любого устройства в сети, и проверки
 * недоверенного ввода должны быть покрыты тестами.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { log } from '../../logger';
import {
  LAN_BLOB_CHUNK_BYTES,
  LAN_BLOB_HEADER_LEN,
  LAN_BLOB_MAGIC,
  LAN_BLOB_MAX_TOTAL_BYTES,
  LanBlobAssembler,
  encodeLanBlobChunk,
  isLanBlobFrame,
  parseLanBlobHeader,
} from './lanBlobAssembly';

export { LAN_BLOB_MAGIC, isLanBlobFrame };

const ID_HEX_RE = /^[0-9a-f]{32}$/;

function blobCachePath(idHex: string): string | null {
  // Имя файла собирается из идентификатора: без проверки сюда однажды приедет
  // «../» из кадра, пришедшего по сети.
  if (!ID_HEX_RE.test(idHex)) return null;
  const dir = FileSystem.cacheDirectory ?? '';
  return dir ? `${dir}airchat_blobcache_${idHex}.bin` : null;
}

/** Путь к локально доставленному (LAN) или локально отправленному ciphertext. */
export async function lanBlobCachedPath(idHex: string): Promise<string | null> {
  const p = blobCachePath(idHex);
  if (!p) return null;
  try {
    const info = await FileSystem.getInfoAsync(p);
    return info.exists && (info.size ?? 0) > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Сохранить ciphertext в blob-кэш (sender: для последующего LAN-push и идемпотентности). */
export async function lanBlobCacheWrite(idHex: string, cipher: Uint8Array): Promise<void> {
  const p = blobCachePath(idHex);
  if (!p) {
    log.warn('lan_blob_cache_write_bad_id');
    return;
  }
  try {
    await FileSystem.writeAsStringAsync(p, Buffer.from(cipher).toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (e) {
    log.warn('lan_blob_cache_write_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Отправить ciphertext blob'а пиру по LAN (fire-and-forget, последовательные
 * чанки). Возвращает true, если ВСЕ чанки приняты TCP-транспортом.
 */
export async function lanBlobPush(targetDid: string, idHex: string, cipher: Uint8Array): Promise<boolean> {
  try {
    if (!ID_HEX_RE.test(idHex) || cipher.length === 0 || cipher.length > LAN_BLOB_MAX_TOTAL_BYTES) return false;
    const { getLanTransportSingleton } = await import('./lanTransport');
    const lan = getLanTransportSingleton();
    if (!lan.isActive() || !lan.canReach(targetDid)) return false;
    const idBytes = new Uint8Array(Buffer.from(idHex, 'hex'));
    const count = Math.ceil(cipher.length / LAN_BLOB_CHUNK_BYTES);
    for (let i = 0; i < count; i++) {
      const chunk = cipher.subarray(i * LAN_BLOB_CHUNK_BYTES, Math.min((i + 1) * LAN_BLOB_CHUNK_BYTES, cipher.length));
      const frame = encodeLanBlobChunk(idBytes, i, count, cipher.length, chunk);
      const ok = await lan.send(frame, targetDid);
      if (!ok) {
        log.warn('lan_blob_push_chunk_failed', { id: idHex.slice(0, 8), i, count });
        return false;
      }
    }
    log.info('lan_blob_push_ok', { id: idHex.slice(0, 8), bytes: cipher.length, chunks: count });
    return true;
  } catch (e) {
    log.warn('lan_blob_push_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

// ── Receiver-side accumulator ────────────────────────────────────────────────

const assembler = new LanBlobAssembler();

/**
 * Обработать входящий 0xB1-кадр. По завершении сборки пишет ciphertext в
 * blob-кэш — дальше его подхватит resolveBlobToLocalFile.
 */
export async function receiveLanBlobFrame(payload: Uint8Array): Promise<void> {
  try {
    const header = parseLanBlobHeader(payload);
    if (!header) return;

    // Уже доставлен (например, повторный push) — игнорируем.
    if (await lanBlobCachedPath(header.idHex)) return;

    const res = assembler.accept(header, payload.subarray(LAN_BLOB_HEADER_LEN), Date.now());
    if (res.kind === 'dropped') {
      // Дубль чанка — обычное дело при повторном push'е, шуметь не о чем.
      if (res.reason !== 'duplicate') {
        log.warn('lan_blob_recv_dropped', { id: header.idHex.slice(0, 8), reason: res.reason });
      }
      return;
    }
    if (res.kind !== 'complete') return;

    await lanBlobCacheWrite(header.idHex, res.bytes);
    log.info('lan_blob_recv_ok', { id: header.idHex.slice(0, 8), bytes: res.bytes.length });
  } catch (e) {
    log.warn('lan_blob_recv_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}
