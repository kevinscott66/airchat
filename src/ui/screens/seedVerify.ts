/**
 * Проверка записи секретных слов после «Я сохранил секретные слова».
 *
 * Раньше кнопка сразу пускала дальше — и человек, не записавший слова,
 * узнавал об этом, только потеряв телефон. Теперь спрашиваем несколько слов
 * по номеру. Здесь — только чистые функции: какие номера спросить и совпали
 * ли ответы. Ни слова, ни ответы отсюда никуда не пишутся.
 */

/** Сколько слов спрашиваем. */
export const VERIFY_WORD_COUNT = 3;

/**
 * Выбрать `n` разных номеров слов из `count` (0-based), по возрастанию —
 * человеку проще искать по записи сверху вниз. `rng` подменяется в тестах.
 */
export function pickVerifyIndices(
  count: number,
  n: number = VERIFY_WORD_COUNT,
  rng: () => number = Math.random
): number[] {
  const take = Math.max(0, Math.min(n, count));
  const pool = Array.from({ length: count }, (_, i) => i);
  // Частичная перетасовка Фишера — Йейтса: первые `take` элементов случайны.
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (count - i));
    const k = Math.min(j, count - 1);
    [pool[i], pool[k]] = [pool[k], pool[i]];
  }
  return pool.slice(0, take).sort((a, b) => a - b);
}

/** Слово, как его сравниваем: без пробелов по краям и без регистра. */
export function normalizeSeedWord(w: string): string {
  return w.trim().toLowerCase();
}

/**
 * Совпали ли все ответы. `answers[i]` — ответ на слово `indices[i]`.
 * Пустой ответ или неизвестный номер — несовпадение.
 */
export function checkVerifyAnswers(
  words: readonly string[],
  indices: readonly number[],
  answers: readonly string[]
): boolean {
  if (indices.length === 0 || answers.length !== indices.length) return false;
  return indices.every((idx, i) => {
    const expected = words[idx];
    const got = normalizeSeedWord(answers[i] ?? '');
    return expected !== undefined && got.length > 0 && got === normalizeSeedWord(expected);
  });
}
