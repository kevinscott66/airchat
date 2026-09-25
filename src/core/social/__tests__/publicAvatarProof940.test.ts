/**
 * Дефект: фото профиля с сервера принималось на слово (v4.32.940).
 *
 * Владелец подписывал снимок при выкладке, сервер подпись проверял — и
 * выбрасывал. Смотрящему доставался адрес `/v1/avatar/<ключ>/img`, который
 * уходил прямо в `<Image>`: доказательства у показывающей стороны не было
 * никакого, а «ключ» в адресе — это то, что мы спросили, а не то, что сервер
 * ответил.
 *
 * Цена: кто дотянулся до базы хранилища — своя ли она, чужая ли, — менял
 * человеку лицо, и заметить подмену было нечем. Фото в мессенджере опознаёт
 * собеседника не хуже имени.
 *
 * Правка: сервер отдаёт подписанную владельцем строку целиком, а устройство
 * проверяет её тем самым ключом, по которому фото и спрашивало. Показывается
 * только проверенный файл, лежащий на устройстве; не сошлось — фото нет.
 *
 * Границы: подпись здесь настоящая (никаких заглушек `crypto/signature`), а
 * вот сеть и файлы — поддельные. Это про порядок проверок, а не про expo.
 */
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

const mockFiles = new Map<string, string>();
let mockLookupBody: unknown = null;
let mockSignedBody: unknown = null;
let mockSignedOk = true;

jest.mock('../../backup/cloudVault', () => ({ cloudBaseUrl: () => 'https://vault.test' }));
jest.mock('../../settings/avatarVisibility', () => ({ avatarVisibilityTryFor: jest.fn(async () => null) }));
jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: jest.fn(async () => null) }));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarUriFor: jest.fn(async () => null),
  ownAvatarUri: jest.fn(async () => null),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }), getActiveKeyPair: () => null },
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: null,
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async (path: string) => ({ exists: mockFiles.has(path) })),
  writeAsStringAsync: jest.fn(async (path: string, data: string) => { mockFiles.set(path, data); }),
}));
jest.mock('../../net/timedFetch', () => ({
  fetchWithDeadline: jest.fn(async (url: string, _init: unknown, _opts: unknown, read: (r: unknown) => unknown) => {
    if (String(url).endsWith('/signed')) {
      return read({ ok: mockSignedOk, status: mockSignedOk ? 200 : 404, json: async () => mockSignedBody });
    }
    return read({ ok: true, status: 200, json: async () => mockLookupBody });
  }),
}));

import { signJson } from '../../crypto/signature';
import { publicAvatarUri, requestPublicAvatar, resetPublicAvatars } from '../publicAvatar';

function keyPair(seedByte: number) {
  const secretKey = new Uint8Array(32).fill(seedByte);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

const OWNER = keyPair(11);
const STRANGER = keyPair(22);
const PUB_B64 = Buffer.from(OWNER.publicKey).toString('base64');
const URL_KEY = Buffer.from(OWNER.publicKey).toString('base64url');
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const IMAGE_B64 = IMAGE.toString('base64');
const VERSION = createHash('sha256').update(IMAGE).digest('hex').slice(0, 32);
const FILE = `file:///cache/pubavatar-${URL_KEY}-${VERSION}.img`;

/** Подписать справку о фото так, как её подписывает владелец при выкладке. */
async function proof(over: Record<string, unknown> = {}, pair = OWNER) {
  return signJson(pair, {
    v: 1,
    ts: Date.now(),
    nonce: 'n'.repeat(22),
    publicKeyB64: PUB_B64,
    act: 'put',
    imageB64: IMAGE_B64,
    ...over,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 120));

/** Спросить фото и дождаться, пока справка и проверка отработают. */
async function ask(): Promise<string | null> {
  requestPublicAvatar(PUB_B64);
  await settle();
  return publicAvatarUri(PUB_B64);
}

beforeEach(async () => {
  resetPublicAvatars();
  mockFiles.clear();
  mockSignedOk = true;
  mockLookupBody = { found: { [URL_KEY]: VERSION } };
  mockSignedBody = await proof();
});

describe('фото профиля с сервера', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: у честного фото путь до экрана есть', async () => {
    expect(await ask()).toBeTruthy();
  });

  it('показывается проверенный файл, а не адрес сервера', async () => {
    const uri = await ask();
    // По адресу сервер волен отдать в следующий раз что угодно, и проверять
    // там уже нечего: показывается то, под чем нашлась подпись владельца.
    expect(uri).toBe(FILE);
    expect(uri).not.toContain('vault.test');
    expect(mockFiles.get(FILE)).toBe(IMAGE_B64);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: без справки сервера фото не берётся ниоткуда', async () => {
    mockLookupBody = { found: {} };
    expect(await ask()).toBeNull();
  });

  it('подменённые байты не показываются', async () => {
    // Подпись прежняя, снимок другой — ровно то, что делает влезший в базу.
    const honest = await proof();
    const tampered = JSON.parse(honest.payload) as Record<string, unknown>;
    tampered.imageB64 = Buffer.from([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9]).toString('base64');
    mockSignedBody = { payload: JSON.stringify(tampered), signature: honest.signature };
    expect(await ask()).toBeNull();
  });

  it('подпись чужим ключом не показывается', async () => {
    mockSignedBody = await proof({}, STRANGER);
    expect(await ask()).toBeNull();
  });

  it('снятие фото не выдаётся за фото', async () => {
    mockSignedBody = await proof({ act: 'del' });
    expect(await ask()).toBeNull();
  });

  it('справка про чужой ключ не показывается', async () => {
    mockSignedBody = await proof({ publicKeyB64: Buffer.from(STRANGER.publicKey).toString('base64') });
    expect(await ask()).toBeNull();
  });

  it('свёртка из справки сверяется с байтами', async () => {
    mockLookupBody = { found: { [URL_KEY]: 'b'.repeat(32) } };
    expect(await ask()).toBeNull();
  });

  it('сервер без доказательства ничего не показывает', async () => {
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };
    expect(await ask()).toBeNull();
    mockSignedOk = true;
    mockSignedBody = { payload: 'не строка подписи', signature: 12 };
    resetPublicAvatars();
    expect(await ask()).toBeNull();
  });

  it('проверенное фото не перекачивается, пока версия та же', async () => {
    expect(await ask()).toBe(FILE);
    mockSignedBody = { error: 'сюда ходить больше незачем' };
    resetPublicAvatars();
    mockFiles.set(FILE, IMAGE_B64);
    expect(await ask()).toBe(FILE);
  });
});
