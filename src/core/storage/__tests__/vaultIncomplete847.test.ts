/**
 * Копия без базы перестала выдавать себя за целую (v4.32.847).
 *
 * Дефект. Три места вдоль одной дороги пропускали недостающий файл молча:
 *
 *   1. Сборка архива (`readAccountVaultArchive`) на файл, названный в
 *      манифесте, но пропавший с диска, отвечала `continue`. Архив уезжал
 *      короче манифеста, сервер отвечал «принято», человеку говорили
 *      «Зашифрованная копия отправлена в облако».
 *   2. Сверка в облаке (`validateArchiveFileList`) проверяла только одно
 *      направление — нет ли в архиве лишнего. «Всё ли обещанное на месте» не
 *      спрашивалось вовсе, и щербатый архив числился исправным.
 *   3. Возврат (`restoreAccountVault`, `restoreAccountVaultArchive`) сначала
 *      уводил рабочие файлы в отложенный каталог, потом клал то, что приехало,
 *      а на успехе отложенное удалял.
 *
 * Цена. Третий пункт превращает первые два в потерю. Возврат копии, потерявшей
 * базу переписки, стирал рабочую базу и не клал на её место ничего — и отвечал
 * `true`, то есть «восстановлено». Человек в этот момент как раз и рассчитывал
 * на копию: он вернулся к ней потому, что своё уже потерял.
 *
 * Правка. Недостающая база — отказ, и отказ наступает до того, как тронуты
 * рабочие файлы. Недостающая картинка возврат не отменяет, но и не забывается:
 * манифест архива правится так, чтобы обещать ровно то, что внутри.
 */

const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockSecure = new Map<string, string>();

function mockChildren(uri: string): string[] {
  const prefix = uri.endsWith('/') ? uri : `${uri}/`;
  const names = new Set<string>();
  for (const path of [...mockFiles.keys(), ...mockDirs]) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (rest && slash < 0) names.add(rest);
  }
  return [...names];
}

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: mockFiles.has(uri) || mockDirs.has(uri) })),
  makeDirectoryAsync: jest.fn(async (uri: string) => { mockDirs.add(uri); }),
  readDirectoryAsync: jest.fn(async (uri: string) => mockChildren(uri)),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = mockFiles.get(from);
    if (value === undefined) throw new Error(`missing ${from}`);
    mockFiles.set(to, value);
  }),
  writeAsStringAsync: jest.fn(async (uri: string, value: string) => { mockFiles.set(uri, value); }),
  readAsStringAsync: jest.fn(async (uri: string) => mockFiles.get(uri) ?? ''),
  deleteAsync: jest.fn(async (uri: string) => {
    const prefix = uri.endsWith('/') ? uri : `${uri}/`;
    const hit = (key: string) => key === uri || key.startsWith(prefix);
    for (const key of [...mockFiles.keys()]) if (hit(key)) mockFiles.delete(key);
    for (const key of [...mockDirs]) if (hit(key)) mockDirs.delete(key);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    for (const key of [...mockFiles.keys()]) {
      if (key.startsWith(from)) {
        mockFiles.set(`${to}${key.slice(from.length)}`, mockFiles.get(key)!);
        mockFiles.delete(key);
      }
    }
  }),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecure.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecure.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecure.delete(key); }),
}));

import fs from 'fs';
import path from 'path';

import { PROFILE_STATE_KEY } from '../../identity/profileStateKey';
import {
  accountVaultIdFromMnemonic,
  missingArchiveDbFiles,
  readAccountVaultArchive,
  restoreAccountVault,
  restoreAccountVaultArchive,
  snapshotAccountVault,
  type AccountVaultArchive,
} from '../accountVault';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const LOCAL_DB = '/doc/SQLite/airchat_local.db';
const FEED_DB = '/doc/SQLite/airchat_feed_p1.db';
const AVATAR = '/doc/avatar_123.jpg';

const vaultDir = (): string => `/doc/airchat_account_vault_v1/${accountVaultIdFromMnemonic(MNEMONIC)}/`;

