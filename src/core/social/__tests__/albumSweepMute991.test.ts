/**
 * v4.32.991: отказ уборки копий из альбомов перестал молчать.
 *
 * Дефект. `sweepOrphanAlbumFiles` останавливается, когда список «что
 * оставить» неполон, — иначе она снесла бы альбомы живого профиля. Но
 * останавливалась она молча: возвращала 0 снесённых файлов и ничего не
 * бросала. `deleteProfile` записывал остаток только по исключению, а число 0
 * значит ещё и «сносить было нечего» — то есть отказ был неотличим от
 * благополучия.
 *
 * Цена. Зовётся она в единственном месте: после удаления профиля. Строки его
 * альбомов ушли вместе с базой, а копии историй лежат в общем каталоге
 * документов, и адресов их больше нет нигде. Не состоялась уборка — файлы
 * остаются до конца жизни установки. Человек при этом читает «Профиль
 * удалён», хотя фраза для такого случая давно написана: «Профиль удалён, но
 * часть его файлов стереть не вышло». Просто до неё ничего не доходило.
 *
 * Правка. Уборка отвечает «да/нет» — как соседняя уборка аватаров строкой
 * выше, у которой ровно тот же вид отказа и ровно та же цена.
 *
 * Границы. Сама осторожность не тронута: неполный список по-прежнему
 * останавливает уборку, а не разрешает её.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Что отвечает сборщик имён: список и «все ли адреса прочитаны». */
let mockNames: { names: string[]; complete: boolean } = { names: [], complete: true };
/** Кого позвали сносить — и звали ли вообще. */
const mockSwept: Array<readonly (string | null | undefined)[]> = [];

jest.mock('uuid', () => ({ v4: () => 'uuid-stub' }));
jest.mock('../../storage/local', () => ({
  storyAlbumFileNames: jest.fn(async () => mockNames),
  deleteStoryAlbum: jest.fn(),
  deleteStoryAlbumItem: jest.fn(),
  suppressSyncEntityTombstones: jest.fn(),
  insertStoryAlbum: jest.fn(),
  insertStoryAlbumItem: jest.fn(),
  listAllStoryAlbumItems: jest.fn(),
  listStoryAlbumItems: jest.fn(),
  listStoryAlbums: jest.fn(),
  setStoryAlbumItemMediaCid: jest.fn(),
  setStoryAlbumItemMediaFile: jest.fn(),
  storyAlbumItemExists: jest.fn(),
}));
jest.mock('../../media/storyAlbumFiles', () => ({
  copyIntoStoryAlbum: jest.fn(),
  deleteStoryAlbumFiles: jest.fn(),
  newStoryAlbumFileName: jest.fn(),
  storyAlbumUriFromName: jest.fn(),
  sweepStoryAlbumFiles: jest.fn(async (keep: readonly (string | null | undefined)[]) => {
    mockSwept.push(keep);
    return keep.length;
  }),
}));
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvSetCheckedFor: jest.fn(async () => true),
  scopedKvTryGetFor: jest.fn(async () => ({ value: null })),
}));
jest.mock('../storyAlbumOrphans', () => ({ orphanAlbumItems: jest.fn() }));
jest.mock('../storyAlbumRetry', () => ({ heldAlbumUploads: jest.fn() }));
jest.mock('../../media/mediaUpload', () => ({ uploadMediaToCid: jest.fn() }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { sweepOrphanAlbumFiles } from '../storyAlbums';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

beforeEach(() => {
  mockNames = { names: [], complete: true };
  mockSwept.length = 0;
});

describe('уборка говорит, состоялась ли она', () => {
  it('список неполон — ответ «нет», а не «нечего было сносить»', async () => {
    mockNames = { names: ['a.jpg'], complete: false };
    expect(await sweepOrphanAlbumFiles()).toBe(false);
    // И ничего не снесено: осторожность прежняя.
    expect(mockSwept).toHaveLength(0);
  });

  it('удаление профиля записывает этот отказ в остаток', () => {
    const pm = read('identity', 'profileManager.ts');
    expect(pm).toContain("const { sweepOrphanAlbumFiles } = await import('../social/storyAlbums');");
    expect(pm).toContain("if (!(await sweepOrphanAlbumFiles())) leftovers.push('albums');");
  });

  it('в списке профилей для такого остатка уже есть своя фраза', () => {
    const sel = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'components', 'ProfileSelector.tsx'),
      'utf8'
    );
    expect(sel).toContain('if (result.leftovers.length > 0) {');
    expect(sel).toContain(
      "showError('Профиль удалён, но часть его файлов стереть не вышло — они остались на устройстве');"
    );
  });
});

// Блок ниже — тоже про новый ответ, а не про границу: до правки он падал.
// Граница здесь одна, и она внутри первой проверки: при неполном списке
// по-прежнему НЕ сносится ничего.
describe('состоявшаяся уборка отвечает «да»', () => {
  it('список полон — сносим и отвечаем «да»', async () => {
    mockNames = { names: ['keep-1.jpg', 'keep-2.jpg'], complete: true };
    expect(await sweepOrphanAlbumFiles()).toBe(true);
    expect(mockSwept).toEqual([['keep-1.jpg', 'keep-2.jpg']]);
  });

  it('пустой, но прочитанный список — тоже «да»: сносить всё, что нашлось', async () => {
    mockNames = { names: [], complete: true };
    expect(await sweepOrphanAlbumFiles()).toBe(true);
    expect(mockSwept).toEqual([[]]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('соседняя уборка аватаров отвечает тем же «да/нет» и так же читается', () => {
    const pm = read('identity', 'profileManager.ts');
    expect(pm).toContain('private async sweepOrphanedAvatars(): Promise<boolean> {');
    expect(pm).toContain("if (!(await this.sweepOrphanedAvatars())) leftovers.push('avatars');");
  });

  it('уборка по-прежнему зовётся ровно из одного места — удаления профиля', () => {
    const pm = read('identity', 'profileManager.ts');
    expect(pm.split('await sweepOrphanAlbumFiles()').length - 1).toBe(1);
  });

  it('копии историй по-прежнему живут в общем каталоге, не в базе', () => {
    const albums = read('social', 'storyAlbums.ts');
    expect(albums).toContain('const { names, complete } = await storyAlbumFileNames();');
    expect(albums).toContain('await sweepStoryAlbumFiles(names);');
  });
});
