/**
 * Кадр моста: что уезжает на ретранслятор и что из этого доверяется (v4.32.723).
 *
 * Номер команды и время стоят СНАРУЖИ шифротекста, а не внутри, и связаны с
 * ним через AAD — тот же приём, что в `sync/liveAccountSync`, и по той же
 * причине. Снаружи они нужны затем, что проверка на повтор должна решать
 * судьбу кадра ДО расшифровки: подписка идёт с `?since=`, и при каждом
 * переподключении ретранслятор переигрывает всё, что у него накопилось.
 * Расшифровывать эту гору, чтобы потом выбросить, — значит отдать чужой
 * стороне право занять процессор на столько, на сколько она захочет.
 *
 * Но «снаружи» без AAD означало бы «правится кем угодно по дороге»: взять
 * вчерашнюю команду «включи туннель», переписать ей номер и время на свежие и
 * отправить заново. Шифротекст при этом не меняется и расшифровывается как
 * родной. AAD связывает заголовок с шифротекстом: переписанный номер или
 * время ломают разбор целиком, и кадр отбрасывается.
 *
 * Направление (`cmd`/`res`) тоже входит в AAD. Темы у команд и ответов разные,
 * и перепутать их сейчас нельзя, но ключ AEAD у них один — а один ключ на два
 * потока без разделения направлений это та самая ошибка, которая всплывает
 * через две версии, когда темы почему-то станут одной.
 */
import { encryptSymmetric, decryptSymmetric } from '../crypto/encrypt';
import { bytesToBase64Url, base64UrlToBytes } from '../utils/base64url';

export type FrameDirection = 'cmd' | 'res';

/** Заголовок кадра: едет открыто, но связан с шифротекстом через AAD. */
export type BridgeFrameHead = {
  v: 1;
  dir: FrameDirection;
  /** Номер команды, растущий. Ответ повторяет номер своей команды. */
  seq: number;
  /** Время по часам отправителя, мс. */
  at: number;
  /** Шифротекст полезной части, base64url. */
  ct: string;
};

/**
 * Потолок на длину кадра в символах.
 *
 * Считается ДО раскодирования по той же причине, что в liveAccountSync: длина
 * строки известна сразу, а сколько памяти поднять под base64 — решала бы
 * чужая сторона. Команды моста — это десятки байт, килобайта хватает с
 * запасом на любой список настроек в ответе.
 */
export const MAX_FRAME_CHARS = 8 * 1024;

function aadFor(dir: FrameDirection, seq: number, at: number): Uint8Array {
  return new TextEncoder().encode(`airchat-bridge-v1:${dir}:${seq}:${at}`);
}

/** Запечатать полезную часть в кадр. `payload` — уже готовый объект. */
export function sealFrame(
  aeadKey: Uint8Array,
  dir: FrameDirection,
  seq: number,
  at: number,
  payload: unknown,
): string {
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const ct = encryptSymmetric(aeadKey, plain, aadFor(dir, seq, at));
  const head: BridgeFrameHead = { v: 1, dir, seq, at, ct: bytesToBase64Url(ct) };
  return JSON.stringify(head);
}

/** Разобранный заголовок — без расшифровки. */
export function parseFrameHead(raw: string): BridgeFrameHead | null {
  if (!raw || raw.length > MAX_FRAME_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const h = parsed as Partial<BridgeFrameHead>;
  if (h.v !== 1) return null;
  if (h.dir !== 'cmd' && h.dir !== 'res') return null;
  if (typeof h.seq !== 'number' || !Number.isSafeInteger(h.seq) || h.seq < 1) return null;
  if (typeof h.at !== 'number' || !Number.isSafeInteger(h.at) || h.at <= 0) return null;
  if (typeof h.ct !== 'string' || !h.ct) return null;
  return { v: 1, dir: h.dir, seq: h.seq, at: h.at, ct: h.ct };
}

/**
 * Расшифровать уже разобранный заголовок.
 *
 * `null` здесь значит ровно одно: кадр не наш. Чужой ключ, переписанный
 * заголовок, испорченная строка — снаружи это неразличимо и различать не
 * надо. Причину узнаёт только тот, у кого есть ключ, а у того, кто прислал
 * негодный кадр, её и не должно быть.
 */
export function openFrame(aeadKey: Uint8Array, head: BridgeFrameHead): unknown | null {
  let blob: Uint8Array;
  try {
    blob = base64UrlToBytes(head.ct);
  } catch {
    return null;
  }
  const plain = decryptSymmetric(aeadKey, blob, aadFor(head.dir, head.seq, head.at));
  if (!plain) return null;
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}
