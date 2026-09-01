/**
 * Предел вложенных фотографий в переписке (v4.32.322).
 */
import {
  CHAT_MAX_IMAGES,
  mergePickedImages,
  remainingImageSlots,
} from '../mediaAttachPolicy';

describe('сколько ещё можно выбрать', () => {
  it('пусто — весь предел', () => {
    expect(remainingImageSlots(0)).toBe(CHAT_MAX_IMAGES);
  });

  it('предел выбран — ноль, а не единица', () => {
    // Прежняя запись `Math.max(1, 10 - выбрано)` отвечала здесь единицей, и
    // picker разрешал выбрать одиннадцатую — её потом молча срезали.
    expect(remainingImageSlots(CHAT_MAX_IMAGES)).toBe(0);
    expect(remainingImageSlots(CHAT_MAX_IMAGES + 3)).toBe(0);
  });

  it('отрицательное количество не превращается в лишние места', () => {
    expect(remainingImageSlots(-5)).toBe(CHAT_MAX_IMAGES);
  });
});

describe('добавление выбранного к уже выбранному', () => {
  it('обычный случай', () => {
    const res = mergePickedImages(['a'], ['b', 'c']);
    expect(res.next).toEqual(['a', 'b', 'c']);
    expect(res.added).toBe(2);
    expect(res.overLimit).toBe(0);
    expect(res.duplicates).toBe(0);
  });

  it('та же фотография второй раз не добавляется', () => {
    const res = mergePickedImages(['a', 'b'], ['b', 'c', 'c']);
    expect(res.next).toEqual(['a', 'b', 'c']);
    expect(res.added).toBe(1);
    expect(res.duplicates).toBe(2);
  });

  it('сверх предела — считается отдельно, а не пропадает молча', () => {
    const attached = Array.from({ length: CHAT_MAX_IMAGES - 1 }, (_, i) => `a${i}`);
    const res = mergePickedImages(attached, ['x', 'y', 'z']);
    expect(res.next).toHaveLength(CHAT_MAX_IMAGES);
    expect(res.added).toBe(1);
    expect(res.overLimit).toBe(2);
  });

  it('предел уже выбран — не добавляется ничего', () => {
    const attached = Array.from({ length: CHAT_MAX_IMAGES }, (_, i) => `a${i}`);
    const res = mergePickedImages(attached, ['x']);
    expect(res.next).toEqual(attached);
    expect(res.added).toBe(0);
    expect(res.overLimit).toBe(1);
  });

  it('ответ не того вида — прежний список без изменений', () => {
    expect(mergePickedImages(['a'], null).next).toEqual(['a']);
    expect(mergePickedImages(['a'], [null, 42, '']).next).toEqual(['a']);
  });

  it('исходный список не меняется на месте', () => {
    const attached = ['a'];
    mergePickedImages(attached, ['b']);
    expect(attached).toEqual(['a']);
  });
});
