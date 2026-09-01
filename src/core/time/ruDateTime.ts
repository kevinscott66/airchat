/**
 * ruDateTime — дата и время по-русски, одинаково на любом телефоне.
 *
 * v4.32.426. Приложение говорит по-русски и только по-русски: i18n поднят с
 * `lng: 'ru'` и одним словарём, переключателя языка нет. А дату и время оно
 * рисовало ТРИДЦАТЬЮ ДВУМЯ способами, разбитыми на четыре несовместимых
 * семейства:
 *
 *   1. `toLocale*String(undefined, …)` — язык телефона, четырнадцать мест;
 *   2. `toLocaleString()` вообще без аргументов — язык И формат телефона,
 *      пять мест;
 *   3. `toLocale*String('ru-RU', …)` — по-русски, одиннадцать мест;
 *   4. собственные русские массивы месяцев — четыре места, три отдельные
 *      копии массива.
 *
 * Первые два семейства на телефоне с английской локалью (а это ровно та
 * аудитория, ради которой приложение вообще писалось) выдают английский
 * текст внутри русского интерфейса. На одном экране переписки это выглядело
 * так: разделитель дня — «12 авг», подпись под сообщением — «3:45 PM»,
 * а «сведения о сообщении» о том же самом сообщении — «Aug 12, 3:45:07 PM».
 * Список запланированных — «8/12/2026, 3:45:00 PM». Экспорт переписки в файл
 * — тоже язык телефона, то есть выгруженный файл у двух людей с одной и той
 * же перепиской получался на разных языках.
 *
 * Третье семейство по-русски, но зависит от наличия полного ICU: Hermes
 * собирается и без него, и тогда `'ru-RU'` молча откатывается на английский.
 * Проверить это тестом нельзя — jest считает по своему ICU, не по телефонному.
 *
 * Поэтому здесь нет Intl вовсе. Месяцы записаны словами, часы — двадцать
 * четыре, как принято там, где на этом языке говорят. Один и тот же момент
 * выглядит одинаково на любом устройстве, и то, что видит тест, — ровно то,
 * что увидит человек.
 */
import { isUsableTimestamp } from './calendarTime';

/** «12 авг» — короткий месяц, для списков и подписей. */
export const MONTH_SHORT_RU = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
] as const;

/** «12 августа» — родительный падеж: месяц здесь стоит при числе. */
export const MONTH_GENITIVE_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** «15:45». */
export function clockTime(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** «15:45:07» — там, где секунда несёт смысл: сведения о сообщении, экспорт. */
export function clockTimeSec(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  return `${clockTime(ts)}:${pad2(new Date(ts).getSeconds())}`;
}

/** «12 авг». */
export function dayMonthShort(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  const d = new Date(ts);
  return `${d.getDate()} ${MONTH_SHORT_RU[d.getMonth()]}`;
}

/** «12 авг 2026». */
export function dayMonthShortYear(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  return `${dayMonthShort(ts)} ${new Date(ts).getFullYear()}`;
}

/**
 * «12 авг» для этого года, «12 мар 2024» — для чужого.
 *
 * Год дописывается только тогда, когда он что-то различает: в подавляющем
 * большинстве строк он одинаков и занимает место без пользы.
 */
export function dayMonthShortYearIfOther(ts: number, now: number = Date.now()): string {
  if (!isUsableTimestamp(ts)) return '';
  const same = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return same ? dayMonthShort(ts) : dayMonthShortYear(ts);
}

/** «12 августа». */
export function dayMonthLong(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  const d = new Date(ts);
  return `${d.getDate()} ${MONTH_GENITIVE_RU[d.getMonth()]}`;
}

/** «12 августа 2026». */
export function dayMonthLongYear(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  return `${dayMonthLong(ts)} ${new Date(ts).getFullYear()}`;
}

/** «12 авг, 15:45». */
export function dayMonthShortTime(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  return `${dayMonthShort(ts)}, ${clockTime(ts)}`;
}

/** «12 авг, 15:45:07». */
export function dayMonthShortTimeSec(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  return `${dayMonthShort(ts)}, ${clockTimeSec(ts)}`;
}

/** «12 августа 2026, 15:45:07» — заголовок сведений и строка экспорта. */
export function fullDateTime(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  return `${dayMonthLongYear(ts)}, ${clockTimeSec(ts)}`;
}

/** «12.08.2026» — там, где дата стоит в ряду с другими короткими полями. */
export function numericDate(ts: number): string {
  if (!isUsableTimestamp(ts)) return '';
  const d = new Date(ts);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
