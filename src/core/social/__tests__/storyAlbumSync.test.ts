/**
 * Альбомы в облачной копии: что уезжает и что приезжает (v4.32.576).
 *
 * Две вещи здесь стоят дороже остальных, и обе — про имя файла копии. Оно
 * своё у каждой установки: уехав наверх, оно вернулось бы на второе
 * устройство, где такого файла нет, и затёрло бы там живое имя — копия
 * осталась бы лежать на диске, а плитка опустела. Поэтому его нет ни в
 * значении, ни в приёме.
 *
 * Второе — строка без общего адреса снимка. Показывать её на другом устройстве
 * нечем, и уехав, она дала бы там пустую плитку навсегда: её придерживают.
 */

const mockAlbums: unknown[] = [];
const mockItems: unknown[] = [];
const mockItemsByAlbum: Record<string, unknown[]> = {};
const upsertedAlbums: unknown[] = [];
const upsertedItems: unknown[] = [];
const deletedAlbums: string[] = [];
const deletedItems: string[] = [];
const deletedFiles: string[][] = [];
let mockSingleItem: unknown = null;

jest.mock('../../storage/local', () => ({
  listStoryAlbums: jest.fn(async () => mockAlbums),
  listAllStoryAlbumItems: jest.fn(async () => mockItems),
  listStoryAlbumItems: jest.fn(async (albumId: string) => mockItemsByAlbum[albumId] ?? []),
  getStoryAlbumItem: jest.fn(async () => mockSingleItem),
  upsertStoryAlbumFromSync: jest.fn(async (row: unknown) => { upsertedAlbums.push(row); }),
  upsertStoryAlbumItemFromSync: jest.fn(async (row: unknown) => { upsertedItems.push(row); }),
  deleteStoryAlbum: jest.fn(async (id: string) => { deletedAlbums.push(id); }),
  deleteStoryAlbumItem: jest.fn(async (id: string) => { deletedItems.push(id); }),
}));

