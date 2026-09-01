/**
 * dateSeparator — подпись на разделителе дней внутри переписки.
 *
 * v4.32.421. Правило было записано дважды — для личных чатов и для групп — и
 * копии успели разойтись. В личной версии в v4.32.185 добавили защиту от
 * испорченной отметки времени (`NaN`, ноль, отрицательное): без неё getDay и
 * getMonth возвращают NaN, разделитель подписывается «undefined», а ключ
 * элемента списка совпадает с соседним. В групповую версию та же правка не
 * попала — и не могла, потому что копия о ней не знает.
 *
 * Календарная часть считается в core/time/calendarTime: обе копии называли
 * день недели при `diff < 7 суток`, то есть подписывали «Понедельник» день,
 * отстоящий ровно на неделю, — сегодняшним днём недели.
 */
import {
  calendarDaysAgo,
  isSameCalendarDay,
  isUsableTimestamp,
  unambiguousWeekdayIndex,
} from '../../core/time/calendarTime';
import { dayMonthShortYearIfOther } from '../../core/time/ruDateTime';

export { isUsableTimestamp };

const WEEKDAY_FULL_RU = [
  'Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота',
] as const;

/**
 * Начинается ли после этого сообщения новый день — то есть нужен ли под ним
 * разделитель. `null` (сообщений дальше нет) считается новым днём: снизу
 * список всегда закрыт датой.
 */
export function startsNewDay(ts: number, nextTs: number | null): boolean {
  if (nextTs === null) return true;
  return !isSameCalendarDay(ts, nextTs);
}

/** Подпись разделителя дней: «Сегодня», «Вчера», «Пятница» или дата. */
export function formatDateSepLabel(ts: number, now: number = Date.now()): string {
  if (!isUsableTimestamp(ts)) return '';
  if (isSameCalendarDay(ts, now)) return 'Сегодня';
  if (calendarDaysAgo(ts, now) === 1) return 'Вчера';
  const weekday = unambiguousWeekdayIndex(ts, now);
  if (weekday !== null) return WEEKDAY_FULL_RU[weekday];
  return dayMonthShortYearIfOther(ts, now);
}
