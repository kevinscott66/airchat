/**
 * Что остаётся в списке чатов после того, как сами сообщения удалены.
 *
 * v4.32.238 закрыл это для автоудаления: стереть сообщения и оставить
 * last_message_preview — значит показывать текст удалённого сообщения на
 * экране, который открывают чаще всех остальных. Ручные «очистить историю»
 * тогда не тронули, и правило у трёх путей разъехалось:
 *
 * - «Очистить историю» в группе не трогала строку groups ВООБЩЕ. После неё в
 *   списке оставались и превью последнего сообщения, и имя того, кто его
 *   написал, и счётчик непрочитанных, а в шапке — баннер с закреплённым
 *   сообщением целиком: `pinned_message_text` хранит копию текста, и удаление
 *   group_messages её не касается.
 * - «Очистить историю» в личной переписке снимала превью и черновик, но
 *   оставляла `pinned_message_id` — указатель на сообщение, которого больше нет.
 * - «Очистить всю историю сообщений» — действие сильнее обоих — очищала
 *   МЕНЬШЕ: только превью, время и счётчики. Направление последнего сообщения,
 *   черновик, закрепления и имя отправителя в группах переживали её все.
 *
 * Поэтому перечень «где остаётся след» лежит здесь, отдельным модулем без
 * зависимостей: SQLite-код в тестах не поднять, а именно этот список и
 * разъезжается. Значение рядом с колонкой — то, чем её возвращают в состояние
 * «сообщений не было».
 */

/** Личная переписка. */
export const CONVERSATION_TRACE_COLUMNS: Readonly<Record<string, string>> = {
  last_message_preview: 'NULL',
  last_message_at: '0',
  last_message_direction: 'NULL',
  unread_count: '0',
  // Черновик — не история, но «очистить историю» его снимала с самого начала,
  // и это правильно: ненаписанное письмо тому же человеку остаётся текстом,
  // который человек хотел убрать вместе с перепиской.
  draft_text: 'NULL',
  pinned_message_id: 'NULL',
};

/** Группа или канал. */
export const GROUP_TRACE_COLUMNS: Readonly<Record<string, string>> = {
  last_message_preview: 'NULL',
  last_message_at: '0',
  last_message_sender_name: 'NULL',
  last_message_sender_pub: 'NULL',
  unread_count: '0',
  mention_count: '0',
  pinned_message_id: 'NULL',
  // Копия текста, а не ссылка: без неё баннер показывал бы закреплённое
  // сообщение и после очистки.
  pinned_message_text: 'NULL',
};

export type TraceTable = 'conversations' | 'groups';

/** Колонка, по которой адресуется одна переписка (второй параметр запроса). */
const ROW_KEY: Record<TraceTable, string> = {
  conversations: 'contact_pub_b64',
  groups: 'id',
};

/**
 * Запрос «сообщений не было». Параметры: `owner_profile_id`, а для scope
 * `'row'` — ещё и ключ строки (`contact_pub_b64` либо `id` группы).
 *
 * Пересчитывать нечего: все три пути вызывают его после того, как сообщения
 * уже удалены. Там, где часть сообщений остаётся (автоудаление), работают
 * refreshConversationAfterPurge / refreshGroupAfterPurge — они считают превью
 * по дожившим строкам.
 */
export function clearTracesSql(table: TraceTable, scope: 'profile' | 'row'): string {
  const columns = table === 'conversations' ? CONVERSATION_TRACE_COLUMNS : GROUP_TRACE_COLUMNS;
  const sets = Object.entries(columns)
    .map(([column, value]) => `${column} = ${value}`)
    .join(', ');
  const where =
    scope === 'row' ? `owner_profile_id = ? AND ${ROW_KEY[table]} = ?` : 'owner_profile_id = ?';
  return `UPDATE ${table} SET ${sets} WHERE ${where}`;
}
