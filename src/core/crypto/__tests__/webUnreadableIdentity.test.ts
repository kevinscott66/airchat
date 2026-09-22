/**
 * Порча записи в веб-хранилище не превращается в «записи нет» (AC-03).
 *
 * Дефект. На вебе `secureStoreQueued` — это WebCrypto + IndexedDB, и его
 * `getItemAsync` отвечал `null` на любой сбой расшифровки. Всё, что выше,
 * различает `absent` и `unreadable` по наличию строки:
 *   - keyManager на `null` в обеих записях видел `absent` и `ensureKeyPair`
 *     заводил НОВУЮ личность поверх старой — адрес терялся навсегда;
 *   - seedPhrase отвечал «фразы нет», и экран приветствия предлагал создать
 *     новый кошелёк поверх нечитаемого старого (теперь — «есть, но не
 *     открылась», то есть `unreadable` в decideStoredPhraseState);
 *   - authGuard отвечал «пароля нет», и приложение открывалось без пароля.
 *
 * Здесь всё это прогоняется на НАСТОЯЩЕЙ веб-реализации поверх общей
 * имитации IndexedDB — моки хранилища этот дефект не ловили бы: они и так
 * бросают или отвечают как велено.
 */
import { webcrypto } from 'crypto';
import { createFakeIndexedDb } from '../../storage/__tests__/fakeIndexedDb';

