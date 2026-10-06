import { createHash } from 'node:crypto';

const mockLookup = jest.fn();
const mockSigned = jest.fn();
const mockWrite = jest.fn(async () => undefined);
const mockSign = jest.fn(async (_pair: unknown, value: unknown) => value);
const mockVisibility = jest.fn(async () => 'everybody');
const mockAvatarWrite = jest.fn();
const mockPub = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const URL_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');
const mockImage = Buffer.from([255, 216, 255, 7]);
const VERSION = createHash('sha256').update(mockImage).digest('hex').slice(0, 32);

jest.mock('../../backup/cloudVault', () => ({ cloudBaseUrl: () => 'https://vault.test' }));
jest.mock('../../settings/avatarVisibility', () => ({ avatarVisibilityTryFor: () => mockVisibility() }));
jest.mock('../../identity/ownAvatar', () => ({ ownAvatarBytesTryFor: async () => ({ b64: mockImage.toString('base64') }) }));
jest.mock('../../identity/profileManager', () => ({ profileManager: {
  getActiveProfile: () => ({ id: 1 }),
  getActiveKeyPair: () => ({ publicKey: new Uint8Array(32).fill(7), secretKey: new Uint8Array(32) }),
} }));
jest.mock('../../crypto/signature', () => ({
  signJson: (...args: unknown[]) => mockSign(...args as [unknown, unknown]),
  verifySignedJson: async () => ({ act: 'put', publicKeyB64: mockPub, imageB64: mockImage.toString('base64') }),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
  getInfoAsync: async () => ({ exists: false }), writeAsStringAsync: () => mockWrite(),
}));
jest.mock('../../net/timedFetch', () => ({
  fetchWithDeadline: async (url: string, _init: unknown, _opts: unknown, read: (r: unknown) => unknown) => {
    const body = url.endsWith('/lookup') ? await mockLookup() : url.endsWith('/signed') ? await mockSigned() : await mockAvatarWrite();
    return read({ ok: true, json: async () => body });
  },
}));

import { publicAvatarUri, requestPublicAvatar, resetPublicAvatars, publishOwnAvatarToDirectory } from '../publicAvatar';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const found = () => ({ found: { [URL_KEY]: VERSION } });
const settle = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const ask = async () => { requestPublicAvatar(mockPub); await jest.advanceTimersByTimeAsync(60); };

beforeEach(() => {
  jest.useFakeTimers();
  resetPublicAvatars();
  jest.clearAllMocks();
  mockLookup.mockResolvedValue(found());
  mockSigned.mockResolvedValue({ payload: '{}', signature: 'sig' });
});
afterEach(() => { resetPublicAvatars(); jest.useRealTimers(); });

test('reset allows a new lookup for the same key while an old lookup is pending', async () => {
  const old = deferred<unknown>();
  mockLookup.mockReturnValueOnce(old.promise);
  await ask();
  resetPublicAvatars();
  await ask();
  expect(mockLookup).toHaveBeenCalledTimes(2);
  expect(publicAvatarUri(mockPub)).toBeTruthy();
  old.resolve({ found: {} });
  await settle();
  expect(publicAvatarUri(mockPub)).toBeTruthy();
});

test('lookup finishing after reset neither starts download nor restores cache', async () => {
  const old = deferred<unknown>();
  mockLookup.mockReturnValueOnce(old.promise);
  await ask();
  resetPublicAvatars();
  old.resolve(found());
  await settle();
  expect(mockSigned).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
  expect(publicAvatarUri(mockPub)).toBeNull();
});

test('signed response finishing after reset does not save files', async () => {
  const old = deferred<unknown>();
  mockSigned.mockReturnValueOnce(old.promise);
  await ask();
  expect(mockSigned).toHaveBeenCalledTimes(1);
  resetPublicAvatars();
  old.resolve({ payload: '{}', signature: 'sig' });
  await settle();
  expect(mockWrite).not.toHaveBeenCalled();
  expect(publicAvatarUri(mockPub)).toBeNull();
});

test('reset while signing an avatar prevents a stale publication', async () => {
  const old = deferred<unknown>();
  mockSign.mockReturnValueOnce(old.promise);
  const publishing = publishOwnAvatarToDirectory(1);
  await settle();
  expect(mockSign).toHaveBeenCalledTimes(1);
  resetPublicAvatars();
  old.resolve({ payload: '{}', signature: 'sig' });
  await publishing;
  expect(mockAvatarWrite).not.toHaveBeenCalled();
});
