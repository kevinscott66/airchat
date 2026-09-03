/**
 * Код безопасности — единственное, чем двое могут поймать подмену ключа. Его
 * проверки про длину и про отказ: короткий код опаснее отсутствующего, потому
 * что выглядит как настоящий.
 */
import { computeSafetyCode, SAFETY_CODE_BYTES, SAFETY_CODE_UNKNOWN } from '../safetyCode';

const key = (fill: number): string => Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');

describe('код безопасности', () => {
  it('длина всегда одна и та же: 12 байт группами по четыре знака', () => {
    const code = computeSafetyCode(key(1), key(2));
    expect(code.replace(/ /g, '')).toHaveLength(SAFETY_CODE_BYTES * 2);
    expect(code.split(' ')).toHaveLength((SAFETY_CODE_BYTES * 2) / 4);
  });

  it('обе стороны видят одну строку — иначе сверять её бессмысленно', () => {
    expect(computeSafetyCode(key(3), key(9))).toBe(computeSafetyCode(key(9), key(3)));
  });

  it('разные собеседники — разные коды', () => {
    expect(computeSafetyCode(key(1), key(2))).not.toBe(computeSafetyCode(key(1), key(3)));
  });

  it('порченый ключ даёт прочерк, а не код покороче', () => {
    const short = Buffer.from(new Uint8Array(10).fill(7)).toString('base64');
    expect(computeSafetyCode(short, key(2))).toBe(SAFETY_CODE_UNKNOWN);
    expect(computeSafetyCode(key(2), short)).toBe(SAFETY_CODE_UNKNOWN);
    expect(computeSafetyCode('', '')).toBe(SAFETY_CODE_UNKNOWN);
  });
});
