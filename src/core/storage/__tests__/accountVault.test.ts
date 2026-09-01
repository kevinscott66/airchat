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
import { restoreAccountVault, snapshotAccountVault } from '../accountVault';

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
