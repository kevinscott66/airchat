/**
 * Правила экрана блокировки, отделённые от самого экрана (v4.32.326).
 *
 * Рендер-тестов React в проекте нет, а ошибиться здесь дороже, чем в любом
 * другом месте интерфейса: попыток всего пять, и каждая лишняя приближает
 * пятнадцать минут ожидания. Поэтому вся арифметика и разбор нажатий живут
 * отдельным модулем, который проверяется тестами.
 */

/** Длина PIN-кода: столько точек рисует экран и столько цифр ждёт. */
export const PIN_LENGTH = 6;

/** Клавиша «стереть». */
export const PIN_BACKSPACE = '⌫';

/**
 * Нажатие клавиши поверх набранного; возвращает новое значение — или прежнее,
 * если нажатие ничего не меняет.
 *
 * Цифра проверяется здесь, а не только раскладкой клавиатуры: набранное уходит
 * в PBKDF2 на сто тысяч итераций, и один случайный нецифровой символ стоил бы
 * целой попытки.
 */
export function applyPinKey(pin: string, key: string): string {
  if (typeof pin !== 'string') return '';
  if (key === PIN_BACKSPACE) return pin.slice(0, -1);
  if (!/^[0-9]$/.test(key)) return pin;
  if (pin.length >= PIN_LENGTH) return pin;
  return pin + key;
}

/** Набраны все цифры — пора проверять. */
export function isPinComplete(pin: string): boolean {
  return typeof pin === 'string' && pin.length === PIN_LENGTH;
}

/**
 * Сколько минут показывать в «попробуйте через N мин».
 *
 * Вверх и не меньше одной: «через 0 мин» человек прочитает как «уже можно»,
 * нажмёт и получит тот же самый экран.
 */
export function lockoutMinutesLeft(msLeft: number): number {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 0;
  return Math.max(1, Math.ceil(msLeft / 60_000));
}

/**
 * Момент окончания блокировки — 0, если блокировки нет.
 *
 * Экран ведёт обратный отсчёт от этого момента, а не вычитает по секунде на
 * каждый тик таймера: телефон засыпает, таймеры при этом не идут, и вычитание
 * показывало бы время, оставшееся «в бодрствовании», а не в жизни.
 */
export function lockoutDeadline(msLeft: number, now: number): number {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 0;
  if (!Number.isFinite(now)) return 0;
  return now + msLeft;
}

/**
 * Подсказка «осталось попыток» — или null, когда показывать нечего.
 *
 * Пока не потрачено ни одной, счётчик молчит: человеку, который просто открыл
 * приложение, нечего сообщать.
 */
export function attemptsHint(remaining: number, max: number): string | null {
  if (!Number.isFinite(remaining) || !Number.isFinite(max)) return null;
  if (remaining < 0 || remaining >= max) return null;
  return `Осталось попыток: ${Math.floor(remaining)}`;
}
