/**
 * Распознавание горизонтального жеста оболочки (v4.32.540, вкладки — 575).
 *
 * Вынесено из `SwipeBackHost` отдельно от React: пороги и полоса — это
 * арифметика, которую надо проверять на числах, а не через рендер.
 */
import type { TabStep } from '../tabOrder';

/** Порог по горизонтали, после которого жест считается намеренным (точки). */
export const DX_THRESHOLD = 28;
/** Допустимый увод по вертикали на этом пороге: больше — это прокрутка. */
export const DY_TOLERANCE = 22;
/** Средняя часть экрана: от какой и до какой доли высоты ловим жест. */
export const BAND_TOP = 0.18;
export const BAND_BOTTOM = 0.82;

/**
 * Забирает ли оболочка это касание себе.
 *
 * `canStepTabs` — можно ли сейчас ходить по вкладкам. Когда нельзя, ведение
 * справа налево оболочке не нужно вовсе: «Назад» так не делают, и отбирать
 * чужое касание не за что.
 */
export function claimsSwipe(p: {
  dx: number;
  dy: number;
  y: number;
  height: number;
  canStepTabs: boolean;
}): boolean {
  if (p.height <= 0) return false;
  if (p.y < p.height * BAND_TOP || p.y > p.height * BAND_BOTTOM) return false;
  const sideways =
    Math.abs(p.dx) > DX_THRESHOLD &&
    Math.abs(p.dy) < DY_TOLERANCE &&
    Math.abs(p.dx) > Math.abs(p.dy) * 2;
  if (!sideways) return false;
  return p.dx > 0 || p.canStepTabs;
}

/** Куда шагать по панели: справа налево — вперёд, слева направо — назад. */
export function swipeStep(dx: number): TabStep {
  return dx < 0 ? 1 : -1;
}
