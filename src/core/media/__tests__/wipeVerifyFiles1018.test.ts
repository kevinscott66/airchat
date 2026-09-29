/**
 * «Вызвали удаление» и «удалено» — разные утверждения (v4.32.1018).
 *
 * Дефект. Сброс устройства зовёт три уборщика файлов — кэш с расшифрованным,
 * аватары, сохранённые истории, — и ни один из них не бросает наружу. Отказ
 * чтения каталога каждый обращает в `0`, отказ удаления отдельного файла — в
 * строку в журнале и переход к следующему. Для сборки мусора это верно: там
 * лишний файл — мусор, а лишнее удаление стирает живое. Но сброс задаёт
 * другой вопрос, и ответа на него у этих функций не было: «сколько снесли» и
 * «осталось ли что-нибудь» — не одно и то же, а «удалили ноль» и «нечего было
 * удалять» приходили одним и тем же ответом.
 *
 * Цена. `performLocalWalletWipe` считала такой шаг прошедшим всегда, и человек,
 * нажавший «Выйти и удалить данные на устройстве», слышал, что данные удалены.
 * В кэше при этом остаются РАСШИФРОВАННЫЕ снимки, все записи голоса (файл
 * после отправки не удаляется никогда — он нужен, чтобы своё голосовое
 * игралось мгновенно), приложенные документы и выгруженная в .txt переписка;
 * в documentDirectory — последний снимок лица прежнего владельца и его
 * сохранённые истории. Всё это достаётся следующему владельцу телефона или
 * ближайшей резервной копии.
 *
 * Правка. У каждого уборщика появился парный вопрос: перечитать каталог и
 * назвать, что там ещё лежит. Непрочитанный каталог — это «осталось»: не
 * увидели не значит, что пусто. Правило то же, по которому `survivingSecrets`
 * записывает в уцелевшие ключ, который не смогла перечитать.
 *
 * Границы. Уборщики не тронуты: они по-прежнему не бросают и по-прежнему
 * отвечают числом снесённого — на них стоит «Очистить кэш» в настройках, где
 * прерваться на первом же занятом файле значило бы не освободить место.
 * Спрашивают теперь отдельно.
 */
let mockRoot: string[] = [];
let mockDocs: string[] = [];
let mockSubdirs: Record<string, string[]> = {};
let mockRootThrows = false;
let mockDocsThrows = false;

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: '/cache/',
  documentDirectory: '/doc/',
  readDirectoryAsync: jest.fn(async (uri: string) => {
    if (uri === '/cache/' || uri === '/cache') {
      if (mockRootThrows) throw new Error('EIO');
      return mockRoot;
    }
    if (uri === '/doc/' || uri === '/doc') {
      if (mockDocsThrows) throw new Error('EIO');
      return mockDocs;
    }
    const sub = mockSubdirs[uri.replace(/^\/cache\/?/, '')];
    // Каталога нет на диске — система отказывает ровно так же.
    if (!sub) throw new Error('ENOENT');
    return sub;
  }),
  deleteAsync: jest.fn(async () => {}),
  writeAsStringAsync: jest.fn(async () => {}),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => false),
  shareAsync: jest.fn(async () => {}),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { survivingSensitiveCache } from '../cacheFiles';
import { survivingAvatarFiles } from '../avatarFiles';
import { survivingStoryAlbumFiles } from '../storyAlbumFiles';

beforeEach(() => {
  mockRoot = [];
  mockDocs = [];
  mockSubdirs = {};
  mockRootThrows = false;
  mockDocsThrows = false;
});

