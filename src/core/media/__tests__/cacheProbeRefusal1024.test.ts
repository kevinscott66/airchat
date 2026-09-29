/**
 * Отказ каталога кэша выдавался за «расшифрованных копий нет» (v4.32.1024).
 *
 * ДЕФЕКТ. `cachedBlobIdsPresent` накрывала чтение каталога немым
 * `catch { return [] }`, а `cachedFileUrisPresent` так же гасила отказ
 * `getInfoAsync` по каждому файлу. Пустой ответ у обеих значит ровно одно:
 * «таких файлов на диске нет».
 *
 * ЦЕНА. Обе зовутся из `dropOrphanBlobCache` дважды и в обоих местах решают
 * исход. Первый раз — дешёвой проверкой перед полным обходом: пустой ответ
 * уводит в ранний `return 'clean'`, и уборка не начинается вовсе. Второй раз —
 * контрольным проходом, который в v4.32.1001 завели именно для того, чтобы
 * брать исход с диска, а не из намерения: `deleteCachedBlobs` пропускает
 * неудалившийся файл и отдаёт счётчик, по счётчику недостачи не видно. То есть
 * свидетеля кормил тот самый источник, который и отказал. Дальше `clean`
 * доезжает до `reportErased`, и человек читает «Переписка удалена» без оговорки
 * — при том что расшифрованные снимки и голосовые лежат в кэше открытым
 * текстом, видимые файловому менеджеру и резервной копии устройства. Отказ
 * каталога приходит не на пустом месте: стирают переписку чаще всего когда на
 * устройстве кончается место, а кэш приложения на iOS система вправе вычищать
 * под собой.
 *
 * ПРАВКА. Обе проверки отказ не ловят. Внешний `catch` у `dropOrphanBlobCache`
 * уже на месте: он пишет `blob_cache_sweep_failed` и отвечает `kept` — а `kept`
 * с самого начала значит «остались: либо не с чем было сверяться, либо файл не
 * удалился» (eraseOutcome.ts). Тот же ответ дал бы и дом: `survivingAvatarFiles`
 * на непрочитанном каталоге отдаёт не пустой список, а отметку о непрочтении.
 *
 * ГРАНИЦЫ. Каталога кэша нет вовсе (`FileSystem.cacheDirectory` пуст) — файлов
 * в нём тоже нет, и пустой ответ остаётся правдой. Настоящее отсутствие файла
 * (`exists: false`) отказом не становится. Адрес с выходом за каталог
 * по-прежнему не подтверждается. Пофайловое молчание самих удалений не
 * трогаем: оно и есть причина, по которой контрольный проход нужен.
 */

/** Что лежит в кэше: полный file:// адрес → содержимое. */
const mockFiles = new Map<string, string>();
/** Отказ чтения каталога — как у занятой или снесённой системой папки. */
let mockDirFails = false;
/** Адреса, у которых `getInfoAsync` отказывает (а не отвечает «нет файла»). */
let mockInfoFails = new Set<string>();

const DIR = 'file:///cache/';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async (uri: string) => {
    if (mockInfoFails.has(uri)) throw new Error('EPERM: operation not permitted');
    const content = mockFiles.get(uri);
    return content === undefined ? { exists: false } : { exists: true, size: content.length };
  }),
  readDirectoryAsync: jest.fn(async () => {
    if (mockDirFails) throw new Error("Location 'file:///cache/' isn't readable");
    return [...mockFiles.keys()].map((u) => u.slice(DIR.length));
  }),
  deleteAsync: jest.fn(async () => undefined),
  readAsStringAsync: jest.fn(async () => ''),
  writeAsStringAsync: jest.fn(async () => undefined),
  moveAsync: jest.fn(async () => undefined),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../transport/internet/internetTransport', () => ({
  getInternetTransportSingleton: jest.fn(() => ({ getStatus: () => ({ relay: null }) })),
}));
jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({
    internet: { relayBase: 'https://ntfy.sh' },
    cloudBackup: { enabled: false },
  })),
}));
jest.mock('../../backup/seedPhrase', () => ({
  getMnemonicGeneration: jest.fn(() => 1),
  getStoredMnemonic: jest.fn(async () => null),
  deriveKeyPairFromMnemonic: jest.fn(() => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) })),
}));
jest.mock('../../sync/syncApi', () => ({
  uploadSyncMedia: jest.fn(async () => undefined),
  downloadSyncMedia: jest.fn(async () => null),
}));

import fs from 'fs';
import path from 'path';

import { BLOB_CACHE_PREFIX } from '../blobRef';
import { cachedBlobIdsPresent, cachedFileUrisPresent } from '../mediaBlob';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Пояснение в комментарии не должно засчитываться за код. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Одно тело функции, чтобы совпадение не пришло от соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const MEDIA = read('core', 'media', 'mediaBlob.ts');
const LOCAL = read('core', 'storage', 'local.ts');
const FEEDBACK = read('ui', 'components', 'userFeedback.ts');
const AVATARS = read('core', 'media', 'avatarFiles.ts');

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const VOICE = `${DIR}Audio/recording-1.m4a`;
/** Имя файла расшифрованной копии — как его пишет сам кэш. */
const BLOB_FILE = `${DIR}${BLOB_CACHE_PREFIX}${ID}.jpg`;

