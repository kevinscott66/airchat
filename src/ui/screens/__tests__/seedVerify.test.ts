import { checkVerifyAnswers, normalizeSeedWord, pickVerifyIndices } from '../seedVerify';

const WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

describe('pickVerifyIndices', () => {
  it('три разных номера в пределах фразы, по возрастанию', () => {
    for (let run = 0; run < 200; run++) {
      const idx = pickVerifyIndices(24);
      expect(idx).toHaveLength(3);
      expect(new Set(idx).size).toBe(3);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      for (const i of idx) {
        expect(Number.isInteger(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(24);
      }
    }
  });

  it('детерминирован при заданном rng и доходит до краёв', () => {
    expect(pickVerifyIndices(24, 3, () => 0)).toEqual([0, 1, 2]);
    // rng у самой единицы не выходит за конец массива: последнее слово берётся.
    const high = pickVerifyIndices(24, 3, () => 0.999999);
    expect(high).toContain(23);
    expect(high.every((i) => i >= 0 && i < 24)).toBe(true);
  });

  it('не просит больше слов, чем есть', () => {
    expect(pickVerifyIndices(2, 3)).toEqual([0, 1]);
    expect(pickVerifyIndices(0, 3)).toEqual([]);
  });

  it('при случайном rng со временем спрашивает разные слова', () => {
    const seen = new Set<number>();
    for (let run = 0; run < 300; run++) for (const i of pickVerifyIndices(24)) seen.add(i);
    expect(seen.size).toBe(24);
  });
});

describe('checkVerifyAnswers', () => {
  const indices = [2, 10, 23];

  it('верные ответы проходят, регистр и пробелы по краям не важны', () => {
    expect(checkVerifyAnswers(WORDS, indices, ['word3', 'word11', 'word24'])).toBe(true);
    expect(checkVerifyAnswers(WORDS, indices, ['  WORD3 ', 'Word11', 'word24\n'])).toBe(true);
  });

  it('одно неверное слово — провал', () => {
    expect(checkVerifyAnswers(WORDS, indices, ['word3', 'word12', 'word24'])).toBe(false);
  });

  it('слова не на своих местах — провал', () => {
    expect(checkVerifyAnswers(WORDS, indices, ['word11', 'word3', 'word24'])).toBe(false);
  });

  it('пустые ответы, неполный набор и чужие номера — провал', () => {
    expect(checkVerifyAnswers(WORDS, indices, ['', '', ''])).toBe(false);
    expect(checkVerifyAnswers(WORDS, indices, ['word3', 'word11'])).toBe(false);
    expect(checkVerifyAnswers(WORDS, [], [])).toBe(false);
    expect(checkVerifyAnswers(WORDS, [30], ['word31'])).toBe(false);
  });

  it('normalizeSeedWord', () => {
    expect(normalizeSeedWord('  AbC ')).toBe('abc');
  });
});
