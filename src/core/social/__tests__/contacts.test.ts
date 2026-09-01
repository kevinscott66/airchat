/**
 * Unit tests for contacts.ts — add, list, symkey cache, incoming invite dedup.
 */

// In-memory kv store (no SQLite needed).
// profileKv* повторяют реальную реализацию из storage/local: это тонкие
// обёртки над kv* с префиксом `p{profileId}:`, поэтому тесты проверяют
// настоящее скоупирование ключей по профилю, а не упрощённую заглушку.
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const kvGet = jest.fn(async (key: string) => kv[key] ?? null);
  const kvSet = jest.fn(async (key: string, value: string) => { kv[key] = value; });
  const kvDelete = jest.fn(async (key: string) => { delete kv[key]; });
  return {
    __kv: kv,
    kvGet,
    kvSet,
    kvDelete,
    // kvGetSecret/kvSetSecret в реальности шифруют значение под DEK из SecureStore,
    // а незашифрованные строки пропускают насквозь. В тестах SecureStore нет, и
    // проверяем мы не шифрование (для него есть localEncryption.test.ts), а то,
    // под какими ключами contacts.ts кладёт и ищет строки. Поэтому здесь —
    // тот же kv, что и у обычных kvGet/kvSet: сквозной проход, как у старых строк.
    kvGetSecret: jest.fn(async (key: string) => kvGet(key)),
    kvSetSecret: jest.fn(async (key: string, value: string) => kvSet(key, value)),
    profileKvGet: jest.fn(async (profileId: number, key: string) => kvGet(`p${profileId}:${key}`)),
    profileKvSet: jest.fn(async (profileId: number, key: string, value: string) =>
      kvSet(`p${profileId}:${key}`, value)),
    profileKvDelete: jest.fn(async (profileId: number, key: string) =>
      kvDelete(`p${profileId}:${key}`)),
    notifyChatStorageChanged: jest.fn(),
  };
});

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { x25519 } from '@noble/curves/ed25519.js';
import {
  addContact,
  BAD_PUBLIC_KEY_MESSAGE,
  listContacts,
  handleIncomingInvite,
  getSymmetricKeyForPeer,
  findContactPubKeyByHash,
  invalidateContactsList,
} from '../contacts';
import { publicKeyHash4 } from '../../crypto/keyManager';

// We need real ECDH — mock only at the storage layer, leave crypto real.
// ecdhSharedSecret uses x25519 internally. Mock it at the module level if needed,
// but since @noble/curves is available in the test env, we can use real crypto.

// However, ecdhSharedSecret is imported from keyManager which may have RN deps. Mock it.
jest.mock('../../crypto/keyManager', () => {
  const { x25519 } = require('@noble/curves/ed25519.js');
  return {
    ecdhSharedSecret: jest.fn((mySecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array => {
      return x25519.getSharedSecret(mySecretKey.slice(0, 32), peerPublicKey.slice(0, 32));
    }),
    // Чистая FNV-1a без RN-зависимостей — берём НАСТОЯЩУЮ реализацию, чтобы
    // тест ловил расхождение хэша, а не сверялся с собственной копией.
    publicKeyHash4: jest.requireActual('../../crypto/keyManager').publicKeyHash4,
  };
});

jest.mock('../../crypto/encrypt', () => {
  const real = jest.requireActual('../../crypto/encrypt');
  return real;
});

const mockLocal = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
};

function clearKv() {
  const kv = mockLocal.__kv;
  for (const k of Object.keys(kv)) delete kv[k];
  // v4.32.227 добавил модульный TTL-кэш списка контактов. Без его сброса
  // контакты предыдущего теста переживают очистку kv и текут в следующий.
  invalidateContactsList();
}

function makeKeyPair() {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  // Simulate the KeyPairBytes shape used in the app (ed25519 pair with x25519 keys embedded)
  return { publicKey, secretKey } as { publicKey: Uint8Array; secretKey: Uint8Array };
}

// ── Basic add / list ──────────────────────────────────────────────────────────

describe('contacts — add and list', () => {
  beforeEach(clearKv);

  test('addContact stores and listContacts returns it', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(alice, bob.publicKey, 'Bob');
    const list = await listContacts();
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('Bob');
    expect(list[0].peerPublicKey).toBe(Buffer.from(bob.publicKey).toString('base64'));
  });

  test('addContact stores profileCid when provided', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(alice, bob.publicKey, 'Bob', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55dbz');
    const list = await listContacts();
    expect(list[0].profileCid).toBe('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55dbz');
  });

  test('listContacts returns empty array when no contacts', async () => {
    expect(await listContacts()).toEqual([]);
  });

  test('adding two different contacts returns both', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    const carol = makeKeyPair();
    await addContact(alice, bob.publicKey, 'Bob');
    await addContact(alice, carol.publicKey, 'Carol');
    const list = await listContacts();
    expect(list).toHaveLength(2);
    const names = list.map((c) => c.displayName).sort();
    expect(names).toEqual(['Bob', 'Carol']);
  });

  test('rememberContactId deduplicates the index', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(alice, bob.publicKey, 'Bob');
    await addContact(alice, bob.publicKey, 'Bob Again'); // same key
    await listContacts();
    // Index should not have duplicates
    const ids = JSON.parse(mockLocal.__kv['contacts_index'] ?? '[]') as string[];
    const uniq = new Set(ids);
    expect(uniq.size).toBe(ids.length);
  });
});

