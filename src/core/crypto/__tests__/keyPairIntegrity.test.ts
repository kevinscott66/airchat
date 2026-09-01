/**
 * Секрет и открытый ключ устройства обязаны быть одной парой (v4.32.489).
 *
 * Дефект. В SecureStore это ДВЕ записи, а переключение аккаунта переписывает
 * их по очереди (`persistKeyPair`). Между двумя await помещается и падение
 * процесса, и отказ хранилища — и тогда на устройстве остаётся секрет одного
 * профиля рядом с открытым ключом другого. Приложение после этого подписывает
 * одним ключом, а представляется другим: собеседники молча отбрасывают такие
 * подписи как поддельные, отправка «уходит» и не доходит никогда, и объяснить
 * это человеку нечем — экран не отличает «не дошло» от «не подписано».
 *
 * Вторая половина того же дефекта — незашифрованная запись секрета (формат до
 * `encsk1:`): её длина не проверялась вовсе, а прочитанное тут же
 * ПЕРЕШИФРОВЫВАЛОСЬ. То есть поправимый мусор в старом формате превращался в
 * непоправимый в новом, и происходило это молча, на первом же запуске.
 *
 * Правило: секрет главнее. Открытый ключ выводится из секрета, а не наоборот,
 * поэтому расхождение чинится выводом ключа заново — а не отправкой человека
 * на экран входа с рабочим секретом в хранилище.
 */
const mockStore = new Map<string, string>();
const mockWrites: string[] = [];
const mockDek = new Uint8Array(32).fill(7);

jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockWrites.push(k); mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
  isAvailableAsync: async () => true,
}));

