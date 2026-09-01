/**
 * Комментарии на экране принадлежат одному посту (v4.32.504).
 *
 * Открытие треда — асинхронное чтение из базы, и пока оно идёт, человек уже
 * может закрыть тред и открыть другой пост: строки в ленте плотные, промах
 * пальцем стоит одного касания. Ответ первого чтения приходил позже и ложился
 * в состояние без вопросов — под постом B показывались комментарии поста A.
 * Тем же путём шли ответ на реакцию к комментарию (он возвращает весь тред) и
 * свежеотправленный комментарий: его дописывали в конец списка независимо от
 * того, чей тред сейчас открыт.
 *
 * Подписка на топик поста от этого защищена с v4.32.115 — сравнением с ref'ом
 * открытого поста. Здесь то же правило, но записанное один раз и проверяемое:
 * у экрана несколько мест, где асинхронный ответ пишет в список, и
 * договариваться в каждом заново — ровно тот способ, которым разъезжаются
 * копии одного правила.
 *
 * Без зависимостей.
 */

export type CommentRowKey = {
  id: string;
  postId: string;
  text?: string;
  /** emoji → список did'ов. */
  reactions?: Record<string, string[]> | null;
};

/**
 * Список из асинхронного чтения — принять или оставить прежний.
 *
 * @param openPostId пост, чей тред открыт прямо сейчас (null — тред закрыт);
 * @param forPostId  пост, для которого читали;
 * @param incoming   что пришло;
 * @param prev       что показано сейчас.
 *
 * Возвращает `prev` тем же объектом, если ответ опоздал. Чужие строки внутри
 * ответа отбрасываются: список подписан одним постом, и строка из другого
 * треда в нём — уже ошибка.
 */
export function acceptCommentList<T extends CommentRowKey>(
  openPostId: string | null,
  forPostId: string,
  incoming: readonly T[],
  prev: T[]
): T[] {
  if (!openPostId || openPostId !== forPostId) return prev;
  return incoming.filter((c) => c.postId === forPostId);
}

/**
 * Свой только что отправленный комментарий.
 *
 * Дубль возможен штатно: отправка будит перезагрузку треда, и та успевает
 * положить строку в список раньше — поэтому сверяем id, а не длину.
 */
export function appendOwnComment<T extends CommentRowKey>(
  openPostId: string | null,
  row: T,
  prev: T[]
): T[] {
  if (!openPostId || openPostId !== row.postId) return prev;
  if (prev.some((c) => c.id === row.id)) return prev;
  return [...prev, row];
}

function reactionSignature(reactions: Record<string, string[]> | null | undefined): string {
  if (!reactions) return '';
  return Object.keys(reactions)
    .sort()
    .map((emoji) => `${emoji}=${[...(reactions[emoji] ?? [])].sort().join('|')}`)
    .join(';');
}

/**
 * Совпадают ли списки настолько, что перерисовывать нечего.
 *
 * Нужно затем, что перезагрузка треда идёт по общему тику ленты — раз в
 * минуту и на каждое входящее событие, — а пересозданный массив теряет
 * позицию прокрутки в открытом треде.
 *
 * Прежняя проверка на экране сравнивала длину и id последней строки. Этого
 * мало в обе стороны: удаление одного комментария и приход другого дают ту же
 * длину и тот же хвост — список не обновлялся; а чужая реакция на комментарий
 * не меняет ни того, ни другого — счётчик под сердечком стоял на месте, пока
 * тред не закроют. Сверяем id по порядку, текст и состав реакций: тред
 * короткий, а сохранённая прокрутка того стоит.
 */
export function commentListUnchanged<T extends CommentRowKey>(
  prev: readonly T[],
  next: readonly T[]
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a.id !== b.id || a.text !== b.text) return false;
    if (reactionSignature(a.reactions) !== reactionSignature(b.reactions)) return false;
  }
  return true;
}

/** Пришло ли в тред что-то новое — повод прокрутить к концу. */
export function commentListGrew<T extends CommentRowKey>(
  prev: readonly T[],
  next: readonly T[]
): boolean {
  return next.length > prev.length;
}
