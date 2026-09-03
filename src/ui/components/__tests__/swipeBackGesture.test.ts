import {
  BAND_TOP,
  BAND_BOTTOM,
  DX_THRESHOLD,
  claimsSwipe,
  swipeStep,
} from '../swipeBackGesture';

const H = 800;
const mid = H * 0.5;
const base = { dy: 0, y: mid, height: H, canStepTabs: true };

describe('жест оболочки (v4.32.575)', () => {
  it('не трогает касание, пока палец не ушёл вбок дальше порога', () => {
    expect(claimsSwipe({ ...base, dx: DX_THRESHOLD })).toBe(false);
    expect(claimsSwipe({ ...base, dx: DX_THRESHOLD + 1 })).toBe(true);
    expect(claimsSwipe({ ...base, dx: -DX_THRESHOLD - 1 })).toBe(true);
  });

  it('уступает прокрутке: заметный наклон по вертикали — не наш жест', () => {
    expect(claimsSwipe({ ...base, dx: 60, dy: 40 })).toBe(false);
    expect(claimsSwipe({ ...base, dx: 60, dy: 22 })).toBe(false);
    // Увод в допуске, но вбок ушли меньше чем вдвое дальше — тоже не наш.
    expect(claimsSwipe({ ...base, dx: 40, dy: 21 })).toBe(false);
    expect(claimsSwipe({ ...base, dx: 60, dy: 10 })).toBe(true);
  });

  it('ловит только среднюю полосу: у шапки и таббара свои жесты', () => {
    expect(claimsSwipe({ ...base, dx: 60, y: H * (BAND_TOP - 0.01) })).toBe(false);
    expect(claimsSwipe({ ...base, dx: 60, y: H * (BAND_BOTTOM + 0.01) })).toBe(false);
    expect(claimsSwipe({ ...base, dx: 60, y: H * BAND_TOP })).toBe(true);
  });

  it('до первого onLayout не забирает ничего: полосу не из чего посчитать', () => {
    expect(claimsSwipe({ ...base, dx: 60, height: 0 })).toBe(false);
  });

  it('справа налево не отбирает касание, когда по вкладкам ходить нельзя', () => {
    expect(claimsSwipe({ ...base, dx: -60, canStepTabs: false })).toBe(false);
    // Слева направо остаётся «Назад» — оно есть и без вкладок.
    expect(claimsSwipe({ ...base, dx: 60, canStepTabs: false })).toBe(true);
  });

  it('направление шага: справа налево — вперёд, слева направо — назад', () => {
    expect(swipeStep(-60)).toBe(1);
    expect(swipeStep(60)).toBe(-1);
  });
});
