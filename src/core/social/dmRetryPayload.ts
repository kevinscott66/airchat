/**
 * dmRetryPayload — то, что кладётся в очередь неотправленного и достаётся
 * оттуда при повторной попытке.
 *
 * v4.32.357. Раньше эти две стороны не были связаны ничем: отправитель собирал
 * объект литералом в messaging.ts, а получатель разбирал его россыпью проверок
 * в storage/sync.ts. Ответ на сообщение это и потерял — в очередь клался текст
 * с вложениями, но без ссылки на цитируемое, и после доставки из очереди ответ
 * приходил обычным сообщением, а в своей же переписке терял привязку. Пока
 * определение одно на обе стороны, такое расхождение видно на месте.
 *
 * Нагрузка приходит из своей же базы, но проверяется как чужая: строку в
 * outbox мог оставить предыдущий формат или испорченная миграция, а дальше она
 * уходит собеседнику.
 */

import { isPlainCid } from '../cid';
import { MAX_MESSAGE_TEXT } from './messageTextLimit';
import { truncateReplyPreview } from './messagePreview';

export type DmRetryPayload = {
  contactPubB64: string;
  text: string;
  mediaCids: string[];
  messageId: string;
  ts: number;
  previousMessageCid?: string;
  replyToId?: string;
  replyToPreview?: string;
};

/** Ed25519-ключ в base64 — 43 или 44 символа; допуск на пару лишних. */
const PUB_B64_MIN = 43;
const PUB_B64_MAX = 48;
/** Общий потолок текста сообщения — см. messageTextLimit. */
const TEXT_MAX = MAX_MESSAGE_TEXT;
const ID_MAX = 128;
const CID_MAX = 128;
/** В живом сообщении вложений единицы; остальное — попытка раздуть очередь. */
const MEDIA_MAX = 32;

function optString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * Разбор строки из очереди. `null` — строка непригодна, её нужно выбросить, а
 * не перекладывать в следующую попытку: испорченную нагрузку не спасёт ни одна
 * повторная отправка, а очередь она будет занимать до истечения срока.
 *
 * Обязательные поля обязательны; необязательные, если не годятся, просто
 * отпадают — сообщение уйдёт без цитаты, но уйдёт.
 */
export function parseDmRetryPayload(raw: string): DmRetryPayload | null {
  let p: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    p = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const contactPubB64 = p.contactPubB64;
  if (typeof contactPubB64 !== 'string' || contactPubB64.length < PUB_B64_MIN || contactPubB64.length > PUB_B64_MAX) {
    return null;
  }
  const text = p.text;
  if (typeof text !== 'string' || text.length > TEXT_MAX) return null;
  const messageId = p.messageId;
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > ID_MAX) return null;
  const ts = p.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;

  const mediaCids = Array.isArray(p.mediaCids)
    ? p.mediaCids.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= CID_MAX).slice(0, MEDIA_MAX)
    : [];

  const prev = p.previousMessageCid;
  // Всё, что не CID, в поле «предыдущее» смысла не имеет (см. core/cid).
  const previousMessageCid = isPlainCid(prev) ? prev : undefined;

  const replyToId = optString(p.replyToId, ID_MAX);
  // Цитата режется тем же правилом, что и при первой отправке: в очереди она
  // могла пролежать с прошлой версии, когда предела не было.
  const replyToPreview = replyToId ? (truncateReplyPreview(optString(p.replyToPreview, TEXT_MAX)) ?? undefined) : undefined;

  return { contactPubB64, text, mediaCids, messageId, ts, previousMessageCid, replyToId, replyToPreview };
}

/** Строка для очереди. Единственное место, где решается её состав. */
export function serializeDmRetryPayload(payload: DmRetryPayload): string {
  return JSON.stringify({
    contactPubB64: payload.contactPubB64,
    text: payload.text,
    mediaCids: payload.mediaCids,
    messageId: payload.messageId,
    ts: payload.ts,
    previousMessageCid: payload.previousMessageCid,
    replyToId: payload.replyToId,
    replyToPreview: payload.replyToPreview,
  });
}
