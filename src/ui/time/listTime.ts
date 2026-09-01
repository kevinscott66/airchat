/**
 * listTime — подписи времени в списках: один текст на все списки.
 *
 * v4.32.421. Подпись «когда это было» рисовалась в четырёх местах: список
 * чатов, список групп, строка глобального поиска по чатам и такая же строка по
 * группам. Правило везде подразумевалось одно, а записано было по-разному —
 * и разошлось: в поиске по чатам у прошлогоднего сообщения показывался год, а
 * в поиске по группам «12 мар» прошлого года выглядело как «12 мар» этого.
 * Календарная часть правила (сегодня, вчера, день недели) переехала в
 * core/time/calendarTime и там же почищена от двух ошибок; здесь остался
 * только текст.
 */
import { calendarDaysAgo, isSameCalendarDay, weekdayLabel } from '../../core/time/calendarTime';
import { clockTime, dayMonthShort, dayMonthShortYearIfOther } from '../../core/time/ruDateTime';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Подпись последнего сообщения в списке чатов и групп.
 *
 * Первый час считается по разности — «только что» и «5 мин» тем и полезны,
 * что не зависят от того, по какую сторону полуночи это было. Дальше начинает
 * отвечать календарь.
 */
export function formatListTime(ts: number, now: number = Date.now()): string {
  if (!ts) return '';
  const diff = now - ts;
  if (diff < MINUTE_MS) return 'только что';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} мин`;
  if (isSameCalendarDay(ts, now)) return clockTime(ts);
  if (calendarDaysAgo(ts, now) === 1) return 'вчера';
  return weekdayLabel(ts, now) ?? dayMonthShort(ts);
}

/**
 * Подпись найденного сообщения в строке глобального поиска.
 *
 * Здесь дня недели нет намеренно: результаты поиска перемешаны по времени, и
 * «пт» рядом с «12 мар» не сравнить. Год дописывается только чужому году —
 * иначе он занимал бы место в подавляющем большинстве строк без пользы.
 */
export function formatSearchTime(ts: number, now: number = Date.now()): string {
  if (!ts) return '';
  if (isSameCalendarDay(ts, now)) return clockTime(ts);
  return dayMonthShortYearIfOther(ts, now);
}
