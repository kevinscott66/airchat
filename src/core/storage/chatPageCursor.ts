/**
 * Страница старых сообщений отсчитывается от строки, а не от числа (v4.32.539).
 *
 * Дефект. «Показать ещё» в переписке просило у базы `OFFSET = lines.length` —
 * столько сообщений уже на экране. База же считает строки ДО отбрасывания
 * служебных: строка-заглушка (текст из одного невидимого символа)
 * в базе есть, а на экране её нет.
 * Каждая такая строка внутри уже прочитанного отрезка сдвигала окно назад, и
 * следующая страница начиналась с сообщений, которые уже показаны — они
 * приходили вторым экземпляром, с тем же id, в список без сверки по id.
 *
 * Хуже другое: между двумя страницами приходят новые сообщения. Каждое из них
 * сдвигает всё окно вперёд на строку, и ровно столько самых старых сообщений
 * следующей страницы не показывается НИКОГДА — до полной перезагрузки
 * переписки человек их не увидит, и ничто на экране об этом не скажет.
 *
 * Лечение — не считать, а помнить, где остановились: пара «время создания и
 * id» самой старой показанной строки. Следующая страница берётся строго
 * старше этой пары. Новые сообщения приходят новее курсора и на него не
 * влияют, а служебные строки двигают его наравне с прочими — иначе страница
 * из одних заглушек не сдвинула бы отсчёт вовсе.
 *
 * Сравнение id — обычное `<`, как в SQLite с `BINARY`-сопоставлением (а не
 * `localeCompare`): курсор должен резать выборку ровно там же, где `ORDER BY`.
 *
 * Без зависимостей.
 */

export interface ChatPageCursor {
  createdAt: number;
  id: string;
}

/** Годен ли курсор для запроса. */
export function isValidCursor(value: unknown): value is ChatPageCursor {
  if (!value || typeof value !== 'object') return false;
  const c = value as { createdAt?: unknown; id?: unknown };
  return (
    typeof c.createdAt === 'number'
    && Number.isFinite(c.createdAt)
    && typeof c.id === 'string'
    && c.id.length > 0
  );
}

/** Строка строго старше курсора — та, что попадёт в следующую страницу. */
export function isOlderThan(
  row: { createdAt: number; id: string },
  cursor: ChatPageCursor,
): boolean {
  if (row.createdAt !== cursor.createdAt) return row.createdAt < cursor.createdAt;
  return row.id < cursor.id;
}

/**
 * Курсор на самой старой строке страницы.
 *
 * Порядок входа не предполагается: минимум ищется явно. Строки без пригодных
 * полей пропускаются — курсор из них сделал бы выборку бессмысленной.
 * `null`, если брать нечего.
 */
export function oldestCursor(
  rows: readonly { createdAt: number; id: string }[],
): ChatPageCursor | null {
  let best: ChatPageCursor | null = null;
  for (const row of rows) {
    if (!isValidCursor(row)) continue;
    const candidate: ChatPageCursor = { createdAt: row.createdAt, id: row.id };
    if (best === null || isOlderThan(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * Дописать страницу старых строк к уже показанным.
 *
 * Сверка по id: страница может пересечься с показанным (повторный запрос,
 * два касания подряд), и второй экземпляр строки в списке — это дубликат в
 * ленте и повторяющийся ключ у списка. Возвращает `prev` ТЕМ ЖЕ объектом,
 * когда нового нет: пересозданный список теряет позицию прокрутки.
 */
export function mergeOlderPage<T extends { id: string }>(
  prev: readonly T[],
  batch: readonly T[],
): T[] {
  if (batch.length === 0) return prev as T[];
  const seen = new Set(prev.map((m) => m.id));
  const fresh: T[] = [];
  for (const row of batch) {
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) continue;
    seen.add(row.id);
    fresh.push(row);
  }
  if (fresh.length === 0) return prev as T[];
  return [...prev, ...fresh];
}