const mockFake = createFakeIndexedDb();
(globalThis as unknown as Record<string, unknown>).indexedDB = mockFake.factory;
if (typeof globalThis.crypto?.subtle === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

jest.mock('../../storage/secureStoreQueued', () => jest.requireActual('../../storage/secureStoreQueued.web'));

const mockDek = new Uint8Array(32).fill(9);
jest.mock('../../storage/localEncryption', () => ({
  getOrCreateDataEncryptionKey: async () => mockDek,
}));
jest.mock('../../storage/local', () => ({
  kvGet: async () => null,
  kvSet: async () => undefined,
}));
jest.mock('../../storage/accountVault', () => ({
  hasAccountVaultSnapshot: async () => false,
  restoreAccountVault: async () => true,
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { init: jest.fn(async () => {}), getActiveProfile: jest.fn(() => null) },
}));
jest.mock('../../security/biometricUnlock', () => ({
  isBiometricUnlockEnabled: jest.fn(async () => false),
  enableBiometricUnlock: jest.fn(async () => true),
  disableBiometricUnlock: jest.fn(async () => {}),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { generateMnemonic } from 'bip39';
import {
  ensureKeyPair,
  KeyStoreUnreadableError,
  KEYPAIR_SECURE_KEYS,
  persistKeyPair,
  readKeyRecord,
} from '../keyManager';
import {
  getStoredMnemonic,
  hasStoredMnemonic,
  invalidateMnemonicGeneration,
  persistEncryptedMnemonic,
  restoreFromMnemonic,
} from '../../backup/seedPhrase';
import { decideStoredPhraseState } from '../../backup/storedPhraseState';
import { AuthGuard } from '../../security/authGuard';
import { sensitiveAccessGate } from '../../security/sensitiveAccess';
import { isSecureStoreUnreadable } from '../../storage/secureStoreErrors';
import { log } from '../../logger';

const [SK_KEY, PK_KEY] = KEYPAIR_SECURE_KEYS;
const SEED_KEY = 'airchat_seed_mnemonic_enc_v2';
const PASSWORD_KEY = 'airchat_app_password_v1';

type Entry = { iv: ArrayBuffer; data: ArrayBuffer };
const entries = () => mockFake.raw('entries');

/** Испортить шифротекст записи на месте — как битый сектор или чужой ключ. */
function corrupt(key: string): string {
  const entry = entries().get(key) as Entry | undefined;
  if (!entry) throw new Error(`нет записи ${key}`);
  const bytes = new Uint8Array(entry.data);
  bytes[bytes.length - 1] ^= 0x5a;
  return Buffer.from(bytes).toString('hex');
}

const hexOf = (key: string) => Buffer.from(new Uint8Array((entries().get(key) as Entry).data)).toString('hex');

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('ожидался отказ, а пришёл ответ');
    },
    (e: unknown) => e
  );
}

beforeEach(async () => {
  // Первое обращение к модулю заводит сторы; дальше — только чистим записи.
  const SecureStore = jest.requireMock('../../storage/secureStoreQueued') as typeof import('../../storage/secureStoreQueued.web');
  await SecureStore.setItemAsync('warmup', '1');
  entries().clear();
  invalidateMnemonicGeneration();
  jest.clearAllMocks();
});

afterAll(() => {
  delete (globalThis as unknown as Record<string, unknown>).indexedDB;
});

describe('keyManager: личность устройства', () => {
  const ORIGINAL = ed25519.keygen();

  it('контроль: на пустом хранилище новая личность заводится', async () => {
    const pair = await ensureKeyPair();
    expect(pair.secretKey).toHaveLength(32);
    expect(entries().has(SK_KEY)).toBe(true);
  });

  it('целая запись читается как ok', async () => {
    await persistKeyPair({ secretKey: ORIGINAL.secretKey, publicKey: ORIGINAL.publicKey });
    const read = await readKeyRecord();
    expect(read.state).toBe('ok');
  });

  it('порченый шифротекст секрета — unreadable, новая личность НЕ заводится', async () => {
    await persistKeyPair({ secretKey: ORIGINAL.secretKey, publicKey: ORIGINAL.publicKey });
    const before = corrupt(SK_KEY);
    const pkBefore = hexOf(PK_KEY);

    expect((await readKeyRecord()).state).toBe('unreadable');
    const err = await rejection(ensureKeyPair());
    expect(err).toBeInstanceOf(KeyStoreUnreadableError);

    // Ни секрет, ни открытый ключ не переписаны.
    expect(hexOf(SK_KEY)).toBe(before);
    expect(hexOf(PK_KEY)).toBe(pkBefore);
    expect(log.warn).toHaveBeenCalledWith('key_load_record_unreadable', { key: SK_KEY, reason: 'decrypt_failed' });
  });

  it('запись секрета не того формата — тоже unreadable, а не absent', async () => {
    await persistKeyPair({ secretKey: ORIGINAL.secretKey, publicKey: ORIGINAL.publicKey });
    entries().set(SK_KEY, 'garbage');
    expect((await readKeyRecord()).state).toBe('unreadable');
    await expect(ensureKeyPair()).rejects.toBeInstanceOf(KeyStoreUnreadableError);
    expect(entries().get(SK_KEY)).toBe('garbage');
  });

  it('порча только открытого ключа — тоже не повод заводить новую личность', async () => {
    await persistKeyPair({ secretKey: ORIGINAL.secretKey, publicKey: ORIGINAL.publicKey });
    const before = corrupt(PK_KEY);
    await expect(ensureKeyPair()).rejects.toBeInstanceOf(KeyStoreUnreadableError);
    expect(hexOf(PK_KEY)).toBe(before);
  });
});

describe('seedPhrase: фраза кошелька', () => {
  it('порченая фраза — не «фразы нет»: запись есть, а открыть её нечем', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    const before = corrupt(SEED_KEY);
    // «Перезапуск»: запись кладёт фразу в кэш памяти, а читать надо с диска.
    invalidateMnemonicGeneration();

    // Та же модель, что у телефона с негодным ключом обёртки: наличие — да,
    // строки — нет, и экран приветствия видит `unreadable`, а не `none`.
    const present = await hasStoredMnemonic();
    const phrase = await getStoredMnemonic();
    expect(present).toBe(true);
    expect(phrase).toBeNull();
    expect(decideStoredPhraseState(present, phrase)).toBe('unreadable');
    expect(hexOf(SEED_KEY)).toBe(before);
    expect(log.warn).toHaveBeenCalledWith('seed_record_unreadable', { key: SEED_KEY, reason: 'decrypt_failed' });
  });

  it('запись фразы не того формата — тоже unreadable', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    entries().set(SEED_KEY, { junk: 1 });
    invalidateMnemonicGeneration();
    const present = await hasStoredMnemonic();
    expect(decideStoredPhraseState(present, await getStoredMnemonic())).toBe('unreadable');
    expect(entries().get(SEED_KEY)).toEqual({ junk: 1 });
  });

  it('восстановление чужой фразой поверх нечитаемой не пишет ничего', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    const before = corrupt(SEED_KEY);
    await expect(restoreFromMnemonic(generateMnemonic(256))).rejects.toThrow('Слова на устройстве не читаются');
    expect(hexOf(SEED_KEY)).toBe(before);
    expect(entries().has(SK_KEY)).toBe(false);
  });

  it('контроль: фразы нет — false, без ошибки', async () => {
    expect(await hasStoredMnemonic()).toBe(false);
    expect(await getStoredMnemonic()).toBeNull();
  });
});

describe('authGuard: пароль приложения', () => {
  it('порченая запись пароля — не «пароля нет»', async () => {
    const guard = AuthGuard.getInstance();
    expect(await guard.setPassword('correct horse battery 1')).toBe(true);
    const before = corrupt(PASSWORD_KEY);

    expect(isSecureStoreUnreadable(await rejection(guard.hasPassword()))).toBe(true);
    // Раздел с секретами не предлагает «задать пароль» поверх существующего.
    expect(isSecureStoreUnreadable(await rejection(sensitiveAccessGate()))).toBe(true);
    // И проверка пароля не проходит — ни за верный, ни «за отсутствием».
    await expect(guard.verifyPassword('correct horse battery 1')).rejects.toBeDefined();
    expect(hexOf(PASSWORD_KEY)).toBe(before);
  });

  it('контроль: пароля нет — false', async () => {
    expect(await AuthGuard.getInstance().hasPassword()).toBe(false);
  });
});
