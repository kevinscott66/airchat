/**
 * «Был(а) в сети…» — подпись, которую собеседник читает как факт.
 *
 * v4.32.421. Раньше она считалась внутри getPresenceState, поверх модульных
 * кэшей и `Date.now()`, а тот модуль тянет за собой транспорт IPFS — то есть
 * проверить подпись тестом было нельзя, и она врала: календарные ветки
 * считались разностью в миллисекундах, и день недели назывался при
 * `diff < 7 суток`. Семь суток — это тот же день недели: вход в понедельник в
 * 23:30 недельной давности, открытый в понедельник в 23:00, подписывался
 * «пн в 23:30», то есть выглядел как полчаса назад.
 *
 * Здесь нет ни кэшей, ни часов: «сейчас» приходит аргументом.
 */
import { ruPlural } from '../text/ruPlural';
import { isSameCalendarDay, weekdayLabel } from './calendarTime';
import { clockTime, dayMonthLong } from './ruDateTime';

export type LastSeenBucket =
  | 'online'
  | 'recently'    // последние 5 минут
  | 'minutes'     // 5–60 минут
  | 'hours'       // 1–24 часа
  | 'today'       // сегодня (> 24ч но сегодня)
  | 'days'        // вчера и пока день недели читается однозначно
  | 'long_ago'    // дальше — датой
  | 'never';      // никогда не видели

const HOURS = ['час', 'часа', 'часов'] as const;

const ONLINE_THRESHOLD_MS = 60_000;
const RECENTLY_THRESHOLD_MS = 5 * 60_000;

/** Как назвать время последнего входа: корзина и готовая строка. */
export function lastSeenLabel(
  lastActive: number,
  now: number
): { bucket: LastSeenBucket; label: string } {
  const diff = now - lastActive;

  if (diff < ONLINE_THRESHOLD_MS) return { bucket: 'online', label: 'в сети' };
  if (diff < RECENTLY_THRESHOLD_MS) return { bucket: 'recently', label: 'недавно' };
  if (diff < 60 * 60_000) {
    const mins = Math.floor(diff / 60_000);
    return { bucket: 'minutes', label: `был(а) ${mins} мин назад` };
  }
  if (diff < 24 * 3_600_000) {
    const hrs = Math.floor(diff / 3_600_000);
    return { bucket: 'hours', label: `был(а) ${hrs} ${ruPlural(hrs, HOURS)} назад` };
  }

  const timeStr = clockTime(lastActive);

  // Ниже суток эта ветка недостижима намеренно: «был(а) 22 часа назад»
  // полезнее, чем «сегодня в 01:00». Остаётся она ради суток перехода на
  // зимнее время: местный день там длится 25 часов, и без неё последний час
  // такого дня подписался бы датой — «был(а) 25 октября» о сегодняшнем входе.
  if (isSameCalendarDay(lastActive, now)) {
    return { bucket: 'today', label: `сегодня в ${timeStr}` };
  }

  const weekday = weekdayLabel(lastActive, now);
  if (weekday) return { bucket: 'days', label: `${weekday} в ${timeStr}` };

  return { bucket: 'long_ago', label: `был(а) ${dayMonthLong(lastActive)}` };
}
