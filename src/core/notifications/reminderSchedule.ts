/**
 * reminderSchedule — когда должно сработать напоминание о сообщении.
 *
 * v4.32.257. До этой версии один и тот же список вариантов был выписан
 * ТРИЖДЫ: в меню сообщения личного чата, в его же быстром меню и в меню
 * сообщения группы. Копии успели разойтись: в личном чате «Завтра утром»
 * рапортовало то «Напоминание завтра в 09:00», то «Напоминание завтра утром»,
 * а в группах варианта «Через неделю» не было вовсе — не по замыслу, а потому
 * что третью копию писали отдельно.
 *
 * Модуль чистый и без импортов: время срабатывания — единственная здесь
 * логика, которую есть смысл проверять тестами, и её нельзя привязывать к
 * notifee, который в тестовой среде не поднимается.
 */

export type ReminderKind = 'hour' | 'morning' | 'week';

const HOUR_MS = 3_600_000;

/** Час, в который приходит напоминание «завтра утром» (местное время). */
export const REMINDER_MORNING_HOUR = 9;

export type ReminderChoice = {
  kind: ReminderKind;
  /** Текст кнопки в диалоге. */
  label: string;
  /** Текст подтверждения после того, как напоминание реально создано. */
  success: string;
};

export const REMINDER_CHOICES: readonly ReminderChoice[] = [
  { kind: 'hour', label: 'Через 1 час', success: 'Напоминание через 1 час' },
  { kind: 'morning', label: 'Завтра утром', success: 'Напоминание завтра в 09:00' },
  { kind: 'week', label: 'Через неделю', success: 'Напоминание через неделю' },
];

/**
 * Момент срабатывания в миллисекундах эпохи. `nowMs` передаётся явно, чтобы
 * функция оставалась чистой; «завтра утром» считается по местному календарю —
 * следующий день, 09:00, независимо от того, сколько сейчас времени.
 */
export function reminderTimestamp(kind: ReminderKind, nowMs: number): number {
  switch (kind) {
    case 'hour':
      return nowMs + HOUR_MS;
    case 'week':
      return nowMs + 7 * 24 * HOUR_MS;
    case 'morning': {
      const d = new Date(nowMs);
      d.setDate(d.getDate() + 1);
      d.setHours(REMINDER_MORNING_HOUR, 0, 0, 0);
      return d.getTime();
    }
  }
}