jest.mock('../../media/storyAlbumFiles', () => ({
  deleteStoryAlbumFiles: jest.fn(async (names: string[]) => { deletedFiles.push([...names]); }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  applySyncStoryAlbum,
  applySyncStoryAlbumDelete,
  applySyncStoryAlbumItem,
  applySyncStoryAlbumItemDelete,
  exportStoryAlbumSyncSnapshot,
} from '../storyAlbumSync';

function album(over: Record<string, unknown> = {}) {
  return { id: 'a1', title: 'Лето', createdAt: 10, count: 1, coverFile: 'f.jpg', ...over };
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'a1_s1', albumId: 'a1', mediaFile: 'storyalbum_1_aaaaaa.jpg', mediaCid: 'bafy1',
    mediaType: 'image', text: 'подпись', createdAt: 5, addedAt: 7, ...over,
  };
}

beforeEach(() => {
  mockAlbums.length = 0;
  mockItems.length = 0;
  upsertedAlbums.length = 0;
  upsertedItems.length = 0;
  deletedAlbums.length = 0;
  deletedItems.length = 0;
  deletedFiles.length = 0;
  mockSingleItem = null;
  for (const k of Object.keys(mockItemsByAlbum)) delete mockItemsByAlbum[k];
});

describe('выгрузка альбомов', () => {
  it('имя файла копии наверх не уезжает', async () => {
    mockAlbums.push(album());
    mockItems.push(item());
    const snap = await exportStoryAlbumSyncSnapshot(1);
    expect(Object.keys(snap.items[0].value).sort()).toEqual(
      ['addedAt', 'albumId', 'createdAt', 'id', 'mediaCid', 'mediaType', 'text'],
    );
    expect(JSON.stringify(snap.items[0].value)).not.toContain('storyalbum_');
  });

  it('альбом уезжает названием и датой', async () => {
    mockAlbums.push(album());
    const snap = await exportStoryAlbumSyncSnapshot(1);
    expect(snap.albums[0].value).toEqual({ id: 'a1', title: 'Лето', createdAt: 10 });
    expect(snap.albums[0].hold).toBe(false);
  });

  it('непрочитанное название придерживается: пустым оно затёрло бы читаемое', async () => {
    mockAlbums.push(album({ title: '', titleUnreadable: true }));
    const snap = await exportStoryAlbumSyncSnapshot(1);
    expect(snap.albums[0].hold).toBe(true);
  });

  it('строка без общего адреса придерживается: показать её там нечем', async () => {
    mockItems.push(item({ mediaCid: null }));
    const snap = await exportStoryAlbumSyncSnapshot(1);
    expect(snap.items[0].hold).toBe(true);
  });

  it('непрочитанная подпись тоже придерживается', async () => {
    mockItems.push(item({ text: null, textUnreadable: true }));
    const snap = await exportStoryAlbumSyncSnapshot(1);
    expect(snap.items[0].hold).toBe(true);
  });

  it('обычная строка уезжает', async () => {
    mockItems.push(item());
    const snap = await exportStoryAlbumSyncSnapshot(1);
    expect(snap.items[0].hold).toBe(false);
    expect(snap.items[0].value.mediaCid).toBe('bafy1');
  });
});

describe('приём альбомов', () => {
  it('альбом записывается как есть', async () => {
    await applySyncStoryAlbum({ id: 'a1', title: 'Лето', createdAt: 10 }, 3);
    expect(upsertedAlbums).toEqual([{ id: 'a1', title: 'Лето', ownerProfileId: 3, createdAt: 10 }]);
  });

  it('альбом без идентификатора отвергается, а не пишется пустым', async () => {
    await expect(applySyncStoryAlbum({ title: 'Лето', createdAt: 10 }, 1)).rejects.toThrow();
    await expect(applySyncStoryAlbum(null, 1)).rejects.toThrow();
    expect(upsertedAlbums).toHaveLength(0);
  });

  it('строка приезжает без имени файла — его тут и быть не может', async () => {
    await applySyncStoryAlbumItem({
      id: 'a1_s1', albumId: 'a1', mediaCid: 'bafy1', mediaType: 'image',
      text: 'подпись', createdAt: 5, addedAt: 7,
      // Отправитель такого поля не шлёт; если оно всё же придёт — не наше дело.
      mediaFile: 'storyalbum_1_aaaaaa.jpg',
    }, 2);
    expect(upsertedItems).toHaveLength(1);
    expect(upsertedItems[0]).not.toHaveProperty('mediaFile');
  });

  it('незнакомый вид медиа считается снимком, а не ломает приём', async () => {
    await applySyncStoryAlbumItem({
      id: 'a1_s1', albumId: 'a1', mediaCid: null, mediaType: 'gif',
      text: null, createdAt: 5, addedAt: 7,
    }, 1);
    expect((upsertedItems[0] as { mediaType: string }).mediaType).toBe('image');
  });

  it('строка без альбома отвергается', async () => {
    await expect(applySyncStoryAlbumItem({ id: 'x', createdAt: 1, addedAt: 1 }, 1)).rejects.toThrow();
    expect(upsertedItems).toHaveLength(0);
  });
});

describe('удаление с другого устройства', () => {
  it('вместе с альбомом уходят и копии снимков', async () => {
    mockItemsByAlbum.a1 = [item(), item({ id: 'a1_s2', mediaFile: null })];
    await applySyncStoryAlbumDelete('a1', 1);
    expect(deletedAlbums).toEqual(['a1']);
    expect(deletedFiles).toEqual([['storyalbum_1_aaaaaa.jpg']]);
  });

  it('пустой альбом не зовёт уборку файлов', async () => {
    mockItemsByAlbum.a1 = [];
    await applySyncStoryAlbumDelete('a1', 1);
    expect(deletedFiles).toHaveLength(0);
  });

  it('одна строка уходит вместе со своей копией', async () => {
    mockSingleItem = item();
    await applySyncStoryAlbumItemDelete('a1_s1', 1);
    expect(deletedItems).toEqual(['a1_s1']);
    expect(deletedFiles).toEqual([['storyalbum_1_aaaaaa.jpg']]);
  });

  it('строки уже нет — строку всё равно удаляем, файла не трогаем', async () => {
    mockSingleItem = null;
    await applySyncStoryAlbumItemDelete('a1_s1', 1);
    expect(deletedItems).toEqual(['a1_s1']);
    expect(deletedFiles).toHaveLength(0);
  });
});
