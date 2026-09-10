/**
 * «Очистить кэш» и вложения, у которых больше нигде нет копии (v4.32.702).
 *
 * Суточная уборка вложений с v4.32.518 не трогает файл, на который ссылается
 * хоть одна уцелевшая строка, и не трогает вообще ничего, если список живых
 * ссылок получить не удалось. Кнопка в настройках, подписанная «Удалить
 * временные файлы и освободить место», шла мимо этого правила: она стирала те
 * же `airchat_media_*` и `airchat_blobcache_*` целиком, без проверки возраста и
 * без проверки ссылок, по одному нажатию и без подтверждения.
 *
 * У этих двух приставок копии часто нет нигде: шифртекст, доехавший по LAN, в
 * сети не лежит вовсе, а расшифрованная копия приехавшего с релея переживает
 * само вложение — на ntfy оно живёт около трёх часов. Пропавшее так вложение
 * восстановить нечем: строка на месте, превью на месте, а по нажатию — ничего.
 *
 * Отсюда проверки: правило одно на обе уборки, сбой чтения ссылок останавливает
 * чистку целиком, а безусловно вложения уходят только при сбросе устройства.
 */
import fs from 'fs';
import path from 'path';

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
  writeAsStringAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  CLEARABLE_CACHE_PREFIXES,
  CLEARABLE_CACHE_SUFFIXES,
  clearCacheFiles,
  purgeSensitiveCache,
} from '../cacheFiles';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const CACHE_FILES_SRC = src('../cacheFiles.ts');
const SWEEP_POLICY_SRC = src('../cacheSweepPolicy.ts');
const MEDIA_BLOB_SRC = src('../mediaBlob.ts');
const BLOB_REF_SRC = src('../blobRef.ts');
const LOCAL_SRC = src('../../storage/local.ts');
const SETTINGS_SRC = src('../../../ui/screens/SettingsScreen.tsx');

const nameOf = (uri: string) => uri.slice('/cache/'.length);
const survived = () => mockDirFiles.filter((n) => !deleted.map(nameOf).includes(n));

beforeEach(() => {
  mockDirFiles = [];
  mockDirThrows = false;
  deleted.length = 0;
});

describe('вложение из живой переписки переживает «Очистить кэш»', () => {
  it('на что ссылается уцелевшая строка — остаётся, остальное уходит', async () => {
    mockDirFiles = ['airchat_media_live.bin', 'airchat_media_gone.bin', 'airchat_export_chat_1.txt'];
    const removed = await clearCacheFiles(async () => new Set(['live']));
    expect(removed).toBe(2);
    expect(survived()).toEqual(['airchat_media_live.bin']);
  });

  it('расширение снимка не отменяет проверку ссылок', async () => {
    // Отдельная проверка, потому что расширения `.jpg`/`.mp4` уборка сносит
    // независимо от имени: одного вычёркивания приставок из списка было бы мало,
    // расшифрованный снимок вложения попал бы под правило расширения.
    mockDirFiles = ['airchat_media_live.jpg', 'airchat_media_gone.mp4'];
    const removed = await clearCacheFiles(async () => new Set(['live']));
    expect(removed).toBe(1);
    expect(survived()).toEqual(['airchat_media_live.jpg']);
  });

  it('шифртекст LAN защищён наравне с расшифровкой', async () => {
    // Приставка другая, а положение то же: по сети такой копии нет вовсе.
    const live = '0123456789abcdef0123456789abcdef';
    mockDirFiles = [`airchat_blobcache_${live}.bin`, 'airchat_blobcache_deadbeef.bin'];
    const removed = await clearCacheFiles(async () => new Set([live]));
    expect(removed).toBe(1);
    expect(survived()).toEqual([`airchat_blobcache_${live}.bin`]);
  });

  it('id, который сканером не выводится, толкуется в сторону сохранения', async () => {
    // Ровно 24 шестнадцатеричных знака — это хеш адреса, в тексте сообщения он
    // не встречается никогда. «Нет в списке живых» для него значит не «сирота»,
    // а «проверить нечем».
    mockDirFiles = ['airchat_media_0123456789abcdef01234567.bin'];
    expect(await clearCacheFiles(async () => new Set<string>())).toBe(0);
    expect(deleted).toEqual([]);
  });
});

