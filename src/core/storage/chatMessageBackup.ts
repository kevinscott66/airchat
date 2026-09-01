/**
 * Сообщения переписки из файла резервной копии.
 *
 * v4.32.370. Проверка строк для chat_messages появилась раньше остальных
 * (v4.32.192) и осталась единственной, которая живёт внутри SQLite-кода —
 * настройки переписок (conversationMeta, v4.32.295) и группы (groupBackup,
 * v4.32.297) свои проверки уже вынесли отдельными модулями без зависимостей.
 * Разница не в опрятности: поднять local.ts в тесте нельзя, поэтому у самой
 * большой таблицы копии проверок границ не было вообще, а проверять надо
 * именно их — файл лежит в песочнице приложения, но подменить его через
 * adb/restore можно, и дальше значения идут прямо в SQL.
 *
 * Здесь же живёт и предел на число строк: у двух соседних таблиц он
 * экспортируется их модулем, а у этой был записан числом на месте вызова.
 */

import { isPubKeyB64, optionalText, requiredText } from './backupFields';

/** Строка копии — как в таблице chat_messages. `text` остаётся шифротекстом. */
export type RawChatMessageRow = {
  id: string;
  contact_pub_b64: string;
  cid: string | null;
  text: string;
  direction: string;
  status: string;
  media_cids: string | null;
  created_at: number;
  owner_profile_id: number;
  reply_to_id?: string | null;
  reply_to_preview?: string | null;
};

/**
 * Больше сообщений, чем бывает у человека, — признак подмены файла. Разбор
 * такого файла занял бы минуты SQL и мог не дожить до конца.
 */
export const RAW_CHAT_MESSAGE_MAX_ROWS = 200_000;

/** Текст едет шифротекстом, поэтому предел щедрый. */
const TEXT_MAX = 96_000;
const MEDIA_CIDS_MAX = 16_384;
const REPLY_PREVIEW_MAX = 1_024;
/** Метка времени из будущего дальше суток — переставленные часы либо подмена. */
const FUTURE_SKEW_MS = 86_400_000;

/**
 * Отобрать из файла то, что можно положить в БД. Строка либо проходит целиком,
 * либо отбрасывается: сообщение с половиной полей — это пузырь, на котором
 * падает экран переписки, а войти в неё, чтобы его удалить, уже нельзя.
 *
 * @param expectedPid профиль, в который идёт восстановление. Чужой номер в
 *   файле не переписывается на свой молча — такая строка отбрасывается.
 * @param now точка отсчёта для «не из будущего»; параметром, чтобы тест мог её
 *   задать.
 */
export function sanitizeRawChatMessageRows(
  input: unknown,
  expectedPid: number,
  now: number
): { rows: RawChatMessageRow[]; dropped: number } {
  if (!Array.isArray(input)) return { rows: [], dropped: 0 };
  const rows: RawChatMessageRow[] = [];
  let dropped = 0;
  for (const raw of input.slice(0, RAW_CHAT_MESSAGE_MAX_ROWS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { dropped++; continue; }
    const r = raw as Record<string, unknown>;
    const id = requiredText(r.id, 128);
    if (id === undefined) { dropped++; continue; }
    if (!isPubKeyB64(r.contact_pub_b64)) { dropped++; continue; }
    // Пустой текст бывает у сообщения с одним вложением, поэтому не requiredText.
    if (typeof r.text !== 'string' || r.text.length > TEXT_MAX) { dropped++; continue; }
    const cid = optionalText(r.cid, 256);
    const mediaCids = optionalText(r.media_cids, MEDIA_CIDS_MAX);
    if (cid === undefined || mediaCids === undefined) { dropped++; continue; }
    const direction = r.direction;
    if (direction !== 'in' && direction !== 'out') { dropped++; continue; }
    // Пустой статус в таблице встречается, поэтому тоже не requiredText.
    if (typeof r.status !== 'string' || r.status.length > 32) { dropped++; continue; }
    if (
      typeof r.created_at !== 'number' ||
      !isFinite(r.created_at) ||
      r.created_at < 0 ||
      r.created_at > now + FUTURE_SKEW_MS
    ) { dropped++; continue; }
    if (r.owner_profile_id != null && r.owner_profile_id !== expectedPid) { dropped++; continue; }
    const replyToId = optionalText(r.reply_to_id, 128);
    const replyToPreview = optionalText(r.reply_to_preview, REPLY_PREVIEW_MAX);
    if (replyToId === undefined || replyToPreview === undefined) { dropped++; continue; }
    rows.push({
      id,
      contact_pub_b64: r.contact_pub_b64 as string,
      cid,
      text: r.text,
      direction,
      status: r.status,
      media_cids: mediaCids,
      created_at: r.created_at,
      owner_profile_id: expectedPid,
      reply_to_id: replyToId,
      reply_to_preview: replyToPreview,
    });
  }
  if (input.length > RAW_CHAT_MESSAGE_MAX_ROWS) {
    dropped += input.length - RAW_CHAT_MESSAGE_MAX_ROWS;
  }
  return { rows, dropped };
}
