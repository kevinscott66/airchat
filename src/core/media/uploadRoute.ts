/**
 * uploadRoute — одно решение на все экраны отправки: каким путём уйдёт файл и
 * не велик ли он.
 *
 * v4.32.358. Правило «сколько можно» было расписано в семи местах — в личном
 * чате, в группе, в листе вложений, в выборе документа — тремя разными числами
 * и с разными формулировками. Расходились они молча: в группе видео без
 * заявленного размера проходило проверку, а фотография не проверялась вовсе.
 *
 * Здесь только арифметика: ни файлов, ни сети, ни IPFS. Читающая диск часть
 * живёт в mediaUpload.
 */

import { MAX_BLOB_BYTES } from './blobRef';
import { formatByteSize } from './byteSize';

/**
 * Потолки IPFS-пути. В десятичных мегабайтах — как MAX_BLOB_BYTES, иначе
 * подпись «25 МБ» под пределом 26 214 400 байт была бы неправдой.
 */
export const IPFS_VIDEO_MAX_BYTES = 25_000_000;
export const IPFS_DOC_MAX_BYTES = 50_000_000;

export type UploadRouteKind = 'ipfs' | 'blob' | 'reject';

export type UploadRoute = {
  kind: UploadRouteKind;
  /** Предел, по которому принято решение, — для текста ошибки. */
  limitBytes: number;
};

export type RouteInput = {
  /** Размер с диска или из галереи. null/undefined — размер неизвестен. */
  sizeBytes?: number | null;
  ipfsEnabled: boolean;
  /** Потолок IPFS-пути для этого вида вложения. По умолчанию — документный. */
  ipfsMaxBytes?: number;
};

/** Размер, которому можно верить: конечное неотрицательное число. */
export function knownSize(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Предел для текущего пути отправки. */
export function uploadLimitBytes(opts: RouteInput): number {
  if (!opts.ipfsEnabled) return MAX_BLOB_BYTES;
  return knownSize(opts.ipfsMaxBytes) ?? IPFS_DOC_MAX_BYTES;
}

/**
 * Куда отправлять и стоит ли вообще начинать.
 *
 * Без IPFS файл уезжает зашифрованным вложением, и предел один — MAX_BLOB_BYTES.
 * Неизвестный размер не считается разрешением: путь выбирается, но читающая
 * сторона проверит размер сама, до чтения байтов в память.
 */
export function chooseUploadRoute(opts: RouteInput): UploadRoute {
  const limitBytes = uploadLimitBytes(opts);
  const size = knownSize(opts.sizeBytes);
  if (size !== null && size > limitBytes) return { kind: 'reject', limitBytes };
  return { kind: opts.ipfsEnabled ? 'ipfs' : 'blob', limitBytes };
}

/**
 * Предел словами: «8 МБ».
 *
 * v4.32.422: та же подпись, что и у веса файла на экране, — иначе отказ
 * «предел 8 МБ» стоял рядом с файлом, подписанным «7.6 МБ». Округление вниз:
 * подпись предела не имеет права назвать больше, чем пропустит проверка.
 */
export function formatLimit(bytes: number): string {
  return formatByteSize(bytes, { roundDown: true });
}

/**
 * Отказ по размеру — одними словами на всех экранах (v4.32.841).
 *
 * До этой версии одно и то же «не влезло» было написано пятью способами, и два
 * из них называли машинерию: «Без IPFS-сервера видео передаётся вложением, а
 * его предел — 8 МБ» и «Файл слишком большой: без IPFS-сервера предел — 8 МБ».
 * IPFS на телефоне выключен наглухо с v4.32.19 (`isIpfsEnabled` возвращает
 * `false` и на Android, и на iOS, настройки для него нет) — то есть эту ветку
 * человек видит всегда, а вторую, «правильную», не увидит никогда.
 *
 * Цена. Названа причина, которой человек не понимает и изменить не может, и
 * сказано неправду: будто где-то есть сервер, после которого предел вырастет.
 * Про «обрежьте видео» — единственное, что тут вообще можно сделать, — в этой
 * ветке не говорилось: совет достался как раз недостижимой.
 *
 * Заголовок и тело лежат парами: у отказа во всплывающем сообщении заголовка
 * нет, и ему нужна та же мысль одной строкой.
 */
export const OVERSIZE_TITLE = {
  file: 'Файл слишком большой',
  video: 'Видео слишком большое',
  photo: 'Снимок слишком большой',
} as const;

export type OversizeKind = keyof typeof OVERSIZE_TITLE;

/**
 * Чем себе помочь. Пусто там, где помочь нечем: файл не «ужать качеством».
 *
 * v4.32.871: подсказка вышла наружу. Пачку роликов разбирает `batchSendReport`,
 * и до сих пор она называла один только предел: совет «обрежьте» доставался
 * лишь тому, кто отправлял ролик поодиночке.
 */
export const OVERSIZE_HINT: Record<OversizeKind, string> = {
  file: '',
  video: ' Обрежьте видео или уменьшите качество.',
  photo: '',
};

/** Тело окна под OVERSIZE_TITLE: сколько можно и что делать. */
export function oversizeAdvice(limitBytes: number, kind: OversizeKind = 'file'): string {
  return `Предел — ${formatLimit(limitBytes)}.${OVERSIZE_HINT[kind]}`;
}

/** То же одной строкой — для всплывающего сообщения, у которого заголовка нет. */
export function oversizeText(limitBytes: number, kind: OversizeKind = 'file'): string {
  return `${OVERSIZE_TITLE[kind]}: предел — ${formatLimit(limitBytes)}.${OVERSIZE_HINT[kind]}`;
}
