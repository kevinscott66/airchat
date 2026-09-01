import { isWithinDndWindow, parseDndHour } from '../dndWindow';

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
