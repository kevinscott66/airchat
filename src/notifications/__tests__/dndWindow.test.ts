import fs from 'fs';
import path from 'path';

import { parseHourOfDay } from '../../core/time/hourOfDay';
import { isWithinDndWindow, parseDndHour } from '../dndWindow';

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const DND = (): string => codeOnly(
  fs.readFileSync(path.join(__dirname, '..', 'dndWindow.ts'), 'utf8'),
);

describe('parseDndHour', () => {
  it('берёт час из строки', () => {
    expect(parseDndHour('0', 22)).toBe(0);
    expect(parseDndHour('23', 22)).toBe(23);
    expect(parseDndHour('7', 8)).toBe(7);
  });

  it('мусор и выход за сутки — запасное значение', () => {
    for (const raw of ['', ' ', 'ночь', '-1', '24', '99', null, undefined]) {
      expect(parseDndHour(raw, 22)).toBe(22);
    }
  });
});

/**
 * Разбор часа один на оба окна (v4.32.1036).
 *
 * У тишины была своя копия проверки «0…23, иначе запасное», у ночной темы —
 * своя (`parseHourOfDay`). Копия жила по доводу «модуль здесь без единого
 * импорта», но довод отпал ещё в v4.32.975, когда сама формула окна уехала в
 * `core/time/hourOfDay`, — а копия осталась. Две копии одной проверки не
 * расходятся ровно до первой правки одной из них, и правят обычно ту,
 * из-за которой пожаловались.
 */
describe('разбор часа не размножен', () => {
  it('своей проверки в слое уведомлений не осталось', () => {
    const body = DND();
    expect(body).toContain('return parseHourOfDay(raw, fallback);');
    // Копия узнаётся по диапазону, выписанному от руки.
    expect(body).not.toContain('n >= 0 && n <= 23');
    expect(body).not.toContain('parseInt(');
  });

  it('оба имени отвечают одно и то же — и на мусоре тоже', () => {
    const inputs: (string | null | undefined)[] = [
      '0', '7', '22', '23', '24', '-1', '99', '22.5', '22000', ' 22 ', '', ' ', 'ночь', null, undefined,
    ];
    for (const raw of inputs) {
      expect(parseDndHour(raw, 22)).toBe(parseHourOfDay(raw, 22));
    }
  });
});

describe('isWithinDndWindow', () => {
  it('обычное окно: начало включительно, конец нет', () => {
    expect(isWithinDndWindow(9, 18, 9)).toBe(true);
    expect(isWithinDndWindow(9, 18, 17)).toBe(true);
    expect(isWithinDndWindow(9, 18, 18)).toBe(false);
    expect(isWithinDndWindow(9, 18, 8)).toBe(false);
  });

  it('переход через полночь — ради него всё и написано', () => {
    expect(isWithinDndWindow(22, 8, 22)).toBe(true);
    expect(isWithinDndWindow(22, 8, 23)).toBe(true);
    expect(isWithinDndWindow(22, 8, 0)).toBe(true);
    expect(isWithinDndWindow(22, 8, 7)).toBe(true);
    expect(isWithinDndWindow(22, 8, 8)).toBe(false);
    expect(isWithinDndWindow(22, 8, 12)).toBe(false);
    expect(isWithinDndWindow(22, 8, 21)).toBe(false);
  });

  it('равные границы — пустое окно, а не круглосуточная тишина', () => {
    for (let h = 0; h < 24; h++) expect(isWithinDndWindow(22, 22, h)).toBe(false);
  });
});