beforeEach(() => {
  mockFiles.clear();
  mockDirFails = false;
  mockInfoFails = new Set();
});

describe('отказ диска — это не «файлов нет»', () => {
  it('каталог не прочитался — проверка вложений не отвечает пустотой', async () => {
    mockFiles.set(BLOB_FILE, 'x');
    mockDirFails = true;

    await expect(cachedBlobIdsPresent([ID])).rejects.toThrow("isn't readable");
  });

  it('файл не опросился — проверка голосовых не отвечает пустотой', async () => {
    mockFiles.set(VOICE, 'x');
    mockInfoFails.add(VOICE);

    await expect(cachedFileUrisPresent([VOICE])).rejects.toThrow('EPERM');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Бросок — дорогой ответ: он уводит уборку в `kept`, а человека — в оговорку
 * про оставшиеся копии. Он позволен ровно там, где диск не ответил; исправный
 * диск обязан работать как работал.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: исправный диск отвечает как прежде', () => {
  it('лежащее вложение находится', async () => {
    mockFiles.set(BLOB_FILE, 'x');

    await expect(cachedBlobIdsPresent([ID])).resolves.toEqual([ID]);
  });

  it('ГРАНИЦА: настоящее отсутствие остаётся отсутствием', async () => {
    await expect(cachedBlobIdsPresent([ID])).resolves.toEqual([]);
    await expect(cachedFileUrisPresent([VOICE])).resolves.toEqual([]);
  });

  it('ГРАНИЦА: спрашивать нечего — каталог даже не читается', async () => {
    mockDirFails = true;

    await expect(cachedBlobIdsPresent([])).resolves.toEqual([]);
  });

  it('ГРАНИЦА: адрес с выходом из каталога не подтверждается', async () => {
    const outside = `${DIR}../databases/airchat.db`;
    mockFiles.set(outside, 'x');

    await expect(cachedFileUrisPresent([outside])).resolves.toEqual([]);
  });

  it('ГРАНИЦА: нет каталога кэша — нет и файлов в нём', () => {
    // Подменить `cacheDirectory` на лету нечем: модуль читает его при каждом
    // вызове, но мок задан фабрикой. Проверяется формой: ранний выход остался
    // и отказом не стал.
    for (const head of [
      'export async function cachedBlobIdsPresent(',
      'export async function cachedFileUrisPresent(',
    ]) {
      const at = MEDIA.indexOf(head);
      expect(at).toBeGreaterThan(0);
      expect(MEDIA.slice(at, at + 260)).toContain('if (!dir) return [];');
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('обе проверки решают исход уборки — и до неё, и после', () => {
    const sweep = codeOnly(slice(LOCAL, 'async function dropOrphanBlobCache(', '\n/**'));
    expect(sweep).toContain('cachedBlobIdsPresent(doomed.ids)');
    expect(sweep).toContain('cachedFileUrisPresent(doomed.uris)');
    expect(sweep).toContain("if (presentIds.length === 0 && presentUris.length === 0) return 'clean';");
    expect(sweep).toContain('cachedBlobIdsPresent(idsToDelete)');
    expect(sweep).toContain("keptIds.length === 0 && keptUris.length === 0 ? 'clean' : 'kept'");
  });

  it('внешний catch уборки уже отвечает «остались» — новой ветки не нужно', () => {
    const sweep = codeOnly(slice(LOCAL, 'async function dropOrphanBlobCache(', '\n/**'));
    expect(sweep).toContain("log.warn('blob_cache_sweep_failed'");
    expect(sweep.match(/return 'kept';/g) ?? []).toHaveLength(2);
  });

  it('человеку об остатке говорят — значит исход не украшение', () => {
    expect(codeOnly(slice(FEEDBACK, 'export function reportErased(', '\n/**')))
      .toContain("if (sweep === 'kept') {");
    expect(FEEDBACK).toContain('`${done}, но расшифрованные копии вложений остались на устройстве`');
  });

  it('удаления по-прежнему молчат — потому контрольный проход и нужен', () => {
    const del = slice(MEDIA, 'export async function deleteCachedBlobs(', 'export async function cachedBlobIdsPresent(');
    expect(del).toContain('/* skip this file */');
    expect(del).toContain('return removed;');
  });

  it('дом уже отвечает так же: непрочитанный каталог — не пустой список', () => {
    const scan = slice(AVATARS, 'export async function survivingAvatarFiles(', '\nexport async function sweepAvatarFiles(');
    expect(scan).toContain("log.warn('avatar_verify_scan_failed'");
    expect(scan).toContain("return ['<каталог не перечитан>'];");
  });
});

describe('ЗАКРЕПКА: проверки диска отказ не глотают', () => {
  it('ни одна из двух не ловит его сама', () => {
    for (const [head, tail] of [
      ['export async function cachedBlobIdsPresent(', '\n/**'],
      ['export async function cachedFileUrisPresent(', '\n// v4.32.244'],
    ] as const) {
      const body = codeOnly(slice(MEDIA, head, tail));
      expect(body).not.toContain('catch');
    }
  });
});