describe('список ссылок не прочитался — вложения не трогаем', () => {
  it('сбой сканера останавливает чистку вложений целиком', async () => {
    // Так падает liveAttachmentBlobIds на неполном обходе: место на диске
    // вернётся при следующей попытке, удалённое вложение — никогда.
    mockDirFiles = ['airchat_media_a.bin', 'airchat_blobcache_b.bin', 'airchat_export_chat_1.txt'];
    const removed = await clearCacheFiles(async () => {
      throw new Error('ref_scan_incomplete:3/40');
    });
    expect(removed).toBe(1);
    expect(survived()).toEqual(['airchat_media_a.bin', 'airchat_blobcache_b.bin']);
  });
});

describe('сброс устройства убирает вложения безусловно', () => {
  it('при сбросе ссылки уже не важны', async () => {
    // Профилей не осталось, показывать нечего, а всё это — расшифрованное
    // содержимое чужой теперь переписки.
    mockDirFiles = ['airchat_media_live.bin', 'airchat_blobcache_live.bin'];
    expect(await purgeSensitiveCache()).toBe(2);
    expect(survived()).toEqual([]);
  });
});

describe('форма правки закреплена', () => {
  it('вложения вынесены в отдельный список', () => {
    expect(CACHE_FILES_SRC).toContain(
      "export const REFERENCED_CACHE_PREFIXES = ['airchat_media_', 'airchat_blobcache_'] as const;"
    );
    expect(CLEARABLE_CACHE_PREFIXES).not.toContain('airchat_media_');
    expect(CLEARABLE_CACHE_PREFIXES).not.toContain('airchat_blobcache_');
  });

  it('уборка вложений идёт через общий вердикт, а не своим правилом', () => {
    expect(CACHE_FILES_SRC).toContain(
      "sweepVerdict(name, Infinity, 0, REFERENCED_CACHE_PREFIXES, liveIds) !== 'delete'"
    );
    expect(CACHE_FILES_SRC).toContain(
      'export async function clearCacheFiles(loadLiveIds: LiveBlobIdsLoader): Promise<number>'
    );
  });

  it('сброс перечисляет вложения отдельной строкой, а не по недосмотру', () => {
    const wipe = CACHE_FILES_SRC.slice(CACHE_FILES_SRC.indexOf('WIPE_CACHE_PREFIXES = ['));
    expect(wipe.slice(0, 500)).toContain('...REFERENCED_CACHE_PREFIXES,');
  });

  it('экран передаёт источник живых ссылок', () => {
    expect(SETTINGS_SRC).toContain('await clearCacheFiles(liveAttachmentBlobIds);');
  });

  it('оба списка приставок называют одно и то же', () => {
    // Списка два: втянуть cacheFiles в mediaBlob значит затащить туда же
    // expo-sharing. Поэтому не общая константа, а сверка — разойдутся списки,
    // и часть вложений снова окажется без защиты.
    expect(BLOB_REF_SRC).toContain("export const BLOB_CACHE_PREFIX = 'airchat_media_';");
    expect(MEDIA_BLOB_SRC).toContain(
      "const CACHE_PREFIXES = [BLOB_CACHE_PREFIX, 'airchat_blobcache_'];"
    );
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('вердикт по-прежнему останавливается на непрочитанном списке', () => {
    expect(SWEEP_POLICY_SRC).toContain("if (liveIds === null) return 'keep';");
  });

  it('сканер ссылок по-прежнему падает на неполном обходе', () => {
    expect(LOCAL_SRC).toContain('throw new Error(`ref_scan_incomplete:');
  });

  it('расширения снимков по-прежнему убираются независимо от имени', () => {
    expect(CLEARABLE_CACHE_SUFFIXES).toContain('.jpg');
    expect(CLEARABLE_CACHE_SUFFIXES).toContain('.mp4');
  });

  it('кнопка по-прежнему срабатывает с одного нажатия, без подтверждения', () => {
    expect(SETTINGS_SRC).toContain('onPress={() => void clearCache()}');
    expect(SETTINGS_SRC).toContain('Удалить временные файлы и освободить место');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('заглушка каталога и удаления действительно работает', async () => {
    mockDirFiles = ['airchat_export_chat_1.txt'];
    expect(await clearCacheFiles(async () => new Set<string>())).toBe(1);
    expect(deleted).toEqual(['/cache/airchat_export_chat_1.txt']);
  });

  it('каталог не прочитался — не удаляется ничего', async () => {
    mockDirThrows = true;
    expect(await clearCacheFiles(async () => new Set<string>())).toBe(0);
    expect(deleted).toEqual([]);
  });
});
