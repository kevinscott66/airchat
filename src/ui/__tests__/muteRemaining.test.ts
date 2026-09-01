/**
 * Остаток «без звука»: одна подпись на список чатов, список групп и меню.
 *
 * v4.32.426. Копий было три, и они расходились в тексте — «45м» в списке и
 * «45 мин» в меню той же самой переписки.
 */
import { muteRemainingLabel } from '../time/durationLabel';

const NOW = new Date(2026, 7, 12, 15, 0, 0, 0).getTime();

describe('muteRemainingLabel', () => {
  it('истёкшее и будущее', () => {
    expect(muteRemainingLabel(NOW - 1, NOW)).toBe('');
    expect(muteRemainingLabel(NOW, NOW)).toBe('');
    expect(muteRemainingLabel(NOW + 60_000, NOW)).toBe('1 мин');
    expect(muteRemainingLabel(NOW + 45 * 60_000, NOW)).toBe('45 мин');
  });

  it('неполная минута — всё ещё минута, а не ноль', () => {
    expect(muteRemainingLabel(NOW + 1_000, NOW)).toBe('1 мин');
  });

  it('последняя минута часа — «1 ч», а не «60 мин»', () => {
    // Все три прежние копии писали здесь «60 мин»: порог стоял на часе, а
    // округление вверх успевало добежать до шестидесяти минут раньше.
    expect(muteRemainingLabel(NOW + 3_599_999, NOW)).toBe('1 ч');
    expect(muteRemainingLabel(NOW + 2 * 3_600_000, NOW)).toBe('2 ч');
  });

  it('последний час суток — «1 д», а не «24 ч»', () => {
    expect(muteRemainingLabel(NOW + 86_399_999, NOW)).toBe('1 д');
    expect(muteRemainingLabel(NOW + 3 * 86_400_000, NOW)).toBe('3 д');
  });

  it('испорченный срок — пустая подпись, а не «NaN мин»', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(muteRemainingLabel(bad, NOW)).toBe('');
    }
  });
});
