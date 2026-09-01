/**
 * Временные файлы кэша: имя и уборка (v4.32.310).
 *
 * Экспорт переписки писал расшифрованную беседу в .txt под тремя разными
 * именами — `airchat_export_`, `group_export_`, `chat_`, — и ни одно из них не
 * входило в список «Очистить кэш». То есть открытый текст переписки оставался
 * на устройстве, сколько бы раз человек кэш ни чистил и даже после «удалить
 * данные на устройстве».
 *
 * Отсюда требования: имя даёт тот же модуль, что и убирает; уборка при сбросе
 * шире, чем при ручной чистке; и ни одна из них не трогает чужое.
 */
let mockDirFiles: string[] = [];
let mockDirThrows = false;
const deleted: string[] = [];
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: '/cache/',
  readDirectoryAsync: jest.fn(async () => {
    if (mockDirThrows) throw new Error('EIO');
    return mockDirFiles;
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    deleted.push(uri);
  }),
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockWritten.push([uri, content]);
  }),
}));
const mockWritten: [string, string][] = [];
let mockSharingAvailable = true;
const mockShared: string[] = [];
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => mockSharingAvailable),
  shareAsync: jest.fn(async (uri: string) => {
    mockShared.push(uri);
  }),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  CLEARABLE_CACHE_PREFIXES,
  clearCacheFiles,
  exportTextCacheUri,
  purgeSensitiveCache,
  shareTextExport,
} from '../cacheFiles';

const nameOf = (uri: string) => uri.slice('/cache/'.length);

beforeEach(() => {
  mockDirFiles = [];
  mockDirThrows = false;
  deleted.length = 0;
});

describe('имя файла выгрузки', () => {
  it('то, что пишет экран, уборка узнаёт', () => {
    // Связка, ради которой имя и переехало в один модуль.
    const uri = exportTextCacheUri('chat', 1700000000000);
    expect(uri).toBe('/cache/airchat_export_chat_1700000000000.txt');
    expect(CLEARABLE_CACHE_PREFIXES.some((p) => nameOf(uri).startsWith(p))).toBe(true);
  });

  it('вид выгрузки различим, и ничего сверх него в имя не попадает', () => {
    // Имя файла всплывает в чужих приложениях и в списке недавних. Собеседник
    // или название группы в нём — это тот самый факт «кто с кем», который вся
    // переписка и прячет; поэтому вид выгрузки — перечисление, а не строка, и
    // подставить туда имя человека нельзя даже по невнимательности.
    expect(nameOf(exportTextCacheUri('group', 5))).toBe('airchat_export_group_5.txt');
    // @ts-expect-error — произвольная строка в имя файла не допускается
    expect(nameOf(exportTextCacheUri('Аня', 5))).toBe('airchat_export_Аня_5.txt');
  });
});

describe('очистка кэша из настроек', () => {
  it('убирает выгруженную переписку и вложения', async () => {
    mockDirFiles = ['airchat_export_chat_1.txt', 'airchat_media_a.bin', 'photo.JPG'];
    expect(await clearCacheFiles()).toBe(3);
  });

  it('не трогает то, что может быть в работе', async () => {
    // Куски IPFS и картинки постов ленты могут показываться прямо сейчас:
    // снести их на живом приложении — получить пустой квадрат вместо картинки.
    mockDirFiles = ['ipfs_http_add_1.bin', 'feed_q_abc_0.img', 'unknown.dat'];
    expect(await clearCacheFiles()).toBe(0);
    expect(deleted).toEqual([]);
  });
});

describe('очистка кэша при сбросе устройства', () => {
  it('шире ручной: уходит и лента, и промежуточные файлы', async () => {
    mockDirFiles = ['airchat_export_chat_1.txt', 'feed_q_abc_0.img', 'ipfs_http_add_1.bin'];
    expect(await purgeSensitiveCache()).toBe(3);
  });

  it('чужие файлы всё равно не трогает', async () => {
    // Слепое «удалить всё из кэша» задело бы файлы соседних библиотек.
    mockDirFiles = ['some_other_lib.dat', 'RCTAsyncLocalStorage'];
    expect(await purgeSensitiveCache()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('каталог не прочитался — не удаляется ничего', async () => {
    mockDirThrows = true;
    expect(await purgeSensitiveCache()).toBe(0);
    expect(deleted).toEqual([]);
  });
});

describe('отдача выгрузки в «Поделиться»', () => {
  beforeEach(() => {
    mockWritten.length = 0;
    mockShared.length = 0;
    mockSharingAvailable = true;
  });

  it('отдаёт файл, а не текст сообщения', async () => {
    // Отправка переписки текстом уезжает на Android через Binder и рвётся
    // примерно на мегабайте, а до разрыва кладёт беседу целиком в чужой буфер.
    const ok = await shareTextExport('chat', 'строка\nвторая', 'Чат с Аней', 7);
    expect(ok).toBe(true);
    expect(mockWritten).toEqual([['/cache/airchat_export_chat_7.txt', 'строка\nвторая']]);
    expect(mockShared).toEqual(['/cache/airchat_export_chat_7.txt']);
  });

  it('файл называется так, чтобы за ним убрали', async () => {
    // Иначе повторяется v4.32.310: расшифрованная переписка мимо всех уборок.
    await shareTextExport('group', 'txt', 'Экспорт группы', 8);
    const name = nameOf(mockWritten[0]?.[0] ?? '');
    expect(CLEARABLE_CACHE_PREFIXES.some((p) => name.startsWith(p))).toBe(true);
  });

  it('без системного «Поделиться» ничего не отдаёт наружу', async () => {
    mockSharingAvailable = false;
    expect(await shareTextExport('chat', 'секрет', 'Чат', 9)).toBe(false);
    expect(mockShared).toEqual([]);
  });

  it('в имени файла нет имени собеседника', async () => {
    // Имя файла всплывает в чужом приложении и в списке недавних: там не должно
    // оказаться того самого «кто с кем», что прячет вся переписка.
    await shareTextExport('chat', 'txt', 'Чат с Аней Петровой', 10);
    expect(nameOf(mockWritten[0]?.[0] ?? '')).toBe('airchat_export_chat_10.txt');
  });
});
