/**
 * Перешифровка секретного ключа при смене DEK (v4.32.615).
 *
 * Дефект. rewrapSecretKeyWithDek была Promise<void>: и «перешифровал», и «не
 * смог расшифровать» выглядели снаружи одинаково. Миграция random →
 * deterministic звала её и на обоих исходах шла дальше — объявляла новый DEK
 * действующим через persistDek. Если запись секрета была обрезана Keychain'ом
 * или завёрнута ещё в предыдущий ключ, секрет оставался под старым, уже
 * перезаписанным DEK: readKeyRecord отдавал key_load_bad_wrapped_secret,
 * ensureKeyPair вечно бросал KeyStoreUnreadableError, а прежний ключ был уже
 * затёрт. Ed25519-личность устройства терялась необратимо — при том что до
 * миграции она была цела.
 *
 * Второй половиной того же разбора стал обрыв на полпути: если процесс упал
 * между перешифровкой секрета и записью нового DEK, на следующем запуске
 * секрет УЖЕ под новым ключом. Признать это успехом обязательно — иначе
 * миграция встанет насмерть и приложение не откроется никогда.
 */
const mockStore = new Map<string, string>();
const mockWrites: string[] = [];

jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockWrites.push(k); mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
  isAvailableAsync: async () => true,
}));

jest.mock('../../storage/localEncryption', () => ({
  getOrCreateDataEncryptionKey: async () => new Uint8Array(32).fill(7),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { ED25519_SECRET_KEY_BYTES, KEYPAIR_SECURE_KEYS, rewrapSecretKeyWithDek } from '../keyManager';
import { encryptSymmetric, decryptSymmetric } from '../encrypt';

const [SK_KEY] = KEYPAIR_SECURE_KEYS;
const SK_ENC_PREFIX = 'encsk1:';

const OLD_DEK = new Uint8Array(32).fill(1);
const NEW_DEK = new Uint8Array(32).fill(2);
const THIRD_DEK = new Uint8Array(32).fill(3);

const SECRET = ed25519.keygen().secretKey;

function wrapWith(dek: Uint8Array, secret: Uint8Array): string {
  return SK_ENC_PREFIX + Buffer.from(encryptSymmetric(dek, secret)).toString('base64');
}

function unwrapWith(dek: Uint8Array, stored: string): Uint8Array | null {
  const blob = new Uint8Array(Buffer.from(stored.slice(SK_ENC_PREFIX.length), 'base64'));
  return decryptSymmetric(dek, blob);
}

beforeEach(() => {
  mockStore.clear();
  mockWrites.length = 0;
});

describe('перешифровка секрета отвечает исходом, а не молчанием', () => {
  it('секрет под старым ключом переезжает под новый', async () => {
    mockStore.set(SK_KEY, wrapWith(OLD_DEK, SECRET));

    await expect(rewrapSecretKeyWithDek(OLD_DEK, NEW_DEK)).resolves.toBe(true);

    const moved = unwrapWith(NEW_DEK, mockStore.get(SK_KEY) as string);
    expect(moved).not.toBeNull();
    expect(Buffer.from(moved as Uint8Array).equals(Buffer.from(SECRET))).toBe(true);
  });

  it('секрет под третьим ключом — отказ, и запись не трогается', async () => {
    const untouchable = wrapWith(THIRD_DEK, SECRET);
    mockStore.set(SK_KEY, untouchable);

    await expect(rewrapSecretKeyWithDek(OLD_DEK, NEW_DEK)).resolves.toBe(false);

    expect(mockStore.get(SK_KEY)).toBe(untouchable);
    expect(mockWrites).toEqual([]);
  });

  it('обрезанная запись — отказ, а не тихий «успех»', async () => {
    const cut = wrapWith(OLD_DEK, SECRET).slice(0, SK_ENC_PREFIX.length + 12);
    mockStore.set(SK_KEY, cut);

    await expect(rewrapSecretKeyWithDek(OLD_DEK, NEW_DEK)).resolves.toBe(false);
    expect(mockStore.get(SK_KEY)).toBe(cut);
  });

  it('секрет не той длины под верным ключом — тоже отказ', async () => {
    mockStore.set(SK_KEY, wrapWith(OLD_DEK, new Uint8Array(ED25519_SECRET_KEY_BYTES - 1).fill(9)));

    await expect(rewrapSecretKeyWithDek(OLD_DEK, NEW_DEK)).resolves.toBe(false);
    expect(mockWrites).toEqual([]);
  });

  it('секрет уже под новым ключом — это обрыв на полпути, а не отказ', async () => {
    const already = wrapWith(NEW_DEK, SECRET);
    mockStore.set(SK_KEY, already);

    await expect(rewrapSecretKeyWithDek(OLD_DEK, NEW_DEK)).resolves.toBe(true);
    // Переписывать нечего: запись и так в нужном виде.
    expect(mockStore.get(SK_KEY)).toBe(already);
    expect(mockWrites).toEqual([]);
  });

  it('записи нет вовсе — перешифровывать нечего, миграция идёт дальше', async () => {
    await expect(rewrapSecretKeyWithDek(OLD_DEK, NEW_DEK)).resolves.toBe(true);
    expect(mockWrites).toEqual([]);
  });

  it('незашифрованный секрет старого формата не трогается', async () => {
    const legacy = Buffer.from(SECRET).toString('base64');
    mockStore.set(SK_KEY, legacy);

    await expect(rewrapSecretKeyWithDek(OLD_DEK, NEW_DEK)).resolves.toBe(true);
    expect(mockStore.get(SK_KEY)).toBe(legacy);
  });
});
