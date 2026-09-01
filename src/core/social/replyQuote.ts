/**
 * Что показать в цитате ответа и что унести в сеть (v4.32.598).
 *
 * Цитата собирается из двух источников. Первый — само сообщение, на которое
 * отвечают, если оно ещё в загруженном окне ленты: тогда цитата всегда свежая
 * и переживает правку оригинала. Второй — столбец `reply_to_preview`, слепок
 * на момент ответа: он и остаётся, когда оригинал уехал за край окна или его
 * удалили.
 *
 * Столбец лежит зашифрованным, и `decryptAtRestNullable` отдаёт на неудаче
 * пустую строку. Оба экрана рисовали блок цитаты по `replyToId && preview`, и
 * пустая строка через это условие не проходила: рамка не появлялась вовсе.
 * Ответ выглядел отдельной репликой — а разговор из ответов, потерявших свои
 * вопросы, читается наоборот: согласие принимают за возражение.
 *
 * Отсюда два разных правила, и они намеренно не совпадают (то же разделение,
 * что у имени в v4.32.589). Себе — сказать прямо: цитата есть, ключ её не
 * открывает. Наружу — не сказать ничего: пустая цитата у собеседника выглядит
 * как наша ошибка и вдобавок выдаёт состояние нашего ключа. У получателя есть
 * `replyToId`, по нему его же клиент найдёт оригинал сам.
 */

/** Что рисовать: текст цитаты либо признак того, что её не прочитать. */
export type QuoteView = { text: string | null; unreadable: boolean };

/**
 * Свежий текст оригинала важнее слепка, слепок важнее пометки.
 *
 * Пометка появляется только там, где показать нечего: оригинала в окне нет,
 * а слепок не открылся. Если оригинал под рукой — цитата обычная, состояние
 * ключа тут ни при чём.
 */
export function quoteView(
  originText: string | null | undefined,
  storedPreview: string | null | undefined,
  storedUnreadable?: boolean
): QuoteView {
  const origin = typeof originText === 'string' ? originText : '';
  if (origin.trim().length > 0) return { text: origin, unreadable: false };
  const stored = typeof storedPreview === 'string' ? storedPreview : '';
  if (stored.trim().length > 0) return { text: stored, unreadable: false };
  return { text: null, unreadable: storedUnreadable === true };
}

/**
 * Слепок цитаты для повторной отправки — или ничего.
 *
 * Пустую строку сюда пускать нельзя: у собеседника она станет пустой рамкой.
 * Отсутствие поля честнее — ответ останется ответом по `replyToId`.
 */
export function outwardQuote(
  storedPreview: string | null | undefined,
  storedUnreadable?: boolean
): string | undefined {
  if (storedUnreadable === true) return undefined;
  const stored = typeof storedPreview === 'string' ? storedPreview : '';
  return stored.trim().length > 0 ? stored : undefined;
}
