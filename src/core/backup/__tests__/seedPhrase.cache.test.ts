/**
 * Фраза распаковывается один раз, а не на каждый вызов (v4.32.542).
 *
 * Дефект. `getStoredMnemonic()` — это чтение SecureStore (очередь, на устройстве
 * десятки секунд на холодном старте) плюс PBKDF2-HMAC-SHA256 × 100 000 на
 * чистом JS. Звали его на каждое вложение, на каждую резервную копию диалогов
 * (через 4 с после каждой записи в чат) и из четырёх мест настроек. Кэш
 * v4.32.226 в `dialogBackup` снял оттуда только вывод ключа по bip39 — саму
 * распаковку, которая дороже, он оставил.
 *
 * Опасная половина кэша — не скорость, а забывание: фраза обязана исчезать из
 * памяти ровно там, где меняется кошелёк, иначе после выхода из аккаунта в
 * памяти остался бы предыдущий владелец устройства.
 */
const mockStore = new Map<string, string>();
const mockReads: string[] = [];

jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (k: string) => {
    mockReads.push(k);
    return mockStore.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => { mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
  isAvailableAsync: async () => true,
}));

jest.mock('../../storage/local', () => ({
  kvGet: async () => null,
  kvSet: async () => undefined,
}));

jest.mock('../../crypto/keyManager', () => ({ persistKeyPair: async () => undefined }));

jest.mock('../../storage/accountVault', () => ({
  hasAccountVaultSnapshot: async () => false,
  restoreAccountVault: async () => undefined,
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { generateMnemonic } from 'bip39';
import {
  getStoredMnemonic,
  persistEncryptedMnemonic,
  invalidateMnemonicGeneration,
  wipeMnemonicAndSessionFlags,
} from '../seedPhrase';

const ENC_KEY = 'airchat_seed_mnemonic_enc_v2';
const encReads = () => mockReads.filter((k) => k === ENC_KEY).length;

describe('getStoredMnemonic: память на распакованную фразу', () => {
  beforeEach(() => {
    mockStore.clear();
    mockReads.length = 0;
    invalidateMnemonicGeneration();
  });

  it('запись фразы сразу наполняет кэш — повторные чтения не трогают хранилище', async () => {
    const m = generateMnemonic(256);
    await persistEncryptedMnemonic(m);
    mockReads.length = 0;
    expect(await getStoredMnemonic()).toBe(m);
    expect(await getStoredMnemonic()).toBe(m);
    expect(encReads()).toBe(0);
  });

  it('одновременные вызовы складываются в одну распаковку', async () => {
    const m = generateMnemonic(256);
    await persistEncryptedMnemonic(m);
    invalidateMnemonicGeneration();
    mockReads.length = 0;
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => getStoredMnemonic()));
    expect(all).toEqual([m, m, m, m, m]);
    expect(encReads()).toBe(1);
  });

  it('после сброса кошелька в памяти не остаётся прежней фразы', async () => {
    const first = generateMnemonic(256);
    await persistEncryptedMnemonic(first);
    expect(await getStoredMnemonic()).toBe(first);
    await wipeMnemonicAndSessionFlags();
    expect(await getStoredMnemonic()).toBeNull();
  });

  it('новая фраза вытесняет старую, а не подаётся из кэша', async () => {
    const first = generateMnemonic(256);
    const second = generateMnemonic(256);
    await persistEncryptedMnemonic(first);
    expect(await getStoredMnemonic()).toBe(first);
    await persistEncryptedMnemonic(second);
    expect(await getStoredMnemonic()).toBe(second);
  });
});
