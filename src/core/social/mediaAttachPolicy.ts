/**
 * Сколько фотографий можно приложить к сообщению и что делать с тем, что
 * вернул picker (v4.32.322).
 *
 * Правило жило в экране переписки тремя разными числами `10` — в запросе к
 * picker'у, в обрезке ответа и в предпросмотре — и одно из них считалось с
 * ошибкой: `Math.max(1, 10 - выбрано)` при десяти уже выбранных разрешал
 * выбрать ещё одну. Одиннадцатую потом молча срезала обрезка ответа: человек
 * выбирал фотографию, она принималась, и её же в предпросмотре не было.
 *
 * Заодно здесь отсеиваются повторы. Picker возвращает то, что отметили, не
 * зная про уже выбранное: открыл «добавить ещё», отметил ту же фотографию — и
 * она уходила собеседнику дважды.
 */

/** Столько же, сколько в ленте (FEED_MAX_IMAGES) и сколько принято в мессенджерах. */
export const CHAT_MAX_IMAGES = 10;

export type MergedPick = {
  /** Итоговый список — уже с учётом предела. */
  next: string[];
  /** Сколько добавилось. */
  added: number;
  /** Не влезло в предел. */
  overLimit: number;
  /** Отброшено как уже выбранное. */
  duplicates: number;
};

/** Сколько ещё можно выбрать. Ноль — предел уже выбран. */
export function remainingImageSlots(attachedCount: number, max: number = CHAT_MAX_IMAGES): number {
  return Math.max(0, max - Math.max(0, attachedCount));
}

/**
 * Добавить выбранное к уже выбранному. `incoming` приходит из picker'а —
 * значения проверяются, а не принимаются на веру.
 */
export function mergePickedImages(
  attached: readonly string[],
  incoming: unknown,
  max: number = CHAT_MAX_IMAGES
): MergedPick {
  const next = [...attached];
  const seen = new Set(next);
  let added = 0;
  let overLimit = 0;
  let duplicates = 0;
  if (!Array.isArray(incoming)) return { next, added, overLimit, duplicates };
  for (const item of incoming) {
    if (typeof item !== 'string' || !item) continue;
    if (seen.has(item)) { duplicates += 1; continue; }
    if (next.length >= max) { overLimit += 1; continue; }
    seen.add(item);
    next.push(item);
    added += 1;
  }
  return { next, added, overLimit, duplicates };
}
