/**
 * Уборка файлов аватаров (v4.32.309).
 *
 * Аватар копируется в `avatar_<время>.jpg`, а предыдущий удаляется только при
 * СЛЕДУЮЩЕЙ смене. Когда профиль удаляют или сбрасывают устройство, менять
 * нечего — и снимок лица оставался лежать открытым файлом навсегда.
 *
 * Отсюда сборка мусора: удаляется всё, за чем не осталось живого профиля. Цена
 * ошибки несимметрична — лишний файл это мусор, а лишнее удаление стирает
 * аватар живого профиля, поэтому шаблон имени и список «оставить» проверяются
 * придирчиво.
 */
let mockDirFiles: string[] = [];
let mockDirThrows = false;
const deleted: string[] = [];
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  readDirectoryAsync: jest.fn(async () => {
    if (mockDirThrows) throw new Error('EIO');
    return mockDirFiles;
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    deleted.push(uri);
  }),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { isAvatarFileName, newAvatarUri, sweepAvatarFiles } from '../avatarFiles';

beforeEach(() => {
  mockDirFiles = [];
  mockDirThrows = false;
  deleted.length = 0;
});

describe('шаблон имени', () => {
  it('имя, которое пишет экран профиля, уборка узнаёт', () => {
    // Ровно та связка, ради которой имя и переехало в один модуль: если
    // шаблоны разъедутся, уборка перестанет видеть свои же файлы.
    const uri = newAvatarUri(1700000000000);
    expect(uri).toBe('/doc/avatar_1700000000000.jpg');
    expect(isAvatarFileName(uri.slice('/doc/'.length))).toBe(true);
  });

  it('чужие файлы под шаблон не подходят', () => {
    for (const name of [
      'airchat_dialogs_backup_v1_p1.json',
      'airchat-config.json',
      'avatar_.jpg',
      'avatar_abc.jpg',
      'avatar_1.png',
      'my_avatar_1.jpg',
      'avatar_1.jpg.bak',
    ]) {
      expect(isAvatarFileName(name)).toBe(false);
    }
  });
});

describe('sweepAvatarFiles', () => {
  it('сносит осиротевшие и не трогает живые', async () => {
    mockDirFiles = ['avatar_1.jpg', 'avatar_2.jpg', 'avatar_3.jpg'];
    expect(await sweepAvatarFiles(['/doc/avatar_2.jpg'])).toBe(2);
    expect(deleted.sort()).toEqual(['/doc/avatar_1.jpg', '/doc/avatar_3.jpg']);
  });

  it('пустой список — полный сброс, уходит всё', async () => {
    mockDirFiles = ['avatar_1.jpg', 'avatar_2.jpg'];
    expect(await sweepAvatarFiles([])).toBe(2);
  });

  it('чужие файлы в том же каталоге не трогает', async () => {
    // В documentDirectory лежат копии диалогов и настройки устройства: снести
    // копию значит лишить человека единственного пути вернуть переписку.
    mockDirFiles = ['airchat_dialogs_backup_v1_p1.json', 'airchat-config.json', 'avatar_9.jpg'];
    expect(await sweepAvatarFiles([])).toBe(1);
    expect(deleted).toEqual(['/doc/avatar_9.jpg']);
  });

  it('null и пустые строки в списке живых ничего не «сохраняют»', async () => {
    // У профиля без аватара путь пустой; принять его за путь означало бы
    // случайно сохранить непонятно что.
    mockDirFiles = ['avatar_1.jpg'];
    expect(await sweepAvatarFiles([null, undefined, ''])).toBe(1);
    expect(deleted).toEqual(['/doc/avatar_1.jpg']);
  });

  it('каталог не прочитался — не удаляется ничего', async () => {
    mockDirThrows = true;
    expect(await sweepAvatarFiles([])).toBe(0);
    expect(deleted).toEqual([]);
  });
});
