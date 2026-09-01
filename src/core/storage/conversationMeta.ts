/**
 * Настройки переписки, которые не выводятся из её сообщений: метка папки,
 * закрепление, архив, беззвучный режим, черновик, закреплённое сообщение и —
 * главное — таймер самоуничтожения.
 *
 * v4.32.295. Резервная копия диалогов хранила только chat_messages, а строки
 * conversations после восстановления собирались заново по сообщениям
 * (rebuildConversationsFromMessages). Всё перечисленное при этом молча
 * обнулялось:
 *
 * - `disappear_after_ms` — «сообщения исчезают через час» превращалось в «не
 *   исчезают никогда». Человек продолжал писать в переписку, считая её
 *   самоуничтожающейся, а она уже сохраняла всё навсегда. Это не потеря
 *   удобства, это отменённое решение о безопасности, и отменённое беззвучно.
 * - архив возвращал спрятанные переписки в общий список — на экран, который
 *   показывают другим;
 * - беззвучный режим снимался, и чат, поставленный на тишину намеренно,
 *   начинал приходить уведомлениями;
 * - метки и вместе с ними папки (v4.32.294) исчезали.
 *
 * Разбор лежит отдельным модулем — без зависимостей, — потому что применяет
 * его SQLite-код, который в тестах не поднять, а проверять надо именно
 * границы: копия лежит в песочнице приложения, но подменить файл через
 * adb/restore можно, и тогда эти значения попадают прямо в БД.
 */
import { count, flag, isPubKeyB64, optionalText, optionalTime } from './backupFields';

/** Строка копии — как в таблице, `draft_text` остаётся enc2-шифротекстом. */
export type ConversationMetaRow = {
  contact_pub_b64: string;
  unread_count: number;
  draft_text: string | null;
  pinned: number;
  archived: number;
  muted: number;
  muted_until: number | null;
  pinned_message_id: string | null;
  disappear_after_ms: number | null;
  disappear_set_at: number | null;
  color_tag: string | null;
};

/**
 * Цветовая метка переписки. Тем же значением называются папки в списке чатов
 * (см. chatFolders), поэтому правило «что бывает меткой» здесь одно на всех:
 * на запись метки, на разбор названий папок и на импорт копии.
 */
// Намеренно не `value is string`: сужение по типу превращало бы «а если не
// метка» в never — а именно там и нужно записать в журнал, что пришло.
export function isColorTag(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value);
}

/** Больше переписок с настройками, чем бывает у человека, — признак подмены. */
export const CONVERSATION_META_MAX_ROWS = 20_000;
/** Черновик едет шифротекстом: тот же предел, что у text сообщений. */
const DRAFT_MAX = 96_000;
/** Дольше года «исчезающих сообщений» интерфейс не предлагает. */
const DISAPPEAR_MAX_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Отобрать из файла то, что можно положить в БД. Строка либо проходит целиком,
 * либо отбрасывается: чинить настройки безопасности «по частям» — значит
 * применить половину чужого решения.
 */
export function sanitizeConversationMetaRows(
  input: unknown
): { rows: ConversationMetaRow[]; dropped: number } {
  if (!Array.isArray(input)) return { rows: [], dropped: 0 };
  const rows: ConversationMetaRow[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const raw of input.slice(0, CONVERSATION_META_MAX_ROWS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { dropped++; continue; }
    const r = raw as Record<string, unknown>;
    const contact = r.contact_pub_b64;
    if (!isPubKeyB64(contact)) { dropped++; continue; }
    // Дубль перезаписал бы первую строку второй — а какая из них настоящая,
    // неизвестно. Оставляем первую.
    if (seen.has(contact)) { dropped++; continue; }
    const pinned = flag(r.pinned);
    const archived = flag(r.archived);
    const muted = flag(r.muted);
    if (pinned == null || archived == null || muted == null) { dropped++; continue; }
    const unread = count(r.unread_count);
    if (unread == null) { dropped++; continue; }
    const draft = optionalText(r.draft_text, DRAFT_MAX);
    const pinnedMessageId = optionalText(r.pinned_message_id, 128);
    if (draft === undefined || pinnedMessageId === undefined) { dropped++; continue; }
    const mutedUntil = optionalTime(r.muted_until);
    const disappearSetAt = optionalTime(r.disappear_set_at);
    if (mutedUntil === undefined || disappearSetAt === undefined) { dropped++; continue; }
    let disappear: number | null = null;
    if (r.disappear_after_ms != null) {
      const v = r.disappear_after_ms;
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > DISAPPEAR_MAX_MS) { dropped++; continue; }
      disappear = Math.floor(v);
    }
    if (r.color_tag != null && !isColorTag(r.color_tag)) { dropped++; continue; }
    seen.add(contact);
    rows.push({
      contact_pub_b64: contact,
      unread_count: unread,
      draft_text: draft,
      pinned,
      archived,
      muted,
      muted_until: mutedUntil,
      pinned_message_id: pinnedMessageId,
      disappear_after_ms: disappear,
      disappear_set_at: disappearSetAt,
      color_tag: r.color_tag == null ? null : (r.color_tag as string),
    });
  }
  if (Array.isArray(input) && input.length > CONVERSATION_META_MAX_ROWS) {
    dropped += input.length - CONVERSATION_META_MAX_ROWS;
  }
  return { rows, dropped };
}
