/**
 * v4.32.722: фото, выставленное «для всех», видят и те, кому его не присылали.
 *
 * Держит: при «все» снимок уходит на сервер подписанным, при «контакты» и
 * «никто» — снимается; одно и то же второй раз не шлётся; непрочитанная
 * настройка ничего не трогает. Показывающая сторона спрашивает сервер пачкой,
 * находит человека и по ключу, и по did, отдаёт один и тот же объект, а фото
 * из конверта контакта оставляет главнее серверного.
 */
import { createHash } from 'node:crypto';
import { didFromPubB64 } from '../../identity/did';

const mockMyPub = new Uint8Array(32).fill(3);
const PEER_PUB = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const PEER_URL = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');
// v4.32.940: свёртка теперь сверяется с байтами, а не просто едет в адресе.
const PEER_IMG = Buffer.from([0xff, 0xd8, 0xff, 7, 7, 7]);
const HASH = createHash('sha256').update(PEER_IMG).digest('hex').slice(0, 32);
const PEER_FILE = `file:///cache/pubavatar-${PEER_URL}-${HASH}.img`;

let mockVisibility: 'everybody' | 'contacts' | 'nobody' | null = 'everybody';
let mockImg: string | null = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64');
let mockContacts: { peerPublicKey: string; avatarCid?: string }[] = [];
const mockFetch = jest.fn();

jest.mock('../../backup/cloudVault', () => ({ cloudBaseUrl: () => 'https://vault.test' }));
jest.mock('../../settings/avatarVisibility', () => ({ avatarVisibilityTryFor: jest.fn(async () => mockVisibility) }));
jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: jest.fn(async () => mockImg) }));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarUriFor: jest.fn(async () => (mockImg ? 'file:///me.jpg' : null)),
  ownAvatarUri: jest.fn(async () => null),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1 }),
    getActiveKeyPair: () => ({ publicKey: mockMyPub, secretKey: new Uint8Array(64) }),
  },
}));
// v4.32.940: подпись здесь подделана намеренно — эти проверки про справку
// пачкой и про старшинство фото из конверта. Настоящая проверка подписи живёт
// в publicAvatarProof940.test.ts, и подменить её заглушкой там нечем.
jest.mock('../../crypto/signature', () => ({
  signJson: jest.fn(async (_pair: unknown, obj: Record<string, unknown>) => ({ payload: JSON.stringify(obj), signature: 'sig' })),
  verifySignedJson: jest.fn(async () => ({
    v: 1,
    act: 'put',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    imageB64: Buffer.from([0xff, 0xd8, 0xff, 7, 7, 7]).toString('base64'),
  })),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///docs/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  writeAsStringAsync: jest.fn(async () => undefined),
}));
jest.mock('../../net/timedFetch', () => ({
  fetchWithDeadline: jest.fn(async (url: string, init: { body?: string }, _o: unknown, read: (r: unknown) => unknown) => {
    if (typeof url === 'string' && url.endsWith('/signed')) {
      return read({ ok: true, status: 200, json: async () => ({ payload: '{}', signature: 'sig' }) });
    }
    return read(await mockFetch(url, init.body ? JSON.parse(init.body) : null));
  }),
}));
jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => mockContacts),
  subscribeContactsChanged: jest.fn(() => () => {}),
}));
jest.mock('../../crypto/keyManager', () => ({
  loadKeyPair: jest.fn(async () => ({ publicKey: mockMyPub, secretKey: new Uint8Array(64) })),
}));

import { publishOwnAvatarToDirectory, resetPublicAvatars } from '../publicAvatar';
import { avatarSourceFor, refreshAvatarTable, stopAvatarRegistry, subscribeAvatarsChanged } from '../avatarRegistry';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const flush = () => new Promise((r) => setTimeout(r, 100));

beforeEach(() => {
  mockVisibility = 'everybody';
  mockImg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64');
  mockContacts = [];
  mockFetch.mockReset();
  resetPublicAvatars();
  stopAvatarRegistry();
});

test('«все» — снимок уходит на сервер один раз; «контакты» — снимается', async () => {
  mockFetch.mockResolvedValue(ok({ ok: true }));
  await publishOwnAvatarToDirectory(1);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, body] = mockFetch.mock.calls[0];
  expect(url).toBe('https://vault.test/v1/avatar');
  const payload = JSON.parse(body.payload);
  expect(payload).toMatchObject({ v: 1, act: 'put', imageB64: mockImg, publicKeyB64: Buffer.from(mockMyPub).toString('base64') });
  expect(typeof payload.nonce).toBe('string');

  await publishOwnAvatarToDirectory(1);
  expect(mockFetch).toHaveBeenCalledTimes(1);

  mockVisibility = 'contacts';
  await publishOwnAvatarToDirectory(1);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mockFetch.mock.calls[1][1].payload)).toMatchObject({ act: 'del' });
  expect(JSON.parse(mockFetch.mock.calls[1][1].payload).imageB64).toBeUndefined();
});

test('непрочитанная настройка ничего не трогает; сбой сервера — повтор в следующий раз', async () => {
  mockVisibility = null;
  await publishOwnAvatarToDirectory(1);
  expect(mockFetch).not.toHaveBeenCalled();

  mockVisibility = 'everybody';
  mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
  await publishOwnAvatarToDirectory(1);
  mockFetch.mockResolvedValueOnce(ok({ ok: true }));
  await publishOwnAvatarToDirectory(1);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

test('фото незнакомца находится по ключу и по did, объект один и тот же', async () => {
  mockFetch.mockResolvedValue(ok({ found: { [PEER_URL]: HASH } }));
  await refreshAvatarTable();
  const woke = jest.fn();
  const unsub = subscribeAvatarsChanged(woke);
  expect(avatarSourceFor(PEER_PUB)).toBeNull();
  expect(avatarSourceFor(didFromPubB64(PEER_PUB))).toBeNull();
  await flush();
  // Ключ и did — один человек: один запрос, одна пачка.
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][0]).toBe('https://vault.test/v1/avatars/lookup');
  expect(mockFetch.mock.calls[0][1]).toEqual({ keys: [PEER_URL] });
  expect(woke).toHaveBeenCalled();
  const src = avatarSourceFor(PEER_PUB);
  // v4.32.940: показывается проверенный файл на устройстве, а не адрес сервера.
  expect(src).toEqual({ cid: null, uri: PEER_FILE });
  expect(avatarSourceFor(PEER_PUB)).toBe(src);
  expect(avatarSourceFor(didFromPubB64(PEER_PUB))).toBe(src);
  // Ответ запомнен: повторная отрисовка сервер не дёргает.
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  unsub();
});

test('фото из конверта контакта главнее серверного', async () => {
  mockContacts = [{ peerPublicKey: PEER_PUB, avatarCid: 'nb:peer' }];
  await refreshAvatarTable();
  expect(avatarSourceFor(PEER_PUB)).toEqual({ cid: 'nb:peer', uri: null });
  await flush();
  expect(mockFetch).not.toHaveBeenCalled();
});

test('сбой справки не записывается как «фото нет»', async () => {
  mockFetch.mockRejectedValueOnce(new Error('offline'));
  avatarSourceFor(PEER_PUB);
  await flush();
  mockFetch.mockResolvedValueOnce(ok({ found: { [PEER_URL]: HASH } }));
  avatarSourceFor(PEER_PUB);
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(avatarSourceFor(PEER_PUB)?.uri).toContain(PEER_URL);
});
