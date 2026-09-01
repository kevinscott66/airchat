/**
 * Удаление баз ленты при полном сбросе устройства (v4.32.308).
 *
 * Сброс кошелька сносил главную базу и ключ, а `airchat_feed_p<id>.db` оставлял.
 * Файл переживал сброс — и следующий профиль 1 открывал ЧУЖУЮ базу: строки на
 * месте, DEK другой, лента молча пустая. А при возврате прежней сид-фразы ключ
 * совпадал, и «удалённая» лента возвращалась целиком.
 *
 * Номера профилей растут монотонно, поэтому перебор «от 1 до предела» здесь не
 * годится — отсюда и требование к функции: она идёт от файлов в каталоге.
 */
const deleted: string[] = [];
jest.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: jest.fn(async (name: string) => {
    deleted.push(name);
  }),
  openDatabaseAsync: jest.fn(),
}));

let mockDirFiles: string[] = [];
let mockDirExists = true;
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  getInfoAsync: jest.fn(async (uri: string) => ({
    // Directory scan and post-delete file verification ask about different
    // paths; only the directory should exist in this in-memory filesystem.
    exists: uri === '/doc/SQLite/' ? mockDirExists : false,
  })),
  readDirectoryAsync: jest.fn(async () => mockDirFiles),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  decryptAtRestNullable: jest.fn(),
  decryptAtRestString: jest.fn(),
  encryptAtRestNullable: jest.fn(),
  encryptAtRestString: jest.fn(),
  getOrCreateDataEncryptionKey: jest.fn(),
}));

import { deleteAllFeedDbs, feedDbProfileId } from '../feedStorage';

beforeEach(() => {
  deleted.length = 0;
  mockDirExists = true;
  mockDirFiles = [];
});

describe('feedDbProfileId', () => {
  it('узнаёт базу ленты и её профиль', () => {
    expect(feedDbProfileId('airchat_feed_p1.db')).toBe(1);
    expect(feedDbProfileId('airchat_feed_p42.db')).toBe(42);
  });

  it('чужие файлы не трогает', () => {
    // Главная база и её служебные файлы удаляются отдельно и своим кодом:
    // спутать их с базой ленты — это снести переписку мимо сброса.
    for (const name of [
      'airchat_local.db',
      'airchat_local.db-wal',
      'airchat_feed_p1.db-journal',
      'airchat_feed_p.db',
      'airchat_feed_pX.db',
      'notes.txt',
    ]) {
      expect(feedDbProfileId(name)).toBeNull();
    }
  });
});

describe('deleteAllFeedDbs', () => {
  it('сносит базы всех профилей, найденных в каталоге', async () => {
    mockDirFiles = ['airchat_feed_p1.db', 'airchat_local.db', 'airchat_feed_p3.db'];
    expect(await deleteAllFeedDbs()).toBe(2);
    expect(deleted.sort()).toEqual(['airchat_feed_p1.db', 'airchat_feed_p3.db']);
  });

  it('находит профиль с номером больше предела на профили', async () => {
    // nextProfileId монотонен: после нескольких созданий и удалений живой
    // профиль вполне может иметь номер 7 при пределе в 4 профиля.
    mockDirFiles = ['airchat_feed_p7.db'];
    expect(await deleteAllFeedDbs()).toBe(1);
    expect(deleted).toEqual(['airchat_feed_p7.db']);
  });

  it('каталог не прочитался — сносит хотя бы переданные номера', async () => {
    mockDirExists = false;
    expect(await deleteAllFeedDbs([2, 5])).toBe(2);
    expect(deleted.sort()).toEqual(['airchat_feed_p2.db', 'airchat_feed_p5.db']);
  });

  it('переданное и найденное не удаляется дважды', async () => {
    mockDirFiles = ['airchat_feed_p1.db'];
    expect(await deleteAllFeedDbs([1])).toBe(1);
    expect(deleted).toEqual(['airchat_feed_p1.db']);
  });

  it('мусорные номера отбрасываются', async () => {
    expect(await deleteAllFeedDbs([0, -1, NaN, 1.5])).toBe(0);
    expect(deleted).toEqual([]);
  });
});
