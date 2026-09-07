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
    for (const key of [...mockFiles.keys()]) if (key === uri || key.startsWith(uri)) mockFiles.delete(key);
    for (const key of [...mockDirs]) if (key === uri || key.startsWith(uri)) mockDirs.delete(key);
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

import { PROFILE_STATE_KEY } from '../../identity/profileStateKey';
import { DEK_KEY } from '../localEncryption';
import {
  accountVaultIdFromMnemonic,
  readAccountVaultArchive,
  restoreAccountVault,
  restoreAccountVaultArchive,
  snapshotAccountVault,
} from '../accountVault';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockSecure.clear();
  mockDirs.add('/doc/');
  mockDirs.add('/doc/SQLite/');
  mockFiles.set('/doc/SQLite/airchat_local.db', 'local ciphertext');
  mockFiles.set('/doc/SQLite/airchat_feed_p1.db', 'feed ciphertext');
  mockFiles.set('/doc/avatar_123.jpg', 'avatar bytes');
});

it('restores the profile registry, databases and avatar for the same seed', async () => {
  mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] }));
  expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);

  for (const key of [...mockFiles.keys()]) {
    if (key.startsWith('/doc/SQLite/') || key === '/doc/avatar_123.jpg') mockFiles.delete(key);
  }
  mockSecure.delete(PROFILE_STATE_KEY);

  expect(await restoreAccountVault(MNEMONIC)).toBe(true);
  expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
  expect(mockFiles.get('/doc/SQLite/airchat_feed_p1.db')).toBe('feed ciphertext');
  expect(mockFiles.get('/doc/avatar_123.jpg')).toBe('avatar bytes');
  expect(JSON.parse(mockSecure.get(PROFILE_STATE_KEY) ?? '{}').profiles[0].name).toBe('Александр');
});

it('replaces an existing empty database instead of silently keeping it', async () => {
  mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] }));
  expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);

  mockFiles.set('/doc/SQLite/airchat_local.db', 'fresh empty database');
  mockFiles.set('/doc/SQLite/airchat_feed_p99.db', 'stale other profile database');
  mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Пустой' }] }));

  expect(await restoreAccountVault(MNEMONIC)).toBe(true);
  expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
  expect(mockFiles.has('/doc/SQLite/airchat_feed_p99.db')).toBe(false);
  expect(JSON.parse(mockSecure.get(PROFILE_STATE_KEY) ?? '{}').profiles[0].name).toBe('Александр');
});

/**
 * Копия зашифрована ключом того устройства, где её сняли (v4.32.615).
 *
 * Дефект. Восстановление клало файлы поверх рабочей базы, не спросив, тем ли
 * ключом они зашифрованы, и докладывало об успехе. Открывалась база уже с
 * ключом ЭТОГО устройства: строки не расшифровывались, а первая же запись
 * ложилась поверх — вернуть переписку было уже нечем. Отдельно тем же молчанием
 * терялся список профилей: нечитаемый `profileStateB64` пропускали, и на
 * устройстве оставался список от прошлого владельца — профили 2..N из
 * восстановленной базы не показывались вовсе.
 */
describe('копия с чужим ключом', () => {
  const KEY_A = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
  const KEY_B = Buffer.from(new Uint8Array(32).fill(2)).toString('base64');
  const manifestUri = () =>
    `/doc/airchat_account_vault_v1/${accountVaultIdFromMnemonic(MNEMONIC)}/manifest.json`;
  const manifest = () => JSON.parse(mockFiles.get(manifestUri()) as string);
  const patchManifest = (patch: Record<string, unknown>) => {
    mockFiles.set(manifestUri(), JSON.stringify({ ...manifest(), ...patch }));
  };

  const snapshotUnderKeyA = async () => {
    mockSecure.set(DEK_KEY, KEY_A);
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] }));
    expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);
    mockFiles.set('/doc/SQLite/airchat_local.db', 'рабочая база этого устройства');
  };

  it('отпечаток ключа попадает в манифест', async () => {
    await snapshotUnderKeyA();
    expect(typeof manifest().dekFp).toBe('string');
    expect(manifest().dekFp).toHaveLength(16);
  });

  it('не ложится поверх рабочей базы', async () => {
    await snapshotUnderKeyA();
    mockSecure.set(DEK_KEY, KEY_B);
    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('рабочая база этого устройства');
  });

  it('со своим ключом восстанавливается', async () => {
    await snapshotUnderKeyA();
    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
  });

  it('копия старой сборки без отпечатка восстанавливается как раньше', async () => {
    await snapshotUnderKeyA();
    patchManifest({ dekFp: null });
    mockSecure.set(DEK_KEY, KEY_B);
    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
  });

  it('через облачный архив чужой ключ тоже не проходит', async () => {
    await snapshotUnderKeyA();
    const archive = await readAccountVaultArchive(MNEMONIC);
    expect(archive).not.toBeNull();
    mockSecure.set(DEK_KEY, KEY_B);
    expect(await restoreAccountVaultArchive(MNEMONIC, archive!)).toBe(false);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('рабочая база этого устройства');
  });
});

describe('испорченный список профилей', () => {
  const manifestUri = () =>
    `/doc/airchat_account_vault_v1/${accountVaultIdFromMnemonic(MNEMONIC)}/manifest.json`;

  const snapshotWithBrokenProfiles = async () => {
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Александр' }] }));
    expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);
    const broken = { ...JSON.parse(mockFiles.get(manifestUri()) as string), profileStateB64: 'bm90LWEtY2lwaGVy' };
    mockFiles.set(manifestUri(), JSON.stringify(broken));
    mockFiles.set('/doc/SQLite/airchat_local.db', 'рабочая база этого устройства');
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Прошлый' }] }));
  };

  it('не выдаётся за успешное восстановление', async () => {
    await snapshotWithBrokenProfiles();
    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
  });

  it('не затирает рабочую базу', async () => {
    await snapshotWithBrokenProfiles();
    await restoreAccountVault(MNEMONIC);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('рабочая база этого устройства');
    expect(JSON.parse(mockSecure.get(PROFILE_STATE_KEY) ?? '{}').profiles[0].name).toBe('Прошлый');
  });

  it('через облачный архив — тот же отказ', async () => {
    await snapshotWithBrokenProfiles();
    const archive = await readAccountVaultArchive(MNEMONIC);
    expect(archive).not.toBeNull();
    expect(await restoreAccountVaultArchive(MNEMONIC, archive!)).toBe(false);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('рабочая база этого устройства');
  });
});