/** Снять целый снимок и вернуть устройство в состояние «своё потеряно». */
async function snapshotThenWipeDevice(): Promise<void> {
  mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] }));
  expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);
  mockFiles.set(LOCAL_DB, 'рабочая база этого устройства');
}

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockSecure.clear();
  mockDirs.add('/doc/');
  mockDirs.add('/doc/SQLite/');
  mockFiles.set(LOCAL_DB, 'local ciphertext');
  mockFiles.set(FEED_DB, 'feed ciphertext');
  mockFiles.set(AVATAR, 'avatar bytes');
});

describe('снимок на устройстве потерял файл', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: целый снимок возвращается, как и прежде', async () => {
    await snapshotThenWipeDevice();

    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get(LOCAL_DB)).toBe('local ciphertext');
    expect(mockFiles.get(FEED_DB)).toBe('feed ciphertext');
    expect(mockFiles.get(AVATAR)).toBe('avatar bytes');
  });

  it('нет базы — отказ, и рабочая база остаётся на месте', async () => {
    await snapshotThenWipeDevice();
    mockFiles.delete(`${vaultDir()}SQLite/airchat_feed_p1.db`);

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    // Вот ради чего правка: прежде отказа не было вовсе — был `true`, а на
    // месте рабочей базы оставалась пустота.
    expect(mockFiles.get(LOCAL_DB)).toBe('рабочая база этого устройства');
    expect(mockFiles.get(AVATAR)).toBe('avatar bytes');
  });

  it('отказ наступает до того, как рабочие файлы уведены в сторону', async () => {
    await snapshotThenWipeDevice();
    mockFiles.delete(`${vaultDir()}SQLite/airchat_local.db`);

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    // Ни отложенного каталога, ни следов переезда: файлы не трогали вовсе.
    expect([...mockFiles.keys()].some((key) => key.includes('.restore-stash-'))).toBe(false);
    expect([...mockDirs].some((key) => key.includes('.restore-stash-'))).toBe(false);
  });

  it('нет картинки — переписку возвращают всё равно', async () => {
    await snapshotThenWipeDevice();
    mockFiles.delete(`${vaultDir()}avatars/avatar_123.jpg`);
    mockFiles.delete(AVATAR);

    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get(LOCAL_DB)).toBe('local ciphertext');
    expect(mockFiles.has(AVATAR)).toBe(false);
  });
});

describe('архив для облака', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: целый снимок отдаётся целиком', async () => {
    await snapshotThenWipeDevice();

    const archive = await readAccountVaultArchive(MNEMONIC);
    expect(archive?.files.map((f) => f.name).sort()).toEqual([
      'airchat_feed_p1.db',
      'airchat_local.db',
      'avatar_123.jpg',
    ]);
    expect(missingArchiveDbFiles(archive as AccountVaultArchive)).toEqual([]);
  });

  it('нет базы — архив не собирается вовсе, в облако уезжать нечему', async () => {
    await snapshotThenWipeDevice();
    mockFiles.delete(`${vaultDir()}SQLite/airchat_local.db`);

    expect(await readAccountVaultArchive(MNEMONIC)).toBeNull();
  });

  it('нет картинки — архив собирается, но манифест обещает ровно то, что внутри', async () => {
    await snapshotThenWipeDevice();
    mockFiles.delete(`${vaultDir()}avatars/avatar_123.jpg`);

    const archive = await readAccountVaultArchive(MNEMONIC);
    expect(archive).not.toBeNull();
    expect(archive?.files.map((f) => f.name).sort()).toEqual([
      'airchat_feed_p1.db',
      'airchat_local.db',
    ]);
    // Иначе возврат этой копии сочтёт её неполной и откажет по-настоящему.
    expect(archive?.manifest.avatarFiles).toEqual([]);
    expect(missingArchiveDbFiles(archive as AccountVaultArchive)).toEqual([]);
  });
});

