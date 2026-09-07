const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockSecure = new Map<string, string>();
const mockLockedKeys = new Set<string>();
const mockFailCopyTo = new Set<string>();
const mockFailWriteContaining = new Set<string>();

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
    if (mockFailCopyTo.has(to)) throw new Error(`copy failed ${to}`);
    const value = mockFiles.get(from);
    if (value === undefined) throw new Error(`missing ${from}`);
    mockFiles.set(to, value);
  }),
  writeAsStringAsync: jest.fn(async (uri: string, value: string) => {
    for (const needle of mockFailWriteContaining) if (uri.includes(needle)) throw new Error(`write failed ${uri}`);
    mockFiles.set(uri, value);
  }),
  readAsStringAsync: jest.fn(async (uri: string) => mockFiles.get(uri) ?? ''),
  deleteAsync: jest.fn(async (uri: string) => {
    // Настоящая файловая система удаляет ИМЕННО этот путь: `foo.db` не уносит
    // с собой `foo.db.restore-17…`. Каталог (путь с косой чертой на конце) —
    // вместе с содержимым.
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
  getItemAsync: jest.fn(async (key: string) => {
    if (mockLockedKeys.has(key)) throw new Error('User interaction is not allowed.');
    return mockSecure.get(key) ?? null;
  }),
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
  mockLockedKeys.clear();
  mockFailCopyTo.clear();
  mockFailWriteContaining.clear();
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

/**
 * v4.32.617. Отпечаток ключа — единственное, что не даёт копии лечь поверх
 * данных другого ключа. Читался он `readDekFromSecureStoreRaw`, который
 * возвращает null и когда ключа нет, и когда Keychain отказал: «User
 * interaction is not allowed» на запертом телефоне. Оба случая читались как
 * разрешение — и восстановление, которое СНАЧАЛА стирает базу, шло вслепую.
 */
describe('запертый Keychain: сверять нечем — значит нельзя', () => {
  const KEY_A = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
  const manifestUri = () =>
    `/doc/airchat_account_vault_v1/${accountVaultIdFromMnemonic(MNEMONIC)}/manifest.json`;

  const snapshotUnderKeyA = async () => {
    mockSecure.set(DEK_KEY, KEY_A);
    expect(await snapshotAccountVault(MNEMONIC, null)).toBe(true);
    mockFiles.set('/doc/SQLite/airchat_local.db', 'рабочая база этого устройства');
  };

  it('восстановление не идёт, пока ключ не прочитать', async () => {
    await snapshotUnderKeyA();
    mockLockedKeys.add(DEK_KEY);
    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('рабочая база этого устройства');
  });

  it('проверка не пустая: тот же ключ, но читаемый — восстановление идёт', async () => {
    await snapshotUnderKeyA();
    expect(await restoreAccountVault(MNEMONIC)).toBe(true);
    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
  });

  it('копия без отпечатка не создаётся: лучше её отсутствие, чем без сверки', async () => {
    mockSecure.set(DEK_KEY, KEY_A);
    mockLockedKeys.add(DEK_KEY);
    expect(await snapshotAccountVault(MNEMONIC, null)).toBe(false);
    expect(mockFiles.has(manifestUri())).toBe(false);
  });

  it('проверка не пустая: с читаемым ключом отпечаток на месте', async () => {
    mockSecure.set(DEK_KEY, KEY_A);
    expect(await snapshotAccountVault(MNEMONIC, null)).toBe(true);
    expect(JSON.parse(mockFiles.get(manifestUri()) as string).dekFp).toHaveLength(16);
  });
});

/**
 * Восстановление — самое разрушительное действие приложения (v4.32.617).
 *
 * Дефект. Рабочие файлы стирались ПЕРВЫМИ, а копия ложилась на их место
 * потом. Между этими шагами нет ничего, что вернуло бы стёртое: кончилось
 * место, отказала файловая система, приложение убили — и на устройстве не
 * остаётся ни рабочей базы, ни восстановленной. Теперь текущие файлы уходят в
 * сторону и возвращаются, если восстановление сорвалось.
 */
describe('сорвавшееся восстановление возвращает устройство как было (v4.32.617)', () => {
  async function snapshotThenDiverge(): Promise<void> {
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Из копии' }] }));
    expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);
    // С момента снятия копии устройство ушло вперёд: другие данные, другой
    // список профилей.
    mockFiles.set('/doc/SQLite/airchat_local.db', 'рабочая база');
    mockFiles.set('/doc/SQLite/airchat_feed_p1.db', 'рабочая лента');
    mockFiles.set('/doc/avatar_123.jpg', 'рабочий аватар');
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Рабочий' }] }));
  }

  it('обрыв на середине не оставляет устройство без данных', async () => {
    await snapshotThenDiverge();
    // Базы к этому моменту уже перезаписаны — падает копирование аватара.
    mockFailCopyTo.add('/doc/avatar_123.jpg');

    expect(await restoreAccountVault(MNEMONIC)).toBe(false);

    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('рабочая база');
    expect(mockFiles.get('/doc/SQLite/airchat_feed_p1.db')).toBe('рабочая лента');
    expect(mockFiles.get('/doc/avatar_123.jpg')).toBe('рабочий аватар');
    expect(JSON.parse(mockSecure.get(PROFILE_STATE_KEY) ?? '{}').profiles[0].name).toBe('Рабочий');
  });

  it('отложенное не остаётся мусором в документах', async () => {
    await snapshotThenDiverge();
    mockFailCopyTo.add('/doc/avatar_123.jpg');
    expect(await restoreAccountVault(MNEMONIC)).toBe(false);
    expect([...mockFiles.keys()].filter((key) => key.includes('.restore-stash-'))).toEqual([]);
    expect([...mockDirs].filter((key) => key.includes('.restore-stash-'))).toEqual([]);
  });

  it('разбор облачного архива обрывается — файлы устройства тоже возвращаются', async () => {
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Из копии' }] }));
    expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);
    const archive = await readAccountVaultArchive(MNEMONIC);
    expect(archive).not.toBeNull();
    mockFiles.set('/doc/SQLite/airchat_local.db', 'рабочая база');
    mockFiles.set('/doc/avatar_123.jpg', 'рабочий аватар');
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Рабочий' }] }));
    mockFailWriteContaining.add('avatar_123.jpg');

    expect(await restoreAccountVaultArchive(MNEMONIC, archive!)).toBe(false);

    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('рабочая база');
    expect(mockFiles.get('/doc/avatar_123.jpg')).toBe('рабочий аватар');
    expect(JSON.parse(mockSecure.get(PROFILE_STATE_KEY) ?? '{}').profiles[0].name).toBe('Рабочий');
    expect([...mockFiles.keys()].filter((key) => key.includes('.archive-stash-'))).toEqual([]);
  });

  it('проверка не пустая: облачный архив без обрыва раскладывается целиком', async () => {
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Из копии' }] }));
    expect(await snapshotAccountVault(MNEMONIC, mockSecure.get(PROFILE_STATE_KEY) ?? null)).toBe(true);
    const archive = await readAccountVaultArchive(MNEMONIC);
    mockFiles.set('/doc/SQLite/airchat_local.db', 'рабочая база');
    mockFiles.set('/doc/avatar_123.jpg', 'рабочий аватар');
    mockSecure.set(PROFILE_STATE_KEY, JSON.stringify({ v: 1, profiles: [{ id: 1, name: 'Рабочий' }] }));

    expect(await restoreAccountVaultArchive(MNEMONIC, archive!)).toBe(true);

    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
    expect(mockFiles.get('/doc/avatar_123.jpg')).toBe('avatar bytes');
    expect(JSON.parse(mockSecure.get(PROFILE_STATE_KEY) ?? '{}').profiles[0].name).toBe('Из копии');
  });

  it('проверка не пустая: без обрыва восстановление доводится до конца', async () => {
    await snapshotThenDiverge();

    expect(await restoreAccountVault(MNEMONIC)).toBe(true);

    expect(mockFiles.get('/doc/SQLite/airchat_local.db')).toBe('local ciphertext');
    expect(mockFiles.get('/doc/SQLite/airchat_feed_p1.db')).toBe('feed ciphertext');
    expect(mockFiles.get('/doc/avatar_123.jpg')).toBe('avatar bytes');
    expect(JSON.parse(mockSecure.get(PROFILE_STATE_KEY) ?? '{}').profiles[0].name).toBe('Из копии');
    expect([...mockFiles.keys()].filter((key) => key.includes('.restore-stash-'))).toEqual([]);
  });
});

