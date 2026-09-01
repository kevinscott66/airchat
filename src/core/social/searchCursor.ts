/**
 * Курсор поиска по переписке — v4.32.506.
 *
 * Дефект, ради которого модуль появился: счётчик «3/12» и прыжок к
 * совпадению были привязаны к НОМЕРУ строки в списке. Список же меняется
 * сам по себе — пришло новое сообщение, отредактировали старое, доехала
 * отметка о прочтении, — и массив совпадений пересобирается. Экран считал
 * это новым поиском: сбрасывал счётчик на «1/12» и утаскивал прокрутку к
 * самому свежему совпадению. Человек, дошедший до седьмого вхождения,
 * терял место при каждом входящем сообщении.
 *
 * Правило здесь одно: место в поиске держится за ИДЕНТИФИКАТОРОМ
 * сообщения, а не за его номером. Пока найденное сообщение остаётся среди
 * совпадений, курсор стоит на нём, каким бы по счёту оно ни стало. Исчезло
 * (удалили, перестало подходить под запрос) — курсор идёт в начало, и это
 * единственный случай сброса.
 *
 * Модуль без импортов: номера, идентификаторы и подпись счётчика — чистые
 * данные, их можно проверить без списка, прокрутки и базы.
 */

/** Номер, приведённый к границам списка. Пустой список — всегда 0. */
export function clampHitIndex(index: number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  const whole = Math.trunc(index);
  return ((whole % length) + length) % length;
}

/** Шаг по кольцу совпадений: +1 — вперёд, -1 — назад. */
export function stepHitIndex(index: number, length: number, delta: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(delta)) return clampHitIndex(index, length);
  return clampHitIndex(clampHitIndex(index, length) + Math.trunc(delta), length);
}

/**
 * Куда встать после пересборки списка совпадений.
 *
 * `anchorId` — сообщение, на котором человек стоял. Есть среди новых
 * совпадений — встаём на него; нет (или его не было вовсе) — в начало.
 */
export function hitIndexForAnchor(hitIds: readonly string[], anchorId: string | null): number {
  if (hitIds.length === 0) return 0;
  if (!anchorId) return 0;
  const at = hitIds.indexOf(anchorId);
  return at >= 0 ? at : 0;
}

/**
 * Сохранился ли якорь среди совпадений. Экран прокручивает список только
 * когда НЕ сохранился: иначе каждое входящее сообщение дёргало бы прокрутку
 * туда, где человек и так стоит.
 */
export function anchorStillPresent(hitIds: readonly string[], anchorId: string | null): boolean {
  if (!anchorId) return false;
  return hitIds.indexOf(anchorId) >= 0;
}

/** Ключ набора совпадений: меняется от состава, а не от пересоздания массива. */
export function hitSetKey(hitIds: readonly string[]): string {
  return hitIds.join(',');
}

/** Подпись счётчика. Пустой набор подписи не имеет. */
export function hitLabel(index: number, length: number): string {
  if (!Number.isFinite(length) || length <= 0) return '';
  return `${clampHitIndex(index, length) + 1}/${length}`;
}
