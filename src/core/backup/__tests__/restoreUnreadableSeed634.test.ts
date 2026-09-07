/**
 * Восстановление не стирает кошелёк, которого не прочитало (v4.32.634).
 *
 * Дефект. `getStoredMnemonic()` отвечает `null` двумя разными смыслами: «фразы
 * на устройстве нет» и «фраза есть, но не открылась». Проверка «сначала
 * выйдите из текущего кошелька» стояла под `previous &&`, поэтому на втором
 * смысле не срабатывала вовсе — и чужие слова ложились поверх нечитаемых.
 * После этого кошелёк A не вернуть ничем: его слова стёрты, а больше их на
 * устройстве нигде и не было.
 *
 * Сверить сами фразы нечем, поэтому сверяется личность: открытый ключ,
 * выводимый из введённых слов, против записанного в `keyManager`. Совпал —
 * слова те же, писать поверх безопасно (и реестр профилей сносить незачем).
 * Не совпал или не читается — отказ.
 */
const mockSecure = new Map<string, string>();
jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (k: string) => mockSecure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockSecure.set(k, v); },
  deleteItemAsync: async (k: string) => { mockSecure.delete(k); },
  isAvailableAsync: async () => true,
}));

type MockRecord = { state: string; pair: { publicKey: Uint8Array; secretKey: Uint8Array } | null };
let mockRecord: MockRecord = { state: 'absent', pair: null };
const mockPersisted: Uint8Array[] = [];
jest.mock('../../crypto/keyManager', () => ({
  persistKeyPair: jest.fn(async (p: { publicKey: Uint8Array }) => { mockPersisted.push(p.publicKey); }),
  readKeyRecord: jest.fn(async () => mockRecord),
}));

jest.mock('../../storage/accountVault', () => ({
  hasAccountVaultSnapshot: jest.fn(async () => false),
  restoreAccountVault: jest.fn(async () => true),
}));

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async () => null),
  kvSet: jest.fn(async () => undefined),
  closeLocalDatabase: jest.fn(async () => undefined),
}));

jest.mock('../../social/feedService', () => ({
  closeFeedStorage: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { restoreFromMnemonic, deriveKeyPairFromMnemonic } from '../seedPhrase';
import { PROFILE_STATE_KEY } from '../../identity/profileStateKey';

/** Тот же ключ SecureStore, в котором лежит завёрнутая фраза. */
const ENC_KEY = 'airchat_seed_mnemonic_enc_v2';
/** Запись есть, разбирается как v3 — и не открывается: ключа обёртки нет. */
const BROKEN = JSON.stringify({
  v: 3,
  saltB64: 'AAAAAAAAAAAAAAAAAAAAAA==',
  blobB64: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iters: 100000,
});

const MINE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

beforeEach(() => {
  mockSecure.clear();
  mockPersisted.length = 0;
  mockRecord = { state: 'absent', pair: null };
});

describe('восстановление поверх нечитаемой фразы', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: на чистом устройстве слова ложатся', async () => {
    const pair = await restoreFromMnemonic(MINE);
    expect(pair.publicKey).toHaveLength(32);
    // Тот самый ключ, наличие которого и отличает «не открылась» от «её нет».
    expect(mockSecure.get(ENC_KEY)).toBeTruthy();
    expect(mockPersisted).toHaveLength(1);
  });

  it('чужие слова не ложатся поверх нечитаемой фразы', async () => {
    mockSecure.set(ENC_KEY, BROKEN);
    mockRecord = { state: 'ok', pair: deriveKeyPairFromMnemonic(MINE) };
    await expect(restoreFromMnemonic(OTHER)).rejects.toThrow(/не читаются/);
    expect(mockSecure.get(ENC_KEY)).toBe(BROKEN);
    expect(mockPersisted).toHaveLength(0);
  });

  it('те же слова поверх нечитаемой фразы проходят', async () => {
    mockSecure.set(ENC_KEY, BROKEN);
    mockRecord = { state: 'ok', pair: deriveKeyPairFromMnemonic(MINE) };
    const pair = await restoreFromMnemonic(MINE);
    expect(pair.publicKey).toHaveLength(32);
    expect(mockSecure.get(ENC_KEY)).not.toBe(BROKEN);
    expect(mockPersisted).toHaveLength(1);
  });

  it('ключей на устройстве тоже нет — вслепую не стираем', async () => {
    mockSecure.set(ENC_KEY, BROKEN);
    mockRecord = { state: 'unreadable', pair: null };
    await expect(restoreFromMnemonic(MINE)).rejects.toThrow(/не читаются/);
    expect(mockSecure.get(ENC_KEY)).toBe(BROKEN);
    expect(mockPersisted).toHaveLength(0);
  });

  it('реестр профилей того же кошелька остаётся на месте', async () => {
    mockSecure.set(ENC_KEY, BROKEN);
    mockSecure.set(PROFILE_STATE_KEY, 'профили');
    mockRecord = { state: 'ok', pair: deriveKeyPairFromMnemonic(MINE) };
    await restoreFromMnemonic(MINE);
    expect(mockSecure.get(PROFILE_STATE_KEY)).toBe('профили');

    // ПРОВЕРКА НЕ ПУСТАЯ: на чистом устройстве реестр по-прежнему сносится —
    // там seed может оказаться и чужим.
    mockSecure.clear();
    mockPersisted.length = 0;
    mockSecure.set(PROFILE_STATE_KEY, 'профили');
    await restoreFromMnemonic(MINE);
    expect(mockSecure.get(PROFILE_STATE_KEY)).toBeUndefined();
  });
});