jest.mock('../../storage/localEncryption', () => ({
  getOrCreateDataEncryptionKey: async () => mockDek,
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { ED25519_SECRET_KEY_BYTES, KEYPAIR_SECURE_KEYS, loadKeyPair, persistKeyPair } from '../keyManager';
import { log } from '../../logger';

const [SK_KEY, PK_KEY] = KEYPAIR_SECURE_KEYS;
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** Два профиля одного человека — то, между чем и разъезжаются две записи. */
const FIRST = ed25519.keygen();
const SECOND = ed25519.keygen();

beforeEach(() => {
  mockStore.clear();
  mockWrites.length = 0;
  jest.clearAllMocks();
});

describe('обычная пара', () => {
  it('переживает запись и чтение без изменений', async () => {
    await persistKeyPair({ secretKey: FIRST.secretKey, publicKey: FIRST.publicKey });
    const loaded = await loadKeyPair();
    expect(loaded && b64(loaded.secretKey)).toBe(b64(FIRST.secretKey));
    expect(loaded && b64(loaded.publicKey)).toBe(b64(FIRST.publicKey));
  });

  it('чтение целой пары ничего не переписывает', async () => {
    await persistKeyPair({ secretKey: FIRST.secretKey, publicKey: FIRST.publicKey });
    mockWrites.length = 0;
    await loadKeyPair();
    expect(mockWrites).toEqual([]);
  });

  it('секрет пишется первым — недописанная пара должна оставлять новый секрет', async () => {
    await persistKeyPair({ secretKey: FIRST.secretKey, publicKey: FIRST.publicKey });
    expect(mockWrites.indexOf(SK_KEY)).toBeLessThan(mockWrites.indexOf(PK_KEY));
  });
});

describe('недописанное переключение аккаунта', () => {
  /** Запись секрета прошла, запись открытого ключа — нет. */
  async function halfWritten(): Promise<void> {
    await persistKeyPair({ secretKey: FIRST.secretKey, publicKey: FIRST.publicKey });
    await persistKeyPair({ secretKey: SECOND.secretKey, publicKey: SECOND.publicKey });
    mockStore.set(PK_KEY, b64(FIRST.publicKey));
    mockWrites.length = 0;
  }

  it('отдаёт открытый ключ, который соответствует секрету', async () => {
    await halfWritten();
    const loaded = await loadKeyPair();
    expect(loaded && b64(loaded.publicKey)).toBe(b64(SECOND.publicKey));
    expect(loaded && b64(loaded.secretKey)).toBe(b64(SECOND.secretKey));
  });

  it('чинит хранилище, а не только ответ', async () => {
    await halfWritten();
    await loadKeyPair();
    expect(mockStore.get(PK_KEY)).toBe(b64(SECOND.publicKey));
    const again = await loadKeyPair();
    expect(again && b64(again.publicKey)).toBe(b64(SECOND.publicKey));
  });

  it('не отправляет человека на экран входа с рабочим секретом в хранилище', async () => {
    await halfWritten();
    expect(await loadKeyPair()).not.toBeNull();
  });

  it('оставляет след в журнале — молча чинить личность нельзя', async () => {
    await halfWritten();
    await loadKeyPair();
    expect(log.warn).toHaveBeenCalledWith('key_load_public_key_repaired', expect.any(Object));
  });
});

describe('незашифрованная запись секрета (формат до encsk1:)', () => {
  it('переезжает в зашифрованный формат', async () => {
    mockStore.set(SK_KEY, b64(FIRST.secretKey));
    mockStore.set(PK_KEY, b64(FIRST.publicKey));
    const loaded = await loadKeyPair();
    expect(loaded && b64(loaded.secretKey)).toBe(b64(FIRST.secretKey));
    expect(mockStore.get(SK_KEY)?.startsWith('encsk1:')).toBe(true);
  });

  it('порченая запись не перешифровывается — мусор остаётся поправимым', async () => {
    const broken = b64(FIRST.secretKey.slice(0, 10));
    mockStore.set(SK_KEY, broken);
    mockStore.set(PK_KEY, b64(FIRST.publicKey));
    expect(await loadKeyPair()).toBeNull();
    expect(mockStore.get(SK_KEY)).toBe(broken);
    expect(log.warn).toHaveBeenCalledWith('key_load_bad_legacy_secret', { bytes: 10 });
  });

  it('лишние байты — тоже не секрет', async () => {
    const tooLong = b64(new Uint8Array(ED25519_SECRET_KEY_BYTES + 1));
    mockStore.set(SK_KEY, tooLong);
    mockStore.set(PK_KEY, b64(FIRST.publicKey));
    expect(await loadKeyPair()).toBeNull();
  });

  it('расхождение с открытым ключом чинится при том же переезде', async () => {
    mockStore.set(SK_KEY, b64(SECOND.secretKey));
    mockStore.set(PK_KEY, b64(FIRST.publicKey));
    const loaded = await loadKeyPair();
    expect(loaded && b64(loaded.publicKey)).toBe(b64(SECOND.publicKey));
    expect(mockStore.get(PK_KEY)).toBe(b64(SECOND.publicKey));
  });
});

describe('порченый открытый ключ', () => {
  // v4.32.547: раньше здесь ждали `null` — «экран входа честнее сбоя при
  // отправке». Но при рабочем секретном ключе экран входа означал новую
  // личность поверх старой: ensureKeyPair принимал этот `null` за первый
  // запуск. Правило «секрет главнее» действует и здесь — открытый ключ
  // выводится из секрета заново.
  it('чинится выводом из секрета, а не отправкой человека на экран входа', async () => {
    await persistKeyPair({ secretKey: FIRST.secretKey, publicKey: FIRST.publicKey });
    mockStore.set(PK_KEY, b64(new Uint8Array(10)));
    const loaded = await loadKeyPair();
    expect(loaded && b64(loaded.publicKey)).toBe(b64(FIRST.publicKey));
    expect(mockStore.get(PK_KEY)).toBe(b64(FIRST.publicKey));
    expect(log.warn).toHaveBeenCalledWith('key_load_bad_public_key', { bytes: 10 });
  });

  it('пустое хранилище — это не пара', async () => {
    expect(await loadKeyPair()).toBeNull();
  });
});