describe('возврат облачной копии', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: целый архив ложится на устройство', async () => {
    await snapshotThenWipeDevice();
    const archive = await readAccountVaultArchive(MNEMONIC);

    expect(await restoreAccountVaultArchive(MNEMONIC, archive as AccountVaultArchive)).toBe(true);
    expect(mockFiles.get(LOCAL_DB)).toBe('local ciphertext');
    expect(mockFiles.get(FEED_DB)).toBe('feed ciphertext');
  });

  it('архив растерял базу по дороге — отказ, и рабочая база цела', async () => {
    await snapshotThenWipeDevice();
    const whole = (await readAccountVaultArchive(MNEMONIC)) as AccountVaultArchive;
    const maimed: AccountVaultArchive = {
      ...whole,
      files: whole.files.filter((file) => file.name !== 'airchat_feed_p1.db'),
    };

    expect(missingArchiveDbFiles(maimed)).toEqual(['airchat_feed_p1.db']);
    expect(await restoreAccountVaultArchive(MNEMONIC, maimed)).toBe(false);
    expect(mockFiles.get(LOCAL_DB)).toBe('рабочая база этого устройства');
    expect(mockFiles.get(FEED_DB)).toBe('feed ciphertext');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('прежняя сверка щербатый архив пропускала: она смотрела не в ту сторону', async () => {
    await snapshotThenWipeDevice();
    const whole = (await readAccountVaultArchive(MNEMONIC)) as AccountVaultArchive;
    const maimed: AccountVaultArchive = {
      ...whole,
      files: whole.files.filter((file) => file.name !== 'airchat_local.db'),
    };

    // Ровно то, что проверяла `validateArchiveFileList`: нет ли в архиве
    // лишнего. Для копии без базы переписки ответ — «нет, всё в порядке».
    const promised = new Set([...maimed.manifest.dbFiles, ...maimed.manifest.avatarFiles]);
    expect(maimed.files.every((file) => promised.has(file.name))).toBe(true);
    // А недостающее видно только встречной проверкой, которой не было.
    expect(missingArchiveDbFiles(maimed)).toEqual(['airchat_local.db']);
  });

  it('прежний пропуск был одной строкой и следа не оставлял', () => {
    // Так выглядели все три места: файла нет — идём дальше, наружу ни слова.
    const carried: string[] = [];
    const oldSkip = (names: string[], present: Set<string>): void => {
      for (const name of names) {
        if (!present.has(name)) continue;
        carried.push(name);
      }
    };
    oldSkip(['airchat_local.db', 'avatar_123.jpg'], new Set(['avatar_123.jpg']));
    expect(carried).toEqual(['avatar_123.jpg']);
    // Ни счёта, ни отказа: снаружи это неотличимо от копии, где базы и не было.
  });
});

describe('форма исходников', () => {
  const VAULT = codeOnly(read('core', 'storage', 'accountVault.ts'));
  const CLOUD = codeOnly(read('core', 'backup', 'cloudVault.ts'));

  it('снимок проверяется до того, как рабочие файлы уведены', () => {
    const atCheck = VAULT.indexOf("log.error('account_vault_restore_incomplete'");
    const atStash = VAULT.indexOf('.restore-stash-');
    expect(atCheck).toBeGreaterThan(-1);
    expect(atStash).toBeGreaterThan(atCheck);
    // Молчаливого пропуска базы в возврате не осталось.
    expect(VAULT).not.toContain('if (await exists(`${dir}SQLite/${name}`)) await replaceFile(');
  });

  it('архив не собирается без базы и не обещает пропавшую картинку', () => {
    expect(VAULT).toContain("log.error('account_vault_archive_db_absent'");
    expect(VAULT).toContain('avatarFiles: manifest.avatarFiles.filter((name) => !lost.has(name))');
  });

  it('разбор архива отвергает щербатую копию до отложенного каталога', () => {
    const atCheck = VAULT.indexOf("log.error('account_vault_archive_incomplete'");
    const atStash = VAULT.indexOf('.archive-stash-');
    expect(atCheck).toBeGreaterThan(-1);
    expect(atStash).toBeGreaterThan(atCheck);
  });

  it('облако отказывает своими словами, а не «неверным паролем»', () => {
    expect(CLOUD).toContain('const absentDb = missingArchiveDbFiles(archive);');
    expect(CLOUD).toContain('Облачная копия неполна: в ней нет базы переписки.');
    // Про пароль говорят только там, где дело и вправду может быть в пароле.
    expect(CLOUD.match(/Неверный облачный пароль/g) ?? []).toHaveLength(1);
  });
});
