/**
 * Откат списка профилей перестал молчать о своём отказе (v4.32.890).
 *
 * Дефект. Оба восстановления учётки — с устройства и из облачного архива —
 * сперва уводят рабочие файлы в отложенный каталог, потом кладут копию, и
 * последним шагом переписывают список профилей (`PROFILE_STATE_KEY`). Если
 * что-то по дороге оборвалось, блок `catch` возвращает всё на место. Возврат
 * файлов о себе говорит: не вышло — `account_vault_..._rollback_incomplete`.
 * А возврат списка профилей стоял рядом и глушился пустым `.catch(() => {})`.
 *
 * Цена. Записи в хранилище ключей подтверждения могут и не дождаться: вызов
 * бросает, а легло ли значение — снаружи неизвестно. Ровно поэтому откат и
 * написан: вернуть заведомо верное. Когда не удаётся и он, список профилей
 * остаётся в неизвестном состоянии рядом с файлами, вернувшимися к прежнему
 * виду. Человек видит в переключателе учёток профили, которых в базе нет, — и
 * не видит тех, что есть. В журнале при этом ни слова: разбирать нечего.
 *
 * Правка. Общая `restoreProfileState` возвращает `false` вместо молчания, а
 * каждый из двух путей называет себя своим событием.
 */

const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockSecure = new Map<string, string>();
/**
 * Что сделает следующая запись в хранилище ключей. `land-then-throw` — это
 * запись, которая легла, но подтверждения не вернула: именно её невозможно
 * отличить снаружи от несостоявшейся, и именно ради неё существует откат.
 */
const mockSecureSetPlan: Array<'ok' | 'throw' | 'land-then-throw'> = [];

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
  setItemAsync: jest.fn(async (key: string, value: string) => {
    const how = mockSecureSetPlan.shift() ?? 'ok';
    if (how === 'land-then-throw') {
      mockSecure.set(key, value);
      throw new Error('keychain write unconfirmed');
    }
    if (how === 'throw') throw new Error('keychain write refused');
    mockSecure.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecure.delete(key); }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import fs from 'fs';
import path from 'path';

import { log } from '../../logger';
import { PROFILE_STATE_KEY } from '../../identity/profileStateKey';
import {
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

/** Список профилей из копии — тот, что восстановление пытается положить. */
const SAVED_STATE = JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }, { id: 2, name: 'Работа' }] });
/** Список профилей этого устройства — тот, к которому откат обязан вернуть. */
const DEVICE_STATE = JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] });

/** Снять копию со списком из копии и оставить на устройстве свой список. */
async function snapshotThenOwnState(): Promise<void> {
  mockSecure.set(PROFILE_STATE_KEY, SAVED_STATE);
  expect(await snapshotAccountVault(MNEMONIC, SAVED_STATE)).toBe(true);
  mockFiles.set(LOCAL_DB, 'рабочая база этого устройства');
  mockSecure.set(PROFILE_STATE_KEY, DEVICE_STATE);
}

/** Имена событий, о которых хранилище учёток сказало во весь голос. */
const errors = (): string[] => (log.error as jest.Mock).mock.calls.map((call) => String(call[0]));

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
  mockSecureSetPlan.length = 0;
  (log.error as jest.Mock).mockClear();
  (log.warn as jest.Mock).mockClear();
  mockDirs.add('/doc/');
  mockDirs.add('/doc/SQLite/');
  mockFiles.set(LOCAL_DB, 'local ciphertext');
  mockFiles.set(FEED_DB, 'feed ciphertext');
  mockFiles.set(AVATAR, 'avatar bytes');
});

describe('возврат с устройства: откат списка профилей не удался', () => {
  it('об этом сказано своим событием, а не пустым `.catch`', async () => {
    await snapshotThenOwnState();
    // Первая запись легла, но подтверждения не вернула; откат отбит совсем.
    mockSecureSetPlan.push('land-then-throw', 'throw');

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    expect(errors()).toContain('account_vault_restore_rollback_profile_state_stuck');
  });

  it('причина отказа записана — по журналу видно, на чём споткнулись', async () => {
    await snapshotThenOwnState();
    mockSecureSetPlan.push('land-then-throw', 'throw');

    await restoreAccountVault(MNEMONIC);
    const said = (log.error as jest.Mock).mock.calls
      .find((call) => call[0] === 'account_vault_profile_state_restore_failed');
    expect(said).toBeDefined();
    expect(String(said?.[1]?.err)).toContain('keychain write refused');
  });

  it('список профилей и вправду разъехался с файлами — вот цена молчания', async () => {
    await snapshotThenOwnState();
    mockSecureSetPlan.push('land-then-throw', 'throw');

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    // Файлы вернулись к своим.
    expect(mockFiles.get(LOCAL_DB)).toBe('рабочая база этого устройства');
    // А список профилей остался от прерванного восстановления.
    expect(mockSecure.get(PROFILE_STATE_KEY)).toBe(SAVED_STATE);
  });

  it('удавшийся откат помалкивает — событие не сыплется просто так', async () => {
    await snapshotThenOwnState();
    mockSecureSetPlan.push('land-then-throw');

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    expect(errors()).not.toContain('account_vault_restore_rollback_profile_state_stuck');
    expect(errors()).not.toContain('account_vault_profile_state_restore_failed');
    expect(mockSecure.get(PROFILE_STATE_KEY)).toBe(DEVICE_STATE);
  });
});