// ── Symmetric key cache ───────────────────────────────────────────────────────

describe('contacts — getSymmetricKeyForPeer', () => {
  beforeEach(clearKv);

  test('returns null for unknown peer', async () => {
    expect(await getSymmetricKeyForPeer(1, 'unknownkey')).toBeNull();
  });

  test('returns consistent key after addContact', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(alice, bob.publicKey, 'Bob');
    const b64 = Buffer.from(bob.publicKey).toString('base64');
    const key1 = await getSymmetricKeyForPeer(1, b64);
    const key2 = await getSymmetricKeyForPeer(1, b64); // second call → from cache
    expect(key1).not.toBeNull();
    expect(Buffer.from(key1!).toString('base64')).toBe(Buffer.from(key2!).toString('base64'));
  });

  test('ECDH key is deterministic for same key pair', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(alice, bob.publicKey, 'Bob');
    const b64 = Buffer.from(bob.publicKey).toString('base64');
    const k1 = await getSymmetricKeyForPeer(1, b64);

    // Clear cache and re-read from storage
    clearKv();
    await addContact(alice, bob.publicKey, 'Bob'); // re-add with same keys
    const k2 = await getSymmetricKeyForPeer(1, b64);

    expect(Buffer.from(k1!).toString('hex')).toBe(Buffer.from(k2!).toString('hex'));
  });
});

// ── handleIncomingInvite ──────────────────────────────────────────────────────

describe('contacts — handleIncomingInvite', () => {
  beforeEach(clearKv);

  test('creates a new contact row and returns true', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    const added = await handleIncomingInvite(alice, bob.publicKey);
    expect(added).toBe(true);
    const list = await listContacts();
    expect(list).toHaveLength(1);
  });

  test('returns false if contact already exists (no duplicate)', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await handleIncomingInvite(alice, bob.publicKey); // first time
    const second = await handleIncomingInvite(alice, bob.publicKey); // dupe
    expect(second).toBe(false);
    expect(await listContacts()).toHaveLength(1);
  });

  test('returns false when peer public key equals own key (self-invite)', async () => {
    const alice = makeKeyPair();
    const result = await handleIncomingInvite(alice, alice.publicKey);
    expect(result).toBe(false);
  });
});

// ── findContactPubKeyByHash ───────────────────────────────────────────────────

describe('contacts — findContactPubKeyByHash', () => {
  beforeEach(clearKv);

  test('finds a contact by 4-byte public key hash', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await addContact(alice, bob.publicKey, 'Bob');
    const hash = publicKeyHash4(bob.publicKey);
    const found = await findContactPubKeyByHash(hash);
    expect(found).toBe(Buffer.from(bob.publicKey).toString('base64'));
  });

  test('returns null for unknown hash', async () => {
    expect(await findContactPubKeyByHash(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBeNull();
  });
});

// ── addContact: проверка ключа в единственной точке ───────────────────────────

describe('contacts — негодный открытый ключ отвергается до кривой (v4.32.427)', () => {
  beforeEach(clearKv);

  test('короткий ключ — отказ по-русски, а не текст из noble', async () => {
    const alice = makeKeyPair();
    await expect(addContact(alice, new Uint8Array(10), 'Мэллори')).rejects.toThrow(
      BAD_PUBLIC_KEY_MESSAGE
    );
  });

  test('длинный ключ — тоже отказ', async () => {
    const alice = makeKeyPair();
    await expect(addContact(alice, new Uint8Array(33), 'Мэллори')).rejects.toThrow(
      BAD_PUBLIC_KEY_MESSAGE
    );
  });

  test('пустой ключ — отказ', async () => {
    const alice = makeKeyPair();
    await expect(addContact(alice, new Uint8Array(0), 'Мэллори')).rejects.toThrow(
      BAD_PUBLIC_KEY_MESSAGE
    );
  });

  test('отказ происходит ДО записи: список контактов остаётся пустым', async () => {
    const alice = makeKeyPair();
    await expect(addContact(alice, new Uint8Array(31), 'Мэллори')).rejects.toThrow();
    expect(await listContacts()).toEqual([]);
  });

  test('сообщение отказа — по-русски и без латиницы', () => {
    expect(BAD_PUBLIC_KEY_MESSAGE).toMatch(/[а-яё]/i);
    expect(BAD_PUBLIC_KEY_MESSAGE).not.toMatch(/[a-z]/i);
  });

  test('невырожденность: настоящий 32-байтный ключ по-прежнему добавляется', async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    expect(bob.publicKey).toHaveLength(32);
    await addContact(alice, bob.publicKey, 'Боб');
    expect((await listContacts()).map((c) => c.displayName)).toEqual(['Боб']);
  });

  test('handleIncomingInvite с негодным ключом не создаёт контакт', async () => {
    const alice = makeKeyPair();
    await expect(handleIncomingInvite(alice, new Uint8Array(16))).rejects.toThrow(
      BAD_PUBLIC_KEY_MESSAGE
    );
    expect(await listContacts()).toEqual([]);
  });
});
