/**
 * Подписи времени в списках: один текст на список чатов, список групп и обе
 * строки глобального поиска.
 *
 * v4.32.421. Проверяется не оформление, а то, что подпись не врёт: «вчера»
 * только вчерашнему, день недели — только пока читается однозначно, год — там,
 * где без него год не отличить.
 */
import { formatListTime, formatSearchTime } from '../time/listTime';

const at = (y: number, m: number, d: number, hh = 12, mm = 0): number =>
  new Date(y, m, d, hh, mm, 0, 0).getTime();

describe('formatListTime: подпись последнего сообщения', () => {
  const now = at(2026, 7, 17, 23, 0); // понедельник, 17 августа 2026

  it('пустая отметка — пустая строка', () => {
    expect(formatListTime(0, now)).toBe('');
  });

  it('первый час считается разностью, а не календарём', () => {
    expect(formatListTime(now - 30_000, now)).toBe('только что');
    expect(formatListTime(now - 5 * 60_000, now)).toBe('5 мин');
    // Через полночь это по-прежнему «15 мин», а не «вчера»: относительная
    // подпись тем и полезна, что не спотыкается о границу суток.
    const justAfterMidnight = at(2026, 7, 18, 0, 5);
    expect(formatListTime(justAfterMidnight - 15 * 60_000, justAfterMidnight)).toBe('15 мин');
  });

  it('сегодняшнему сообщению — время', () => {
    expect(formatListTime(at(2026, 7, 17, 9, 30), now)).toMatch(/\d/);
    expect(formatListTime(at(2026, 7, 17, 9, 30), now)).not.toBe('вчера');
  });

  it('вчерашнему — «вчера»', () => {
    expect(formatListTime(at(2026, 7, 16, 9, 30), now)).toBe('вчера');
  });

  it('прошлогоднему — не «вчера»', () => {
    // Прежняя проверка сравнивала число и месяц без года.
    const yearOld = at(2025, 7, 16, 9, 30);
    expect(new Date(yearOld).getDate()).toBe(new Date(at(2026, 7, 16)).getDate());
    expect(formatListTime(yearOld, now)).not.toBe('вчера');
  });

  it('на этой неделе — день недели', () => {
    expect(formatListTime(at(2026, 7, 13, 9, 30), now)).toBe('чт');
  });

  it('неделю назад — дата, а не сегодняшний день недели', () => {
    const weekAgo = at(2026, 7, 10, 23, 30);
    expect(now - weekAgo).toBeLessThan(7 * 24 * 3_600_000);
    expect(formatListTime(weekAgo, now)).not.toBe('пн');
  });
});

describe('formatSearchTime: подпись найденного сообщения', () => {
  const now = at(2026, 7, 17, 23, 0);

  it('сегодняшнему — время без даты', () => {
    expect(formatSearchTime(at(2026, 7, 17, 9, 5), now)).toMatch(/^\d{1,2}[:.]\d{2}/);
  });

  it('этому году — день и месяц без года', () => {
    const label = formatSearchTime(at(2026, 2, 12), now);
    expect(label).not.toMatch(/26/);
  });

  it('чужому году — с годом', () => {
    // Именно этого не хватало поиску по группам: «12 мар» прошлого года был
    // неотличим от «12 мар» этого.
    const label = formatSearchTime(at(2024, 2, 12), now);
    expect(label).toMatch(/24/);
  });

  it('дня недели здесь нет: результаты перемешаны по времени', () => {
    for (const d of [11, 12, 13, 14, 15, 16]) {
      expect(['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']).not.toContain(
        formatSearchTime(at(2026, 7, d), now)
      );
    }
  });

  it('пустая отметка — пустая строка', () => {
    expect(formatSearchTime(0, now)).toBe('');
  });
});
