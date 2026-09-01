/**
 * Обновление списка не должно стирать то, до чего человек долистал (v4.32.503,
 * обобщено в v4.32.533).
 *
 * Лента листается страницами: `loadMoreFeed` дописывает следующую страницу в
 * конец списка. А обновление — `loadFeed` — всегда читает ПЕРВУЮ страницу и
 * кладёт её на место всего списка. Звали его отовсюду: раз в минуту по
 * таймеру, после реакции, после закладки, после репоста, после «прочитано»,
 * после заглушения автора. То есть человек, долиставший до трёхсотого поста,
 * терял двести шестьдесят из них в произвольный момент — список схлопывался
 * под ним, и прокрутка уезжала к началу.
 *
 * Ровно та же форма — в переписке группы: `loadMessages` читает первую
 * страницу и зовётся на каждую запись в базе, то есть на каждое входящее
 * сообщение, реакцию, правку и отметку о прочтении. Долистанная на полгода
 * назад переписка схлопывалась до последних шестидесяти сообщений, стоило
 * кому-нибудь написать.
 *
 * Правильный ответ — не «читать всё, до чего долистали» (это сделало бы
 * обновление тем тяжелее, чем дольше человек читает), а склеить свежую
 * голову со старым хвостом. Свежая голова знает про новые строки и про
 * удалённые в её пределах; хвост — всё, что старше её последнего элемента, —
 * трогать незачем, он не мог измениться от появления строки наверху.
 *
 * Модуль живёт в `storage`, а не в `social`: правило про постраничное чтение,
 * а не про ленту. Значение, по которому список упорядочен, у каждого свои
 * (`timestamp` у постов, `createdAt` у сообщений), поэтому его достают
 * переданной функцией — иначе пришлось бы держать вторую копию правила.
 *
 * Без зависимостей: порядок описан здесь же и обязан совпадать с
 * `ORDER BY … DESC, id DESC` в соответствующей выборке — иначе граница между
 * головой и хвостом ляжет не там, и строка либо задвоится, либо исчезнет.
 */

/** Минимум, который нужен склейке от строки списка. */
export type ListRow = { readonly id: string };

/** Чем строка упорядочена: время создания в миллисекундах. */
export type OrderAt<T> = (row: T) => number;

/** Порядок ленты: `feedStorage.getFeed` читает `ORDER BY timestamp DESC, id DESC`. */
export const atTimestamp = (row: { readonly timestamp: number }): number => row.timestamp;

/** Порядок переписки: `listGroupMessages` читает `ORDER BY created_at DESC, id DESC`. */
export const atCreatedAt = (row: { readonly createdAt: number }): number => row.createdAt;

/**
 * Порядок списка: новее — раньше. При равном времени решает id, иначе выборка
 * с LIMIT/OFFSET не воспроизводима и страницы теряют или дублируют строки.
 */
export function compareListOrder<T extends ListRow>(a: T, b: T, at: OrderAt<T>): number {
  const ta = at(a);
  const tb = at(b);
  if (ta !== tb) return tb - ta;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Свежая первая страница + сохранённый хвост прежнего списка.
 *
 * @param prev     что показано сейчас;
 * @param head     свежая выборка `limit = pageSize, offset = 0`;
 * @param pageSize размер страницы, с которым читали голову;
 * @param at       чем строки упорядочены.
 *
 * Неполная голова означает, что весь список уместился в одну страницу, — тогда
 * хвоста не существует и держать его нельзя: там остались бы удалённые строки.
 */
export function mergeListHead<T extends ListRow>(
  prev: readonly T[],
  head: readonly T[],
  pageSize: number,
  at: OrderAt<T>
): T[] {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return [...head];
  if (head.length < pageSize) return [...head];
  const cutoff = head[head.length - 1];
  const headIds = new Set(head.map((p) => p.id));
  // Строка из прежнего списка, которая новее границы, но в свежей голове её
  // нет, — удалена или скрыта. Именно за этим голову и перечитывают.
  const tail = prev.filter((p) => !headIds.has(p.id) && compareListOrder(cutoff, p, at) < 0);
  return [...head, ...tail];
}

/**
 * Есть ли что подгружать после обновления.
 *
 * Хвост сохранён — про его конец свежая голова ничего не говорит, отвечает
 * прежнее знание. Хвоста нет — знает длина головы.
 */
export function hasMoreAfterRefresh(
  headLen: number,
  mergedLen: number,
  pageSize: number,
  prevHasMore: boolean
): boolean {
  if (mergedLen > headLen) return prevHasMore;
  return headLen >= pageSize;
}

/**
 * Сопутствующие карты (медиа, счётчики комментариев и просмотров) живут отдельно
 * от списка и раньше заменялись целиком картой для головы — то есть хвост
 * оставался без картинок и со сброшенными счётчиками. Свежее значение важнее
 * старого, а ключи строк, которых в списке больше нет, уходят: иначе карта
 * растёт до бесконечности за счёт удалённых.
 */
export function mergeByRowId<V>(
  prev: Readonly<Record<string, V>>,
  fresh: Readonly<Record<string, V>>,
  keepIds: readonly string[]
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const id of keepIds) {
    if (Object.prototype.hasOwnProperty.call(fresh, id)) out[id] = fresh[id];
    else if (Object.prototype.hasOwnProperty.call(prev, id)) out[id] = prev[id];
  }
  return out;
}
