/**
 * Вложения публикации, которые не открылись (v4.32.852).
 *
 * `resolveFeedMediaUris` отдаёт по слоту на каждое вложение поста, и слот,
 * который не открылся, равен `null`. До этой версии такие слоты схлопывались
 * `filter`'ом ещё в ядре: пост с тремя снимками показывал два и подписывал их
 * «фото 2 из 2», а пост, у которого не открылся ни один, не попадал в карту
 * вовсе — и выглядел как публикация без снимков.
 *
 * Отличить «фотографий не было» от «фотографии не загрузились» было нечем:
 * ни на экране, ни на слух. Здесь считается ровно это отличие — счётом слотов,
 * без базы и без отрисовки.
 *
 * Чисел в подписях два, и оба названы: «2 из 3» человек сверит с тем, что он
 * сам выкладывал, а доля или одно число сверить не с чем.
 */

/** Слот вложения: готовая ссылка или `null` — не открылось. */
export type MediaSlot = string | null;

/** Ссылки, которые можно открыть просмотром. Порядок — как в публикации. */
export function openedSlots(slots: readonly MediaSlot[]): string[] {
  return slots.filter((u): u is string => typeof u === 'string' && u.length > 0);
}

/** Сколько вложений публикации не открылось. */
export function unopenedSlotCount(slots: readonly MediaSlot[]): number {
  let n = 0;
  for (const s of slots) if (!(typeof s === 'string' && s.length > 0)) n += 1;
  return n;
}

/**
 * Номер слота среди открытых — им просмотр листает снимки.
 *
 * Считается по порядку, а не поиском по ссылке: две одинаковые ссылки в одной
 * публикации (а это бывает — один и тот же снимок приложен дважды) вернули бы
 * из `indexOf` первый слот, и нажатие на второй снимок открывало бы первый.
 * -1 у неоткрывшегося слота: открывать нечего.
 */
export function openedIndexOf(slots: readonly MediaSlot[], idx: number): number {
  const at = slots[idx];
  if (!(typeof at === 'string' && at.length > 0)) return -1;
  let n = 0;
  for (let i = 0; i < idx; i += 1) {
    const s = slots[i];
    if (typeof s === 'string' && s.length > 0) n += 1;
  }
  return n;
}

/** Подпись под снимками публикации. null — жаловаться не на что. */
export function mediaSlotsNotice(slots: readonly MediaSlot[]): string | null {
  const missing = unopenedSlotCount(slots);
  if (missing <= 0) return null;
  return `Не загрузилось фотографий: ${missing} из ${slots.length}`;
}

/**
 * Подпись для незрячих на месте неоткрывшегося снимка.
 *
 * Слово «не загрузилась» согласовано с «фотографией» при любом числе, поэтому
 * окончания здесь не считаются: место в ряду названо парой чисел.
 */
export function unopenedSlotLabel(idx: number, total: number): string {
  return `Фотография ${idx + 1} из ${total} — не загрузилась`;
}
