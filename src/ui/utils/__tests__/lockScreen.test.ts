/**
 * Правила экрана блокировки (v4.32.326).
 */
import {
  PIN_BACKSPACE,
  PIN_LENGTH,
  applyPinKey,
  attemptsHint,
  isPinComplete,
  lockoutDeadline,
  lockoutMinutesLeft,
} from '../lockScreen';

describe('набор PIN-кода', () => {
  it('цифра дописывается', () => {
    expect(applyPinKey('12', '3')).toBe('123');
  });

  it('стирание убирает последнюю', () => {
    expect(applyPinKey('123', PIN_BACKSPACE)).toBe('12');
  });

  it('стирание пустого ничего не ломает', () => {
    expect(applyPinKey('', PIN_BACKSPACE)).toBe('');
  });

  it('нецифровое нажатие не меняет набранное', () => {
    for (const key of ['', ' ', 'a', '+', '١', '12']) {
      expect(applyPinKey('12', key)).toBe('12');
    }
  });

  it('больше положенного не набрать', () => {
    const full = '1'.repeat(PIN_LENGTH);
    expect(applyPinKey(full, '9')).toBe(full);
  });

  it('готовность считается по длине', () => {
    expect(isPinComplete('1'.repeat(PIN_LENGTH - 1))).toBe(false);
    expect(isPinComplete('1'.repeat(PIN_LENGTH))).toBe(true);
  });
});

describe('обратный отсчёт блокировки', () => {
  it('округляется вверх', () => {
    expect(lockoutMinutesLeft(60_001)).toBe(2);
    expect(lockoutMinutesLeft(15 * 60_000)).toBe(15);
  });

  it('меньше минуты — всё равно минута', () => {
    // «через 0 мин» человек прочитает как «уже можно».
    expect(lockoutMinutesLeft(1)).toBe(1);
    expect(lockoutMinutesLeft(59_999)).toBe(1);
  });

  it('нет блокировки — нет и минут', () => {
    expect(lockoutMinutesLeft(0)).toBe(0);
    expect(lockoutMinutesLeft(-5)).toBe(0);
    expect(lockoutMinutesLeft(NaN)).toBe(0);
  });

  it('момент окончания — это «сейчас плюс остаток»', () => {
    expect(lockoutDeadline(90_000, 1_000_000)).toBe(1_090_000);
  });

  it('нет блокировки — момента окончания нет', () => {
    expect(lockoutDeadline(0, 1_000_000)).toBe(0);
    expect(lockoutDeadline(-1, 1_000_000)).toBe(0);
    expect(lockoutDeadline(NaN, 1_000_000)).toBe(0);
    expect(lockoutDeadline(90_000, NaN)).toBe(0);
  });
});

describe('подсказка «осталось попыток»', () => {
  it('пока ничего не потрачено — молчит', () => {
    expect(attemptsHint(5, 5)).toBeNull();
  });

  it('после неудачи — называет число', () => {
    expect(attemptsHint(4, 5)).toBe('Осталось попыток: 4');
    expect(attemptsHint(0, 5)).toBe('Осталось попыток: 0');
  });

  it('на бессмыслицу не отвечает', () => {
    expect(attemptsHint(-1, 5)).toBeNull();
    expect(attemptsHint(NaN, 5)).toBeNull();
    expect(attemptsHint(3, NaN)).toBeNull();
  });
});
