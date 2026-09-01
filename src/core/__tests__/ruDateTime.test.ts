/**
 * Дата и время по-русски — одинаково на любом телефоне.
 *
 * v4.32.426. До этого раунда почти половина подписей шла через Intl с языком
 * телефона: на устройстве с английской локалью русский интерфейс показывал
 * «Aug 12, 3:45 PM». Проверить это тестом было нельзя — jest считает по своему
 * ICU, а не по телефонному, и зелёный тест ничего не говорил о том, что
 * увидит человек. Здесь Intl не участвует вовсе, поэтому тест и экран
 * показывают одно и то же.
 */
import {
  clockTime,
  clockTimeSec,
  dayMonthLong,
  dayMonthLongYear,
  dayMonthShort,
  dayMonthShortTime,
  dayMonthShortTimeSec,
  dayMonthShortYear,
  dayMonthShortYearIfOther,
  fullDateTime,
  numericDate,
} from '../time/ruDateTime';

const at = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number =>
  new Date(y, m, d, hh, mm, ss, 0).getTime();

const AUG = at(2026, 7, 12, 15, 45, 7); // 12 августа 2026, 15:45:07
const JAN = at(2026, 0, 3, 9, 5, 0); // 3 января 2026, 09:05:00

describe('часы — двадцать четыре, месяцы — словами', () => {
  it('время', () => {
    expect(clockTime(AUG)).toBe('15:45');
    expect(clockTime(JAN)).toBe('09:05');
    expect(clockTimeSec(AUG)).toBe('15:45:07');
  });

  it('после полудня это 15:45, а не 3:45 — и никакого PM', () => {
    // Ровно это и показывал телефон с английской локалью в русском окне.
    expect(clockTime(AUG)).not.toMatch(/PM|AM/i);
    expect(clockTime(AUG).startsWith('15')).toBe(true);
  });

  it('день и месяц', () => {
    expect(dayMonthShort(AUG)).toBe('12 авг');
    expect(dayMonthShort(JAN)).toBe('3 янв');
    expect(dayMonthLong(AUG)).toBe('12 августа');
    expect(dayMonthShortYear(AUG)).toBe('12 авг 2026');
    expect(dayMonthLongYear(AUG)).toBe('12 августа 2026');
  });

  it('месяц не по-английски ни в одном из двенадцати', () => {
    for (let m = 0; m < 12; m += 1) {
      const label = dayMonthShort(at(2026, m, 15));
      expect(label).toMatch(/^15 [а-я]{3}$/);
    }
  });

  it('дата со временем', () => {
    expect(dayMonthShortTime(AUG)).toBe('12 авг, 15:45');
    expect(dayMonthShortTimeSec(AUG)).toBe('12 авг, 15:45:07');
    expect(fullDateTime(AUG)).toBe('12 августа 2026, 15:45:07');
  });

  it('числовая дата — с ведущими нулями', () => {
    expect(numericDate(AUG)).toBe('12.08.2026');
    expect(numericDate(JAN)).toBe('03.01.2026');
  });

  it('год дописывается только чужому', () => {
    const now = at(2026, 7, 17);
    expect(dayMonthShortYearIfOther(at(2026, 2, 12), now)).toBe('12 мар');
    expect(dayMonthShortYearIfOther(at(2024, 2, 12), now)).toBe('12 мар 2024');
  });

  it('испорченная отметка даёт пустую строку, а не «Invalid Date»', () => {
    // Отметка приходит из строки таблицы: миграция, чужой клиент, обрыв
    // записи. `new Date(NaN).toLocaleString()` показывал «Invalid Date»
    // прямо в списке — на десяти экранах сразу.
    const all = [
      clockTime, clockTimeSec, dayMonthShort, dayMonthShortYear, dayMonthLong,
      dayMonthLongYear, dayMonthShortTime, dayMonthShortTimeSec, fullDateTime, numericDate,
    ];
    for (const bad of [NaN, 0, -1, Infinity, -Infinity]) {
      for (const fn of all) expect(fn(bad)).toBe('');
    }
    expect(dayMonthShortYearIfOther(NaN, Date.now())).toBe('');
  });
});
