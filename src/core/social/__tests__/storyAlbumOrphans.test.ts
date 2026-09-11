import fs from 'fs';
import path from 'path';
import {
  ALBUM_ORPHAN_GRACE_MS,
  ALBUM_ORPHAN_SEEN_MAX,
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

/** Память «видели осиротевшей тогда-то»: по умолчанию — давно. */
function seenLongAgo(...ids: string[]): Map<string, number> {
  return new Map(ids.map((id) => [id, NOW - 3 * DAY]));
}

describe('строка альбома, потерявшая альбом', () => {
  it('сутки — не выдумка этого модуля, а объявленная величина', () => {
    expect(ALBUM_ORPHAN_GRACE_MS).toBe(DAY);
  });

  it('строка живого альбома не трогается никогда', () => {
    const rows = [item({ id: 'i1', albumId: 'a1' })];
    const { lost, seen } = orphanAlbumItems(rows, ['a1'], NOW, seenLongAgo('i1'));
    expect(lost).toEqual([]);
    // Вернувшийся в живой альбом забывается: новая пропажа считается заново.
    expect(seen.has('i1')).toBe(false);
  });

  it('строка без альбома, увиденная осиротевшей сутки назад, — потеряна', () => {
    const rows = [item({ id: 'i1', albumId: 'gone' })];
    const { lost } = orphanAlbumItems(rows, ['a1'], NOW, seenLongAgo('i1'));
    expect(lost.map((r) => r.id)).toEqual(['i1']);
  });

  it('в первый заход строку только запоминают, а не сносят', () => {
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: время СОДЕРЖИМОГО тут древнее любого срока —
    // по старому правилу (отсчёт от addedAt) строка ушла бы в этот же заход.
    const rows = [item({ id: 'i1', albumId: 'gone', addedAt: NOW - 400 * DAY })];
    const first = orphanAlbumItems(rows, ['a1'], NOW, new Map());
    expect(first.lost).toEqual([]);
    expect(first.seen.get('i1')).toBe(NOW);
    // И только сутки спустя — уходит.
    expect(orphanAlbumItems(rows, ['a1'], NOW + DAY, first.seen).lost.map((r) => r.id))
      .toEqual(['i1']);
    expect(orphanAlbumItems(rows, ['a1'], NOW + DAY - 1, first.seen).lost).toEqual([]);
  });

  it('ровно сутки с первой встречи — уже потеряна, граница включена', () => {
    const rows = [item({ id: 'i1', albumId: 'gone' })];
    const seen = new Map([['i1', NOW - DAY]]);
    expect(orphanAlbumItems(rows, ['a1'], NOW, seen).lost.map((r) => r.id)).toEqual(['i1']);
  });

  it('память о встрече не сдвигается с каждым заходом', () => {
    const rows = [item({ id: 'i1', albumId: 'gone' })];
    const first = orphanAlbumItems(rows, ['a1'], NOW, new Map());
    const second = orphanAlbumItems(rows, ['a1'], NOW + 60_000, first.seen);
    expect(second.seen.get('i1')).toBe(NOW);
  });

  it('память из будущего и мусор вместо неё читаются как первая встреча', () => {
    const rows = [item({ id: 'i1', albumId: 'gone' })];
    const ahead = orphanAlbumItems(rows, ['a1'], NOW, new Map([['i1', NOW + DAY]]));
    expect(ahead.lost).toEqual([]);
    expect(ahead.seen.get('i1')).toBe(NOW);
    const junk = orphanAlbumItems(rows, ['a1'], NOW, new Map([['i1', Number.NaN]]));
    expect(junk.lost).toEqual([]);
    expect(junk.seen.get('i1')).toBe(NOW);
  });

  it('непрочитанное имя копии оставляет строку на месте', () => {
    const rows = [item({ id: 'i1', albumId: 'gone', mediaUnreadable: true })];
    const { lost, seen } = orphanAlbumItems(rows, ['a1'], NOW, seenLongAgo('i1'));
    expect(lost).toEqual([]);
    // Её и не запоминают: решение по ней не принимается вовсе.
    expect(seen.has('i1')).toBe(false);
  });

  it('мусор вместо времени добавления не считается старостью', () => {
    const rows = [
      item({ id: 'nan', albumId: 'gone', addedAt: Number.NaN }),
      item({ id: 'inf', albumId: 'gone', addedAt: Number.POSITIVE_INFINITY }),
    ];
    expect(orphanAlbumItems(rows, ['a1'], NOW, seenLongAgo('nan', 'inf')).lost).toEqual([]);
  });

  it('разбирает список целиком, а не первую попавшуюся строку', () => {
    const rows = [
      item({ id: 'keep-alive', albumId: 'a1' }),
      item({ id: 'lost-1', albumId: 'gone' }),
      item({ id: 'keep-young', albumId: 'gone' }),
      item({ id: 'lost-2', albumId: 'other' }),
    ];
    const seen = new Map([
      ['keep-alive', NOW - 3 * DAY],
      ['lost-1', NOW - 3 * DAY],
      ['keep-young', NOW - 60_000],
      ['lost-2', NOW - 3 * DAY],
    ]);
    const out = orphanAlbumItems(rows, ['a1'], NOW, seen);
    expect(out.lost.map((r) => r.id)).toEqual(['lost-1', 'lost-2']);
    // Молодая сирота помнится с прежнего мгновения, живая — забыта.
    expect(out.seen.get('keep-young')).toBe(NOW - 60_000);
    expect(out.seen.has('keep-alive')).toBe(false);
  });

  it('пустой список альбомов не считается «все живы»', () => {
    const rows = [item({ id: 'i1', albumId: 'a1' })];
    expect(orphanAlbumItems(rows, [], NOW, seenLongAgo('i1')).lost.map((r) => r.id))
      .toEqual(['i1']);
  });

  it('память не растёт без предела', () => {
    const rows = Array.from({ length: ALBUM_ORPHAN_SEEN_MAX + 10 }, (_, i) =>
      item({ id: `i${i}`, albumId: 'gone' }));
    const { seen } = orphanAlbumItems(rows, ['a1'], NOW, new Map());
    expect(seen.size).toBe(ALBUM_ORPHAN_SEEN_MAX);
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

  it('v4.32.717: вместе со строкой снимается и отметка синхронизации', () => {
    const from = albums.indexOf('export async function sweepOrphanAlbumItems');
    const body = albums.slice(from, albums.indexOf('\n}', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез действительно захватил тело функции.
    expect(body.length).toBeGreaterThan(300);
    // Отметка без строки — это надгробие в следующем сборе исходящего, то есть
    // удаление снимка и на втором устройстве, где альбом мог остаться цел.
    expect(body).toContain("suppressSyncEntityTombstones('story_album_item'");
  });

  it('v4.32.717: часы отсрочки местные и переживают перезапуск', () => {
    const from = albums.indexOf('export async function sweepOrphanAlbumItems');
    const body = albums.slice(from, albums.indexOf('\n}', from));
    expect(body).toContain('ORPHAN_SEEN_KEY');
    expect(body).toContain('scopedKvTryGetFor');
    expect(body).toContain('scopedKvSetCheckedFor');
    // Память не прочиталась — заход пропускается целиком.
    expect(body).toContain('story_album_orphan_seen_unreadable');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: время содержимого само по себе решения не принимает.
    expect(albums).not.toContain('addedAt >=');
  });

  it('отказ уборки не роняет заход синхронизации', () => {
    const from = live.indexOf('afterProjection: async () => {');
    const body = live.slice(from, live.indexOf('onServerReset', from));
    expect(body).toContain('live_sync_album_orphan_sweep_failed');
    expect(body).toContain('} catch (e) {');
  });
});
