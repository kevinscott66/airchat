/**
 * v4.32.987: уборка копий из альбомов не работала на синхронизированном
 * устройстве вообще никогда.
 *
 * Дефект. `storyAlbumFileNames` собирает имена файлов всех альбомов и рядом
 * отвечает, вышло ли прочитать ВСЕ адреса: неполный список останавливает
 * уборку, иначе она снесла бы копии живого профиля. Признак считался так:
 * «имени нет — значит список неполон». Но пустое имя — обычное состояние, а
 * не отказ: строка, приехавшая из облачной копии, вставляется с `media_file`
 * = NULL нарочно (`upsertStoryAlbumItemFromSync`: имя файла — примета ЭТОЙ
 * установки), и заполняется, только если плитку открыли и копия скачалась.
 *
 * Цена. На любом устройстве, куда доехала хоть одна чужая строка альбома,
 * `complete` был `false` навсегда. `sweepOrphanAlbumFiles` в ответ на это
 * писала в журнал и возвращала 0, не бросая, — значит удаление профиля
 * заканчивалось словами «Профиль удалён», а копии историй этого профиля
 * оставались в общем каталоге до конца жизни установки. Молча. (Само это
 * молчание закрыто отдельно, v4.32.991: теперь уборка отвечает «да/нет», и
 * отказ попадает в список остатков.)
 *
 * Правка. Останавливает уборку только `unreadable` — непрочитанный
 * шифртекст. Это и есть единственное состояние, за которым может прятаться
 * файл на диске, не названный в списке. За `absent` файла нет: если имя не
 * записалось, `albumItemLocalUri` сносит копию сразу (v4.32.576), чтобы
 * безымянных файлов не заводилось.
 *
 * Границы. Прочитанная пустая строка списку тоже ничего не добавляет и
 * уборку не останавливает — как и прежде.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Строки story_album_items, какими их видит запрос. */
let mockRows: Array<{ media_file: string | null }> = [];
/** Открывается ли шифртекст нашим ключом. */
let mockDecryptFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async (sql: string) => (
      /FROM story_album_items/i.test(sql) ? mockRows : []
    )),
    getFirstAsync: jest.fn(async () => null),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => {
  const { classifyAtRestCell } = jest.requireActual('../atRestCell');
  const decode = (v: string): string | null => {
    if (!v.startsWith('enc2:')) return v;
    return mockDecryptFails ? null : v.slice('enc2:'.length);
  };
  return {
    AT_REST_PREFIX: 'enc2:',
    AT_REST_COLUMNS: [],
    DEK_KEY: 'dek',
    getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
    encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
    encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
    encryptAtRestIfPlain: jest.fn((v: string | null) => v),
    decryptAtRestString: jest.fn((v: string) => decode(v) ?? ''),
    decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : decode(v) ?? '')),
    tryDecryptAtRest: jest.fn((v: string) => decode(v)),
    readAtRestCell: jest.fn((v: string | null) =>
      v === null ? classifyAtRestCell(null, null) : classifyAtRestCell(v, decode(v))
    ),
    canaryOpensWith: jest.fn(async () => true),
    persistDek: jest.fn(async () => undefined),
    isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
    resetDataEncryptionKeyCache: jest.fn(),
  };
});

import { storyAlbumFileNames } from '../local';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

beforeEach(() => {
  mockRows = [];
  mockDecryptFails = false;
});

describe('строка без своей копии уборку не останавливает', () => {
  it('приехавшая с другого устройства строка — обычное дело, а не отказ', async () => {
    mockRows = [{ media_file: null }];
    expect(await storyAlbumFileNames()).toEqual({ names: [], complete: true });
  });

  it('рядом со своими копиями — список полон и назван весь', async () => {
    mockRows = [
      { media_file: 'enc2:own-1.jpg' },
      { media_file: null },
      { media_file: 'enc2:own-2.jpg' },
    ];
    const { names, complete } = await storyAlbumFileNames();
    expect(names.sort()).toEqual(['own-1.jpg', 'own-2.jpg']);
    expect(complete).toBe(true);
  });

  it('целый альбом, ни разу не открытый, оставляет уборку живой', async () => {
    mockRows = Array.from({ length: 12 }, () => ({ media_file: null }));
    expect((await storyAlbumFileNames()).complete).toBe(true);
  });
});

describe('ГРАНИЦА: непрочитанное имя останавливает уборку по-прежнему', () => {
  it('шифртекст не открылся — за ним может лежать файл, не названный в списке', async () => {
    mockRows = [{ media_file: 'enc2:own-1.jpg' }];
    mockDecryptFails = true;
    expect(await storyAlbumFileNames()).toEqual({ names: [], complete: false });
  });

  it('одна непрочитанная строка среди прочитанных — этого хватает', async () => {
    mockRows = [{ media_file: 'plain-1.jpg' }, { media_file: 'enc2:own-2.jpg' }];
    mockDecryptFails = true;
    const { names, complete } = await storyAlbumFileNames();
    expect(names).toEqual(['plain-1.jpg']);
    expect(complete).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные случаи как были', () => {
  it('альбомов нет вовсе — убирать можно всё, что нашлось на диске', async () => {
    expect(await storyAlbumFileNames()).toEqual({ names: [], complete: true });
  });

  it('прочитанная пустая строка именем не считается и уборку не держит', async () => {
    mockRows = [{ media_file: 'enc2:' }];
    expect(await storyAlbumFileNames()).toEqual({ names: [], complete: true });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строка из облачной копии и правда вставляется с пустым media_file', () => {
    const local = read('storage/local.ts');
    expect(local).toContain('VALUES (?,?,?,NULL,?,?,?,?,?)');
    expect(local).toContain(' * media_file не трогается ни на вставке, ни на обновлении: имя файла — примета');
  });

  it('за пустым столбцом файла не остаётся: безымянную копию сносят сразу', () => {
    const albums = read('social/storyAlbums.ts');
    expect(albums).toContain('await deleteStoryAlbumFiles([name]);');
    expect(albums).toContain("log.warn('story_album_name_save_failed'");
  });

  it('неполный список по-прежнему отменяет уборку молча — цена промаха не выдумана', () => {
    const albums = read('social/storyAlbums.ts');
    expect(albums).toContain("log.warn('story_album_sweep_skipped_unreadable', { known: names.length });");
    expect(albums).toContain('    return 0;');
  });

  it('и звать её и правда некому, кроме удаления профиля', () => {
    const pm = fs.readFileSync(
      path.join(__dirname, '..', '..', 'identity', 'profileManager.ts'), 'utf8');
    expect(pm).toContain("const { sweepOrphanAlbumFiles } = await import('../social/storyAlbums');");
    expect(pm).toContain("leftovers.push('albums');");
  });
});
