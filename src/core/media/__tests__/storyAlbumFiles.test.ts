/**
 * Файлы альбомов историй (v4.32.576).
 *
 * История живёт сутки и уходит вместе со своим файлом — это обещание. Альбом
 * держит СВОЮ копию, и цена ошибки здесь несимметрична ровно как у аватаров:
 * лишний файл — мусор, лишнее удаление стирает то единственное, что человек
 * решил оставить навсегда.
 */
let mockDirFiles: string[] = [];
let mockDirThrows = false;
let mockCopyThrows = false;
const deleted: string[] = [];
const copied: Array<{ from: string; to: string }> = [];
const written: Array<{ uri: string; data: string }> = [];
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { Base64: 'base64' },
  readDirectoryAsync: jest.fn(async () => {
    if (mockDirThrows) throw new Error('EIO');
    return mockDirFiles;
  }),
  deleteAsync: jest.fn(async (uri: string) => { deleted.push(uri); }),
  copyAsync: jest.fn(async (o: { from: string; to: string }) => {
    if (mockCopyThrows) throw new Error('ENOSPC');
    copied.push(o);
  }),
  writeAsStringAsync: jest.fn(async (uri: string, data: string) => { written.push({ uri, data }); }),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  copyIntoStoryAlbum,
  deleteStoryAlbumFiles,
  isStoryAlbumFileName,
  newStoryAlbumFileName,
  storyAlbumFileName,
  storyAlbumFileToken,
  storyAlbumUriFromName,
  sweepStoryAlbumFiles,
} from '../storyAlbumFiles';

beforeEach(() => {
  mockDirFiles = [];
  mockDirThrows = false;
  mockCopyThrows = false;
  deleted.length = 0;
  copied.length = 0;
  written.length = 0;
});

describe('шаблон имени', () => {
  it('имя, которое пишет альбом, уборка узнаёт', () => {
    // Та же связка, ради которой имя живёт в одном модуле: разъедутся
    // шаблоны — уборка перестанет видеть свои же файлы.
    const name = newStoryAlbumFileName(1700000000000, 'image', 'ab12cd');
    expect(name).toBe('storyalbum_1700000000000_ab12cd.jpg');
    expect(isStoryAlbumFileName(name)).toBe(true);
    expect(storyAlbumUriFromName(name)).toBe('/doc/storyalbum_1700000000000_ab12cd.jpg');
  });

  it('видео получает своё расширение', () => {
    expect(newStoryAlbumFileName(1, 'video', 'aaaaaa')).toBe('storyalbum_1_aaaaaa.mp4');
  });

  it('случайный хвост подходит под шаблон', () => {
    // Одного времени мало: два нажатия подряд попадают в одну миллисекунду,
    // и второй файл затёр бы первый.
    for (let i = 0; i < 50; i++) {
      expect(isStoryAlbumFileName(newStoryAlbumFileName(7, 'image', storyAlbumFileToken()))).toBe(true);
    }
  });

  it('чужие файлы под шаблон не подходят', () => {
    for (const name of [
      'avatar_1700000000000.jpg',
      'storyalbum_.jpg',
      'storyalbum_1_ab.jpg',
      'storyalbum_1_ab12cd.png',
      'storyalbum_1_AB12CD.jpg',
      'my_storyalbum_1_ab12cd.jpg',
      'storyalbum_1_ab12cd.jpg.bak',
    ]) {
      expect(isStoryAlbumFileName(name)).toBe(false);
    }
  });

  it('имя достаётся и из пути, и из имени', () => {
    // В базе лежит имя, но путь прошлой установки мог осесть где угодно:
    // сверять надо то, что уцелело от смены контейнера.
    expect(storyAlbumFileName('/old/container/storyalbum_5_ab12cd.jpg'))
      .toBe('storyalbum_5_ab12cd.jpg');
    expect(storyAlbumFileName('storyalbum_5_ab12cd.jpg')).toBe('storyalbum_5_ab12cd.jpg');
    expect(storyAlbumFileName('avatar_5.jpg')).toBe('');
    expect(storyAlbumFileName(null)).toBe('');
  });
});

describe('копия истории', () => {
  it('файл копируется', async () => {
    const name = newStoryAlbumFileName(1, 'image', 'ab12cd');
    expect(await copyIntoStoryAlbum('file:///cache/story.jpg', name)).toBe(true);
    expect(copied).toEqual([{ from: 'file:///cache/story.jpg', to: `/doc/${name}` }]);
  });

  it('data:-адрес пишется байтами, а не копированием', async () => {
    // Чужая сторис из IPFS приезжает строкой base64, копировать там нечего.
    const name = newStoryAlbumFileName(1, 'image', 'ab12cd');
    expect(await copyIntoStoryAlbum('data:image/jpeg;base64,QUJD', name)).toBe(true);
    expect(written).toEqual([{ uri: `/doc/${name}`, data: 'QUJD' }]);
    expect(copied).toHaveLength(0);
  });

  it('несостоявшаяся копия честно отвечает «нет»', async () => {
    // Строка без файла — это пустая плитка навсегда, поэтому вызывающий
    // обязан узнать о сбое до того, как запишет её.
    mockCopyThrows = true;
    expect(await copyIntoStoryAlbum('file:///cache/story.jpg', newStoryAlbumFileName(1, 'image', 'ab12cd')))
      .toBe(false);
  });

  it('чужое имя не становится адресом', async () => {
    expect(await copyIntoStoryAlbum('file:///cache/story.jpg', 'avatar_1.jpg')).toBe(false);
    expect(copied).toHaveLength(0);
  });
});

describe('уборка', () => {
  it('сносит только то, за чем не осталось строки', async () => {
    mockDirFiles = [
      'storyalbum_1_aaaaaa.jpg',
      'storyalbum_2_bbbbbb.jpg',
      'avatar_3.jpg',
      'airchat-config.json',
    ];
    const removed = await sweepStoryAlbumFiles(['storyalbum_1_aaaaaa.jpg']);
    expect(removed).toBe(1);
    expect(deleted).toEqual(['/doc/storyalbum_2_bbbbbb.jpg']);
  });

  it('список «оставить» сверяется по имени, а не по пути', async () => {
    // Путь прошлой установки указывает в исчезнувший контейнер: сверка по
    // нему очистила бы весь список «оставить» и снесла живые альбомы.
    mockDirFiles = ['storyalbum_1_aaaaaa.jpg'];
    expect(await sweepStoryAlbumFiles(['/gone/container/storyalbum_1_aaaaaa.jpg'])).toBe(0);
    expect(deleted).toHaveLength(0);
  });

  it('нечитаемый каталог не даёт удалять вслепую', async () => {
    mockDirThrows = true;
    expect(await sweepStoryAlbumFiles([])).toBe(0);
    expect(deleted).toHaveLength(0);
  });

  it('адресное удаление берёт только свои имена', async () => {
    expect(await deleteStoryAlbumFiles(['storyalbum_1_aaaaaa.jpg', 'avatar_2.jpg'])).toBe(1);
    expect(deleted).toEqual(['/doc/storyalbum_1_aaaaaa.jpg']);
  });
});
