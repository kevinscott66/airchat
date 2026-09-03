/**
 * Полоса альбомов историй: что на ней написано и что можно назвать альбомом
 * (v4.32.576).
 *
 * Без React, чтобы проверялось числами и строками: экран рисует то, что здесь
 * посчитано, а не считает сам.
 */

import { ruPlural } from '../../core/text/ruPlural';

/** Длина названия альбома. Полоса горизонтальная, длинное имя её и съедает. */
export const ALBUM_TITLE_MAX = 40;

/**
 * Привести название к тому виду, в котором оно ляжет в базу.
 *
 * Переводы строк и двойные пробелы приходят из вставки буфера, а на плашке
 * альбома всё равно одна строка: то, что не видно, но хранится, потом не
 * совпадает при сравнении названий.
 */
export function normalizeAlbumTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, ALBUM_TITLE_MAX);
}

/**
 * Почему это название не годится; `null` — годится.
 *
 * Совпадение проверяется без учёта регистра: два альбома «Лето» и «лето» на
 * полосе неразличимы, и человек, промахнувшись, разложит истории по двум
 * одинаковым с виду плашкам.
 */
export function albumTitleProblem(raw: string, existing: readonly string[]): string | null {
  const title = normalizeAlbumTitle(raw);
  if (title === '') return 'Название пустое.';
  const taken = existing.some((t) => normalizeAlbumTitle(t).toLowerCase() === title.toLowerCase());
  return taken ? 'Альбом с таким названием уже есть.' : null;
}

/** Подпись под плашкой альбома: сколько в нём историй. */
export function albumCountLabel(n: number): string {
  return `${n} ${ruPlural(n, ['история', 'истории', 'историй'])}`;
}
