import fs from 'fs';
import path from 'path';
import {
  ALBUM_UPLOAD_RETRY_BATCH,
  heldAlbumUploads,
} from '../storyAlbumRetry';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

type Cand = Parameters<typeof heldAlbumUploads>[0][number];

function item(over: Partial<Cand> & { id: string }): Cand {
  return {
    mediaFile: 'alb_1.jpg',
    mediaCid: null,
    mediaType: 'image',
    addedAt: NOW - DAY,
    ...over,
  };
}

describe('строка альбома без общего адреса', () => {
  it('размер порции — объявленная величина, а не число в коде', () => {
    expect(ALBUM_UPLOAD_RETRY_BATCH).toBeGreaterThan(0);
  });

  it('копия на диске есть, адреса нет — строку надо поднять', () => {
    expect(heldAlbumUploads([item({ id: 'i1' })]).map((r) => r.id)).toEqual(['i1']);
  });

  it('строку с адресом второй раз не поднимают', () => {
    expect(heldAlbumUploads([item({ id: 'i1', mediaCid: 'bafy1' })])).toEqual([]);
  });

  it('пустая строка адреса — тот же случай, что и отсутствие', () => {
    expect(heldAlbumUploads([item({ id: 'i1', mediaCid: '' })]).map((r) => r.id)).toEqual(['i1']);
  });

  it('без копии на диске поднимать нечего', () => {
    expect(heldAlbumUploads([item({ id: 'i1', mediaFile: null })])).toEqual([]);
  });

  it('нечитаемую копию не трогают', () => {
    expect(heldAlbumUploads([item({ id: 'i1', mediaUnreadable: true })])).toEqual([]);
  });

  it('первыми идут самые давние — они ждут дольше всех', () => {
    const rows = [
      item({ id: 'new', addedAt: NOW - DAY }),
      item({ id: 'old', addedAt: NOW - 30 * DAY }),
      item({ id: 'mid', addedAt: NOW - 7 * DAY }),
    ];
    expect(heldAlbumUploads(rows).map((r) => r.id)).toEqual(['old', 'mid', 'new']);
  });

  it('при равном времени порядок всё равно определён', () => {
    const rows = [
      item({ id: 'b', addedAt: NOW }),
      item({ id: 'a', addedAt: NOW }),
    ];
    expect(heldAlbumUploads(rows).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('порция ограничена: весь архив за один заход не выгружается', () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      item({ id: `i${i}`, addedAt: NOW - i }));
    expect(heldAlbumUploads(rows)).toHaveLength(ALBUM_UPLOAD_RETRY_BATCH);
  });

  it('порция задаётся и снаружи', () => {
    const rows = [item({ id: 'a', addedAt: 1 }), item({ id: 'b', addedAt: 2 })];
    expect(heldAlbumUploads(rows, 1).map((r) => r.id)).toEqual(['a']);
    expect(heldAlbumUploads(rows, 0)).toEqual([]);
  });

  it('время не числом — строка пропускается, а не ломает порядок', () => {
    const rows = [item({ id: 'bad', addedAt: NaN }), item({ id: 'ok' })];
    expect(heldAlbumUploads(rows).map((r) => r.id)).toEqual(['ok']);
  });

  it('исходный список не переупорядочивается на месте', () => {
    const rows = [item({ id: 'b', addedAt: 2 }), item({ id: 'a', addedAt: 1 })];
    heldAlbumUploads(rows);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

const SOCIAL = path.join(__dirname, '..');

describe('повтор загрузки подключён к делу', () => {
  const albums = fs.readFileSync(path.join(SOCIAL, 'storyAlbums.ts'), 'utf8');
  const live = fs.readFileSync(
    path.join(SOCIAL, '..', 'sync', 'liveAccountSync.ts'), 'utf8');
  const local = fs.readFileSync(
    path.join(SOCIAL, '..', 'storage', 'local.ts'), 'utf8');

  it('файлы вообще прочитаны', () => {
    expect(albums.length).toBeGreaterThan(4_000);
    expect(live.length).toBeGreaterThan(30_000);
    expect(local.length).toBeGreaterThan(100_000);
  });

  it('решение берётся у общего правила, а не пишется заново', () => {
    expect(albums).toContain("from './storyAlbumRetry'");
    expect(albums).toContain('heldAlbumUploads(');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: уборка потерянных строк — другое дело, она на месте.
    expect(albums).toContain('export async function sweepOrphanAlbumItems');
  });

  it('поднявшийся адрес действительно пишется в строку', () => {
    const from = albums.indexOf('export async function retryHeldAlbumUploads');
    const body = albums.slice(from, albums.indexOf('\n}', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез действительно захватил тело функции.
    expect(body.length).toBeGreaterThan(300);
    expect(body).toContain('uploadAlbumCopy(');
    expect(body).toContain('setStoryAlbumItemMediaCid(');
  });

  it('база отвечает, записалось ли — молчаливого успеха нет', () => {
    const from = local.indexOf('export async function setStoryAlbumItemMediaCid');
    const body = local.slice(from, local.indexOf('\n}', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез действительно захватил тело функции.
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('Promise<boolean>');
    expect(body).toContain('res.changes');
    expect(body).toContain('UPDATE story_album_items SET media_cid = ?');
    expect(body).toContain('owner_profile_id = ?');
  });

  it('повтор идёт до сбора выгрузки, а не после', () => {
    const from = live.indexOf('async function collectPending');
    const body = live.slice(from, live.indexOf('collectLocalEntities(ownerProfileId)', from));
    // ПРОВЕРКА НЕ ПУСТАЯ: срез действительно захватил начало функции.
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('retryHeldAlbumUploads(ownerProfileId)');
  });

  it('отказ повтора не роняет заход синхронизации', () => {
    const from = live.indexOf('async function collectPending');
    const body = live.slice(from, live.indexOf('collectLocalEntities(ownerProfileId)', from));
    expect(body).toContain('live_sync_album_upload_retry_failed');
    expect(body).toContain('} catch (e) {');
  });
});