describe('возврат облачной копии: тот же шаг, то же молчание', () => {
  it('об отказе отката сказано своим событием', async () => {
    await snapshotThenOwnState();
    const archive = (await readAccountVaultArchive(MNEMONIC)) as AccountVaultArchive;
    mockSecureSetPlan.push('land-then-throw', 'throw');

    expect(await restoreAccountVaultArchive(MNEMONIC, archive)).toBe(false);
    expect(errors()).toContain('account_vault_archive_rollback_profile_state_stuck');
    // И событие именно этого пути, а не соседнего.
    expect(errors()).not.toContain('account_vault_restore_rollback_profile_state_stuck');
  });

  it('удавшийся откат возвращает список устройства и молчит', async () => {
    await snapshotThenOwnState();
    const archive = (await readAccountVaultArchive(MNEMONIC)) as AccountVaultArchive;
    mockSecureSetPlan.push('land-then-throw');

    expect(await restoreAccountVaultArchive(MNEMONIC, archive)).toBe(false);
    expect(errors()).not.toContain('account_vault_archive_rollback_profile_state_stuck');
    expect(mockSecure.get(PROFILE_STATE_KEY)).toBe(DEVICE_STATE);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: восстановление осталось восстановлением', () => {
  it('без помех копия возвращается целиком и список профилей — из копии', async () => {
    await snapshotThenOwnState();

    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get(LOCAL_DB)).toBe('local ciphertext');
    expect(mockFiles.get(FEED_DB)).toBe('feed ciphertext');
    expect(mockSecure.get(PROFILE_STATE_KEY)).toBe(SAVED_STATE);
    expect(errors()).toEqual([]);
  });

  it('без помех облачный архив ложится так же', async () => {
    await snapshotThenOwnState();
    const archive = (await readAccountVaultArchive(MNEMONIC)) as AccountVaultArchive;

    expect(await restoreAccountVaultArchive(MNEMONIC, archive)).toBe(true);
    expect(mockFiles.get(LOCAL_DB)).toBe('local ciphertext');
    expect(mockSecure.get(PROFILE_STATE_KEY)).toBe(SAVED_STATE);
  });

  it('оборвавшееся восстановление по-прежнему отвечает `false` и говорит об этом', async () => {
    await snapshotThenOwnState();
    mockSecureSetPlan.push('throw');

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    const warned = (log.warn as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(warned).toContain('account_vault_restore_failed');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('файлы всё так же уводятся в сторону и возвращаются откатом', async () => {
    await snapshotThenOwnState();
    mockSecureSetPlan.push('throw');

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    // Ради этого откат и написан: своё на месте, отложенного каталога нет.
    expect(mockFiles.get(LOCAL_DB)).toBe('рабочая база этого устройства');
    expect(mockFiles.get(AVATAR)).toBe('avatar bytes');
    expect([...mockDirs].some((key) => key.includes('.restore-stash-'))).toBe(false);
  });

  it('соседний откат файлов как умел говорить о себе, так и умеет', () => {
    const vault = codeOnly(read('core', 'storage', 'accountVault.ts'));
    expect(vault).toContain("log.error('account_vault_restore_rollback_incomplete', { accountId, stashDir: stash.dir });");
    expect(vault).toContain("log.error('account_vault_archive_rollback_incomplete', { accountId, stashDir: stash.dir });");
  });

  it('пустого `.catch` вокруг списка профилей в откатах не осталось', () => {
    const vault = codeOnly(read('core', 'storage', 'accountVault.ts'));
    expect(vault).not.toContain('await SecureStore.setItemAsync(PROFILE_STATE_KEY, previousProfileState).catch(() => {});');
    expect(vault).not.toContain('await SecureStore.deleteItemAsync(PROFILE_STATE_KEY).catch(() => {});');
    // Возврат по-прежнему делается — просто через проверяемую общую обёртку.
    expect(vault.split('await restoreProfileState(previousProfileState)').length - 1).toBe(2);
  });
});
