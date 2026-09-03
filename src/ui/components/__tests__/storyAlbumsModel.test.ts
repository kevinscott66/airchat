/**
 * Названия альбомов историй (v4.32.576).
 *
 * Альбом — единственное место, где история переживает свои сутки, и найти её
 * человек будет по названию. Поэтому два неразличимых на полосе названия —
 * это потерянные истории: они разойдутся по двум одинаковым с виду плашкам.
 */
import {
  ALBUM_TITLE_MAX,
  albumCountLabel,
  albumTitleProblem,
  normalizeAlbumTitle,
} from '../storyAlbumsModel';

describe('название альбома', () => {
  it('пробелы и переводы строк схлопываются', () => {
    // Вставка из буфера приносит и то и другое, а на плашке строка одна:
    // хранить невидимое значит не узнать своё же название при сравнении.
    expect(normalizeAlbumTitle('  Лето   2026 \n ')).toBe('Лето 2026');
  });

  it('длина обрезается по потолку полосы', () => {
    const long = 'я'.repeat(ALBUM_TITLE_MAX + 20);
    expect(normalizeAlbumTitle(long)).toHaveLength(ALBUM_TITLE_MAX);
  });

  it('пустое название не альбом', () => {
    expect(albumTitleProblem('   ', [])).toBe('Название пустое.');
    expect(albumTitleProblem('\n\n', [])).toBe('Название пустое.');
  });

  it('повтор ловится без учёта регистра и лишних пробелов', () => {
    expect(albumTitleProblem('лето', ['Лето'])).toBe('Альбом с таким названием уже есть.');
    expect(albumTitleProblem('Лето  2026', ['лето 2026'])).not.toBeNull();
    expect(albumTitleProblem('Осень', ['Лето'])).toBeNull();
  });
});

describe('подпись под плашкой', () => {
  it('число историй склоняется', () => {
    expect(albumCountLabel(1)).toBe('1 история');
    expect(albumCountLabel(3)).toBe('3 истории');
    expect(albumCountLabel(11)).toBe('11 историй');
    expect(albumCountLabel(0)).toBe('0 историй');
  });
});
