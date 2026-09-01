/**
 * Разделитель дней в переписке: одна подпись на личные чаты и группы.
 *
 * v4.32.421. До этого раунда копий было две, и групповая отставала на правку
 * v4.32.185 — защиту от испорченной отметки времени.
 */
import { formatDateSepLabel, isUsableTimestamp, startsNewDay } from '../time/dateSeparator';
import { formatDateSepLabel as chatLabel } from '../screens/chat-utils/dates';
import { formatGrpDateSepLabel } from '../screens/groups-utils/dates';

const at = (y: number, m: number, d: number, hh = 12, mm = 0): number =>
  new Date(y, m, d, hh, mm, 0, 0).getTime();

const now = at(2026, 7, 17, 23, 0); // понедельник, 17 августа 2026

describe('formatDateSepLabel', () => {
  it('сегодня и вчера названы словами', () => {
    expect(formatDateSepLabel(at(2026, 7, 17, 0, 5), now)).toBe('Сегодня');
    expect(formatDateSepLabel(at(2026, 7, 16, 23, 55), now)).toBe('Вчера');
  });

  it('в пределах недели — полное название дня', () => {
    expect(formatDateSepLabel(at(2026, 7, 13), now)).toBe('Четверг');
    expect(formatDateSepLabel(at(2026, 7, 11), now)).toBe('Вторник');
  });

  it('неделю назад — дата, а не сегодняшний день недели', () => {
    const weekAgo = at(2026, 7, 10, 23, 30);
    expect(now - weekAgo).toBeLessThan(7 * 24 * 3_600_000);
    expect(new Date(weekAgo).getDay()).toBe(new Date(now).getDay());
    expect(formatDateSepLabel(weekAgo, now)).toBe('10 авг');
  });

  it('чужому году дописывается год', () => {
    expect(formatDateSepLabel(at(2024, 2, 12), now)).toBe('12 мар 2024');
    expect(formatDateSepLabel(at(2026, 2, 12), now)).toBe('12 мар');
  });

  it('испорченная отметка даёт пустую подпись, а не «undefined»', () => {
    for (const bad of [NaN, 0, -1, Infinity]) {
      expect(formatDateSepLabel(bad, now)).toBe('');
      expect(isUsableTimestamp(bad)).toBe(false);
    }
  });

  it('обе экранные точки зовут одну и ту же функцию', () => {
    // Именно это и было сломано: две копии одной подписи, разошедшиеся на
    // одну правку. Ссылочное равенство здесь и есть проверка.
    expect(chatLabel).toBe(formatDateSepLabel);
    expect(formatGrpDateSepLabel).toBe(formatDateSepLabel);
  });
});

describe('startsNewDay', () => {
  it('последнее сообщение всегда закрывает список датой', () => {
    expect(startsNewDay(at(2026, 7, 17), null)).toBe(true);
  });

  it('соседи одного дня разделителя не получают', () => {
    expect(startsNewDay(at(2026, 7, 17, 0, 1), at(2026, 7, 17, 23, 59))).toBe(false);
  });

  it('две минуты через полночь — уже разные дни', () => {
    expect(startsNewDay(at(2026, 7, 16, 23, 59), at(2026, 7, 17, 0, 1))).toBe(true);
  });
});
