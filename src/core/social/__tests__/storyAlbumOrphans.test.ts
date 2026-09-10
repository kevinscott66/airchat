import fs from 'fs';
import path from 'path';
import {
  ALBUM_ORPHAN_GRACE_MS,
  orphanAlbumItems,
} from '../storyAlbumOrphans';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function item(over: Partial<Parameters<typeof orphanAlbumItems>[0][number]> & { id: string }) {
  return {
    albumId: 'a1',
    addedAt: NOW - 3 * DAY,
    ...over,
  };
}

describe('строка альбома, потерявшая альбом', () => {
  it('сутки — не выдумка этого модуля, а объявленная величина', () => {
    expect(ALBUM_ORPHAN_GRACE_MS).toBe(DAY);
  });

  it('строка живого альбома не трогается никогда', () => {
    const rows = [item({ id: 'i1', albumId: 'a1' })];
    expect(orphanAlbumItems(rows, ['a1'], NOW)).toEqual([]);
  });

  it('строка без альбома и старше суток — потеряна', () => {
    const rows = [item({ id: 'i1', albumId: 'gone' })];
    const lost = orphanAlbumItems(rows, ['a1'], NOW);
    expect(lost.map((r) => r.id)).toEqual(['i1']);
  });

  it('строка без альбома, но моложе суток, ждёт свой альбом', () => {
    const rows = [item({ id: 'i1', albumId: 'gone', addedAt: NOW - 60_000 })];
    expect(orphanAlbumItems(rows, ['a1'], NOW)).toEqual([]);
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: та же строка через сутки уже уходит.
    expect(orphanAlbumItems(rows, ['a1'], NOW + DAY).map((r) => r.id)).toEqual(['i1']);
  });

  it('ровно сутки — уже потеряна, граница включена', () => {
    const rows = [item({ id: 'i1', albumId: 'gone', addedAt: NOW - DAY })];
    expect(orphanAlbumItems(rows, ['a1'], NOW).map((r) => r.id)).toEqual(['i1']);
  });

  it('непрочитанное имя копии оставляет строку на месте', () => {
    const rows = [item({ id: 'i1', albumId: 'gone', mediaUnreadable: true })];
    expect(orphanAlbumItems(rows, ['a1'], NOW)).toEqual([]);
  });

  it('время из будущего и мусор вместо времени не считаются старостью', () => {
    const rows = [
      item({ id: 'future', albumId: 'gone', addedAt: NOW + 10 * DAY }),
      item({ id: 'nan', albumId: 'gone', addedAt: Number.NaN }),
      item({ id: 'inf', albumId: 'gone', addedAt: Number.POSITIVE_INFINITY }),
    ];
    expect(orphanAlbumItems(rows, ['a1'], NOW)).toEqual([]);
  });

  it('разбирает список целиком, а не первую попавшуюся строку', () => {
    const rows = [
      item({ id: 'keep-alive', albumId: 'a1' }),
      item({ id: 'lost-1', albumId: 'gone' }),
      item({ id: 'keep-young', albumId: 'gone', addedAt: NOW - 60_000 }),
      item({ id: 'lost-2', albumId: 'other' }),
    ];
    expect(orphanAlbumItems(rows, ['a1'], NOW).map((r) => r.id)).toEqual(['lost-1', 'lost-2']);
  });

  it('пустой список альбомов не считается «все живы»', () => {
    const rows = [item({ id: 'i1', albumId: 'a1' })];
    expect(orphanAlbumItems(rows, [], NOW).map((r) => r.id)).toEqual(['i1']);
  });
});

const SOCIAL = path.join(__dirname, '..');

describe('уборка потерянных строк подключена к делу', () => {
  const albums = fs.readFileSync(path.join(SOCIAL, 'storyAlbums.ts'), 'utf8');
  const live = fs.readFileSync(
    path.join(SOCIAL, '..', 'sync', 'liveAccountSync.ts'), 'utf8');

  it('файлы вообще прочитаны', () => {
    expect(albums.length).toBeGreaterThan(4_000);
    expect(live.length).toBeGreaterThan(30_000);
  });

  it('уборка строк — отдельная от уборки файлов', () => {
    expect(albums).toContain('export async function sweepOrphanAlbumItems');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: старая уборка файлов осталась на месте, она про другое.
    expect(albums).toContain('export async function sweepOrphanAlbumFiles');
  });

  it('решение берётся у общего правила, а не пишется заново', () => {
    expect(albums).toContain("from './storyAlbumOrphans'");
    expect(albums).toContain('orphanAlbumItems(');
    expect(albums).not.toContain('24 * 60 * 60 * 1000');
  });

  it('вместе со строкой уходит и копия на диске', () => {
    const from = albums.indexOf('export async function sweepOrphanAlbumItems');
    const body = albums.slice(from, albums.indexOf('\n}', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез действительно захватил тело функции.
    expect(body.length).toBeGreaterThan(300);
    expect(body).toContain('deleteStoryAlbumItem(');
    expect(body).toContain('deleteStoryAlbumFiles(');
  });

  it('синхронизация зовёт уборку после разбора, а не в середине', () => {
    expect(live).toContain('sweepOrphanAlbumItems');
    const from = live.indexOf('afterProjection: async () => {');
    const body = live.slice(from, live.indexOf('onServerReset', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез действительно захватил обработчик.
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('sweepOrphanAlbumItems');
    expect(body).toContain('albumsChanged');
  });

  it('отказ уборки не роняет заход синхронизации', () => {
    const from = live.indexOf('afterProjection: async () => {');
    const body = live.slice(from, live.indexOf('onServerReset', from));
    expect(body).toContain('live_sync_album_orphan_sweep_failed');
    expect(body).toContain('} catch (e) {');
  });
});
