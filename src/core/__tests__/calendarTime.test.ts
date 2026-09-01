/**
 * Календарные подписи: «вчера», день недели и граница года.
 *
 * v4.32.421. Все три места, где это правило жило раньше, считали дни
 * разностью в миллисекундах — здесь на каждую из ошибок стоит по проверке, и
 * рядом проверка невырожденности: старое значение тот же порог не проходит.
 *
 * Время во всех датах местное (`new Date(y, m, d, ...)`), потому что и
 * функция отвечает про местный календарь.
 */
import {
  WEEKDAY_LABEL_MAX_DAYS_AGO,
  calendarDaysAgo,
  isSameCalendarDay,
  isSameCalendarYear,
  weekdayLabel,
} from '../time/calendarTime';

const at = (y: number, m: number, d: number, hh = 12, mm = 0): number =>
  new Date(y, m, d, hh, mm, 0, 0).getTime();

describe('isSameCalendarDay: день, а не сутки', () => {
  it('полночь и почти полночь одного дня — один день', () => {
    expect(isSameCalendarDay(at(2026, 7, 19, 0, 1), at(2026, 7, 19, 23, 59))).toBe(true);
  });

  it('две минуты через полночь — уже разные дни', () => {
    // Между этими моментами две минуты. Разность в миллисекундах на вопрос
    // «сегодня ли это» не отвечает — ровно из-за этого правило и переехало.
    expect(isSameCalendarDay(at(2026, 7, 18, 23, 59), at(2026, 7, 19, 0, 1))).toBe(false);
  });

  it('то же число другого года — разные дни', () => {
    expect(isSameCalendarDay(at(2025, 7, 19), at(2026, 7, 19))).toBe(false);
  });
});

describe('calendarDaysAgo: считает дни календаря', () => {
  it('сегодня — ноль, вчера — один', () => {
    const now = at(2026, 7, 19, 8, 0);
    expect(calendarDaysAgo(at(2026, 7, 19, 23, 30), now)).toBe(0);
    expect(calendarDaysAgo(at(2026, 7, 18, 0, 5), now)).toBe(1);
  });

  it('вчера — это вчера даже когда прошло меньше часа', () => {
    expect(calendarDaysAgo(at(2026, 7, 18, 23, 50), at(2026, 7, 19, 0, 30))).toBe(1);
  });

  it('год назад — это не вчера', () => {
    // Прежняя проверка в списке чатов сравнивала число и месяц без года: 18
    // августа 2025, открытое 19 августа 2026, подписывалось «вчера».
    const now = at(2026, 7, 19);
    expect(calendarDaysAgo(at(2025, 7, 18), now)).toBe(366);
    expect(calendarDaysAgo(at(2025, 7, 18), now)).not.toBe(1);
  });

  it('переход на летнее время не сдвигает счёт на день', () => {
    // В сутки перехода между полуночями 23 или 25 часов. Деление без
    // округления дало бы 0.958 или 1.042 вместо ровной единицы.
    const before = at(2026, 2, 28, 12);
    const after = at(2026, 2, 29, 12);
    expect(calendarDaysAgo(before, after)).toBe(1);
  });

  it('момент в будущем даёт отрицательное число, а не ноль', () => {
    expect(calendarDaysAgo(at(2026, 7, 20), at(2026, 7, 19))).toBe(-1);
  });
});

describe('weekdayLabel: называет день, только пока он однозначен', () => {
  // 17 августа 2026 — понедельник; проверяем это здесь же, чтобы тест не
  // держался на том, что календарь совпал с ожиданием автора.
  it('опорная дата действительно понедельник', () => {
    expect(new Date(at(2026, 7, 17)).getDay()).toBe(1);
  });

  it('от вчера до шести дней назад — название дня', () => {
    const now = at(2026, 7, 17, 23, 0);
    expect(weekdayLabel(at(2026, 7, 16, 10), now)).toBe('вс');
    expect(weekdayLabel(at(2026, 7, 11, 10), now)).toBe('вт');
    expect(calendarDaysAgo(at(2026, 7, 11, 10), now)).toBe(WEEKDAY_LABEL_MAX_DAYS_AGO);
  });

  it('неделю назад — молчит, потому что это сегодняшний день недели', () => {
    // Ровно тот случай, ради которого правило и переписано: разность
    // составляет 6 суток 23.5 часа, то есть меньше семи, а день недели —
    // сегодняшний. Раньше подпись читалась как «сегодня».
    const now = at(2026, 7, 17, 23, 0);
    const weekAgo = at(2026, 7, 10, 23, 30);
    expect(now - weekAgo).toBeLessThan(7 * 24 * 3_600_000);
    expect(new Date(weekAgo).getDay()).toBe(new Date(now).getDay());
    expect(weekdayLabel(weekAgo, now)).toBeNull();
  });

  it('сегодня и будущее — тоже молчит', () => {
    const now = at(2026, 7, 17, 23, 0);
    expect(weekdayLabel(at(2026, 7, 17, 1), now)).toBeNull();
    expect(weekdayLabel(at(2026, 7, 18, 1), now)).toBeNull();
  });
});

describe('isSameCalendarYear', () => {
  it('31 декабря и 1 января — разные годы, хотя между ними часы', () => {
    expect(isSameCalendarYear(at(2025, 11, 31, 23, 30), at(2026, 0, 1, 0, 30))).toBe(false);
  });

  it('январь и декабрь одного года — один год', () => {
    expect(isSameCalendarYear(at(2026, 0, 1), at(2026, 11, 31))).toBe(true);
  });
});