describe('кэш: что осталось после уборки', () => {
  it('пустой кэш — не осталось ничего', async () => {
    await expect(survivingSensitiveCache()).resolves.toEqual([]);
  });

  it('выгруженная переписка осталась — названа по имени', async () => {
    mockRoot = ['airchat_export_1700000000000.txt'];
    await expect(survivingSensitiveCache()).resolves.toEqual([
      'airchat_export_1700000000000.txt',
    ]);
  });

  it('вложение осталось — тоже названо: после сброса ссылаться на него некому', async () => {
    mockRoot = ['airchat_media_abc', 'airchat_blobcache_def'];
    await expect(survivingSensitiveCache()).resolves.toEqual([
      'airchat_media_abc',
      'airchat_blobcache_def',
    ]);
  });

  it('снимок по расширению, без нашей приставки, — тоже остался', async () => {
    mockRoot = ['IMG_0042.JPEG'];
    await expect(survivingSensitiveCache()).resolves.toEqual(['IMG_0042.JPEG']);
  });

  it('уцелевший подкаталог чужого пакета назван каталогом', async () => {
    // Там лежат все записи голоса и все отправленные снимки.
    mockSubdirs = { ExpoAudio: ['voice-1.m4a'] };
    await expect(survivingSensitiveCache()).resolves.toEqual(['ExpoAudio/']);
  });

  it('пустой, но существующий подкаталог — тоже «остался»', async () => {
    // Каталог сносится целиком; уцелел он — значит, `deleteAsync` не прошёл.
    mockSubdirs = { Camera: [] };
    await expect(survivingSensitiveCache()).resolves.toEqual(['Camera/']);
  });

  it('каталог не перечитали — это «осталось», а не «пусто»', async () => {
    mockRootThrows = true;
    await expect(survivingSensitiveCache()).resolves.toEqual(['<кэш не перечитан>']);
  });

  it('ГРАНИЦА: настройки устройства кэша не касаются и в ответ не попадают', async () => {
    mockRoot = ['airchat-config.json', 'somefile.db'];
    await expect(survivingSensitiveCache()).resolves.toEqual([]);
  });
});

describe('аватары: что осталось после уборки', () => {
  it('лицо прежнего владельца осталось — названо', async () => {
    mockDocs = ['avatar_1700000000000.jpg'];
    await expect(survivingAvatarFiles([])).resolves.toEqual(['avatar_1700000000000.jpg']);
  });

  it('каталог не перечитали — это «осталось»', async () => {
    mockDocsThrows = true;
    await expect(survivingAvatarFiles([])).resolves.toEqual(['<каталог не перечитан>']);
  });

  it('ГРАНИЦА: аватар живого профиля остаться и должен', async () => {
    mockDocs = ['avatar_1.jpg'];
    await expect(survivingAvatarFiles(['/old/container/avatar_1.jpg'])).resolves.toEqual([]);
  });

  it('ГРАНИЦА: чужие файлы рядом не наши', async () => {
    mockDocs = ['airchat-config.json', 'my_avatar_1.jpg', 'avatar_abc.jpg'];
    await expect(survivingAvatarFiles([])).resolves.toEqual([]);
  });
});

describe('альбомы историй: что осталось после уборки', () => {
  it('сохранённая история осталась — названа', async () => {
    mockDocs = ['storyalbum_1700000000000_ab12cd.jpg'];
    await expect(survivingStoryAlbumFiles([])).resolves.toEqual([
      'storyalbum_1700000000000_ab12cd.jpg',
    ]);
  });

  it('каталог не перечитали — это «осталось»', async () => {
    mockDocsThrows = true;
    await expect(survivingStoryAlbumFiles([])).resolves.toEqual(['<каталог не перечитан>']);
  });

  it('ГРАНИЦА: аватар — не история, и наоборот', async () => {
    mockDocs = ['avatar_1700000000000.jpg'];
    await expect(survivingStoryAlbumFiles([])).resolves.toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const src = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8');

  it('уборщики по-прежнему обращают непрочитанный каталог в ноль', () => {
    for (const [file, mark] of [
      ['avatarFiles.ts', "log.warn('avatar_sweep_scan_failed'"],
      ['storyAlbumFiles.ts', "log.warn('story_album_sweep_scan_failed'"],
      ['cacheFiles.ts', "log.warn('cache_sweep_scan_failed'"],
    ] as const) {
      const text = src(file);
      const at = text.indexOf(mark);
      expect(at).toBeGreaterThan(0);
      expect(text.slice(at, at + 200)).toContain('return 0;');
    }
  });

  it('уборка подкаталогов по-прежнему идёт дальше после отказа удаления', () => {
    const cache = src('cacheFiles.ts');
    const at = cache.indexOf("log.warn('cache_wipe_dir_failed'");
    expect(at).toBeGreaterThan(0);
    // Ни броска, ни отметки — только строка в журнале и следующий каталог.
    expect(cache.slice(at, at + 160)).not.toContain('throw');
  });

  it('сброс по-прежнему зовёт все три уборки с пустым списком «оставить»', () => {
    const wipe = readFileSync(join(__dirname, '..', '..', 'wallet', 'wipeLocalWallet.ts'), 'utf8');
    expect(wipe).toContain("erase('media_cache', () => purgeSensitiveCache())");
    expect(wipe).toContain("erase('avatars', () => sweepAvatarFiles([]))");
    expect(wipe).toContain("erase('story_albums', () => sweepStoryAlbumFiles([]))");
  });
});
