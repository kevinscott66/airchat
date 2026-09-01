import {
  REMINDER_CHOICES,
  REMINDER_MORNING_HOUR,
  reminderTimestamp,
  type ReminderKind,
} from '../reminderSchedule';

describe('reminderSchedule', () => {
  it('«через 1 час» — ровно час от текущего момента', () => {
    const now = new Date(2026, 0, 15, 13, 27, 5).getTime();
    expect(reminderTimestamp('hour', now) - now).toBe(3_600_000);
  });

  it('«через неделю» — семь суток от текущего момента', () => {
    const now = new Date(2026, 0, 15, 13, 27, 5).getTime();
    expect(reminderTimestamp('week', now) - now).toBe(7 * 24 * 3_600_000);
  });

  it('«завтра утром» — следующий день, ровно 09:00', () => {
    const now = new Date(2026, 0, 15, 13, 27, 5, 123).getTime();
    const d = new Date(reminderTimestamp('morning', now));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(REMINDER_MORNING_HOUR);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it('«завтра утром» из ночи — это всё равно следующий календарный день', () => {
    // 02:30 — соблазн отправить «сегодня в 09:00», но кнопка обещает завтра.
    const now = new Date(2026, 0, 15, 2, 30, 0).getTime();
    const d = new Date(reminderTimestamp('morning', now));
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(REMINDER_MORNING_HOUR);
  });

  it('«завтра утром» переходит через конец месяца и года', () => {
    const endOfYear = new Date(2026, 11, 31, 23, 59, 59).getTime();
    const d = new Date(reminderTimestamp('morning', endOfYear));
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });

  it('любой вариант назначается строго в будущем', () => {
    const now = new Date(2026, 5, 10, 8, 59, 59).getTime();
    for (const choice of REMINDER_CHOICES) {
      expect(reminderTimestamp(choice.kind, now)).toBeGreaterThan(now);
    }
  });

  it('варианты не дублируются и у каждого есть подпись', () => {
    const kinds = REMINDER_CHOICES.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual<ReminderKind[]>(['hour', 'morning', 'week']);
    for (const c of REMINDER_CHOICES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.success.length).toBeGreaterThan(0);
    }
  });
});
