/**
 * mediaUpload — единственный путь «локальный файл → CID» для всех экранов.
 *
 * v4.32.358. Раньше каждый экран делал это сам, и делал одинаково плохо:
 *
 *   const b64 = await readAsStringAsync(uri, base64);   // весь файл в память
 *   const bytes = Buffer.from(b64, 'base64');           // ещё раз
 *   let cid = await addToIpfs(bytes);                   // на телефоне всегда null
 *   if (!cid) { ...uploadEncryptedBlob(uri) }           // читает тот же файл заново
 *
 * Отсюда две беды. Первая: чтение шло ДО проверки размера — а кое-где проверки
 * не было вовсе (фото в группу) или она смотрела на размер из галереи, который
 * система не обязана сообщать (видео в группу). Ролик на пару гигабайт
 * разворачивался в base64-строку и два двоичных буфера, ~3.4× от размера файла,
 * и приложение падало по нехватке памяти раньше, чем доходило до проверки.
 * Вторая: на телефоне IPFS выключен и addToIpfs возвращает null не читая
 * байтов — то есть первое чтение было целиком напрасным, а файл читался дважды.
 *
 * Теперь размер спрашивается у файловой системы, решение принимает
 * chooseUploadRoute, и байты читаются только тем путём, который их использует.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { addToIpfs } from '../transport/ipfs/node';
import { isIpfsEnabled } from '../transport/ipfs/heliaNode';
import { log } from '../logger';
import { MAX_BLOB_BYTES } from './blobRef';
import { fileSizeBytes } from './fileSize';
import { chooseUploadRoute } from './uploadRoute';

export { fileSizeBytes };

/**
 * Buffer.from(b64) — синхронная работа на JS-потоке: для файла больше ~500 КБ
 * это сотни миллисекунд заморозки. Перед ней уступаем цикл событий, чтобы
 * успели обработаться нажатия и анимация.
 */
const YIELD_THRESHOLD_B64_CHARS = 680_000;

export type MediaUploadResult =
  | { ok: true; cid: string; sizeBytes: number | null }
  | { ok: false; reason: 'oversize' | 'failed'; limitBytes: number };

export type MediaUploadOptions = {
  mime?: string;
  /** did получателя — включает доставку вложения по локальной сети. */
  targetDid?: string;
  /** Потолок IPFS-пути для этого вида вложения (видео/документ). */
  ipfsMaxBytes?: number;
  /** Размер, если он уже известен (из галереи или выбора файла). */
  sizeBytes?: number | null;
};

/**
 * Загрузить локальный файл и получить CID для сообщения.
 *
 * IPFS-путь отдаёт обычный CID, запасной — `nb:`-дескриптор зашифрованного
 * вложения. Дескриптор НЕСЁТ КЛЮЧ: он допустим только внутри уже зашифрованной
 * части сообщения, во внешнюю обёртку такие CID не попадают (их отсеивают
 * отправляющие функции).
 */
export async function uploadMediaToCid(
  uri: string,
  opts: MediaUploadOptions = {}
): Promise<MediaUploadResult> {
  try {
    const ipfsEnabled = isIpfsEnabled();
    const sizeBytes = opts.sizeBytes ?? (await fileSizeBytes(uri));
    const route = chooseUploadRoute({ sizeBytes, ipfsEnabled, ipfsMaxBytes: opts.ipfsMaxBytes });
    if (route.kind === 'reject') {
      log.info('media_upload_oversize', { bytes: sizeBytes, limit: route.limitBytes });
      return { ok: false, reason: 'oversize', limitBytes: route.limitBytes };
    }

    if (route.kind === 'ipfs') {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (b64.length > YIELD_THRESHOLD_B64_CHARS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const cid = await addToIpfs(new Uint8Array(Buffer.from(b64, 'base64')));
      if (cid) return { ok: true, cid, sizeBytes };
      // IPFS включён, но узел не отдал CID. Запасной путь есть, только он
      // строже по размеру — файл, разрешённый как «до 50 МБ в IPFS», во
      // вложение не влезет, и честнее сказать это, чем молча не отправить.
      if (sizeBytes !== null && sizeBytes > MAX_BLOB_BYTES) {
        return { ok: false, reason: 'oversize', limitBytes: MAX_BLOB_BYTES };
      }
    }

    const { uploadEncryptedBlob, makeNbCid } = await import('./mediaBlob');
    const ref = await uploadEncryptedBlob(uri, opts.mime, opts.targetDid);
    if (!ref) return { ok: false, reason: 'failed', limitBytes: route.limitBytes };
    return { ok: true, cid: makeNbCid(ref), sizeBytes };
  } catch (e) {
    log.warn('media_upload_failed', { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, reason: 'failed', limitBytes: MAX_BLOB_BYTES };
  }
}
