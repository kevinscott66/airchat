/**
 * Непрочитанная строка контакта — не отсутствующая (v4.32.641).
 *
 * `kvGetSecret` сводил к `null` три разных исхода: строки нет, база не
 * ответила, DEK не открылся. Разбор индекса считал все три «строка испорчена»
 * и вычёркивал контакт из `contacts_index` — фоновой починкой, которой человек
 * не видит и которую нечем отменить. Одного запертого Keychain (телефон только
 * что перезагрузили) хватало, чтобы вся записная книжка ушла в badIds. Две
 * записи на том же `null` собирали строку заново поверх целого шифртекста.
 */

const mockUnreadable = new Set<string>();

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
    kvGetSecret: jest.fn(async (key: string) => kvGet(key)),
    // Заглушка умеет то, чего не умела прежняя: отдать «не прочиталось».
    kvGetSecretCell: jest.fn(async (key: string) => {
      if (mockUnreadable.has(key)) return { state: 'unreadable' };
      const v = await kvGet(key);
      return v == null ? { state: 'absent' } : { state: 'plain', text: v };
    }),
    // v4.32.660: настоящий kvSetSecret отвечает, легла ли запись на диск, и
    // contacts.ts теперь на этот ответ смотрит. Заглушка, возвращавшая undefined,
    // означала бы «не записалось» на каждой удачной записи.
    kvSetSecret: jest.fn(async (key: string, value: string) => {
      await kvSet(key, value);
      return true;
    }),
    // v4.32.659: указатель контактов contacts.ts читает через scopedKvTryGetFor,
    // а тот работает на kvTryGet/kvSetChecked — без них заглушка обрывала бы
    // чтение TypeError'ом.
    kvTryGet: jest.fn(async (key: string) => ({ value: await kvGet(key) })),
    kvSetChecked: jest.fn(async (key: string, value: string) => {
      await kvSet(key, value);
      return true;
    }),
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

jest.mock('../../crypto/keyManager', () => {
  const { x25519 } = require('@noble/curves/ed25519.js');
  return {
    ecdhSharedSecret: jest.fn((mySecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array =>
      x25519.getSharedSecret(mySecretKey.slice(0, 32), peerPublicKey.slice(0, 32))),
    publicKeyHash4: jest.requireActual('../../crypto/keyManager').publicKeyHash4,
  };
});

import { x25519 } from '@noble/curves/ed25519.js';
import {
  CONTACT_ROW_UNREADABLE_MESSAGE,
  addContact,
  ensureImplicitContact,
  invalidateContactsList,
  listContactsReadFor,
} from '../contacts';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };

function reset(): void {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockUnreadable.clear();
  invalidateContactsList();
}

function makeKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

function rowKey(peer: Uint8Array): string {
  return `p1:contact:${Buffer.from(peer).toString('base64')}`;
}

function indexIds(): string[] {
  const raw = mockLocal.__kv['p1:contacts_index'];
  return raw ? (JSON.parse(raw) as string[]) : [];
}

/** Починка индекса запускается через `void withContactLock(...)` — дать ей дойти. */
async function settleHeal(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(reset);

describe('разбор индекса не вычёркивает непрочитанное', () => {
  test('проверка не пустая: читаемый контакт виден и остаётся в индексе', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    invalidateContactsList();

    const read = await listContactsReadFor(1);
    expect(read).toHaveLength(1);
    expect(read?.[0].displayName).toBe('Боб');
    await settleHeal();
    expect(indexIds()).toHaveLength(1);
  });

  test('повод для правки жив: строки нет — контакт из индекса убирается', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    // Строка исчезла, а идентификатор в индексе остался — ровно то, ради чего
    // починка и написана.
    delete mockLocal.__kv[rowKey(peer.publicKey)];
    invalidateContactsList();

    expect(await listContactsReadFor(1)).toHaveLength(0);
    await settleHeal();
    expect(indexIds()).toHaveLength(0);
  });

  test('строка не прочиталась — контакт остаётся в индексе', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    const before = indexIds().length;
    expect(before).toBe(1);

    mockUnreadable.add(rowKey(peer.publicKey));
    invalidateContactsList();

    // Показать нечего — строку не открыли. Но и вычеркнуть нельзя.
    expect(await listContactsReadFor(1)).toHaveLength(0);
    await settleHeal();
    expect(indexIds()).toHaveLength(before);

    // Хранилище отпустило — контакт возвращается сам, без восстановления.
    mockUnreadable.clear();
    invalidateContactsList();
    const back = await listContactsReadFor(1);
    expect(back).toHaveLength(1);
    expect(back?.[0].displayName).toBe('Боб');
  });

  test('непрочитанная строка не уводит за собой соседние', async () => {
    const me = makeKeyPair();
    const a = makeKeyPair();
    const b = makeKeyPair();
    await addContact(me, a.publicKey, 'Аня');
    await addContact(me, b.publicKey, 'Боб');
    mockUnreadable.add(rowKey(a.publicKey));
    invalidateContactsList();

    const read = await listContactsReadFor(1);
    expect(read).toHaveLength(1);
    expect(read?.[0].displayName).toBe('Боб');
    await settleHeal();
    expect(indexIds()).toHaveLength(2);
  });
});

describe('запись не ложится поверх непрочитанной строки', () => {
  test('addContact отказывается, а прежний шифртекст цел', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    const kept = mockLocal.__kv[rowKey(peer.publicKey)];

    mockUnreadable.add(rowKey(peer.publicKey));
    await expect(addContact(me, peer.publicKey, 'Другое имя')).rejects.toThrow(
      CONTACT_ROW_UNREADABLE_MESSAGE
    );
    expect(mockLocal.__kv[rowKey(peer.publicKey)]).toBe(kept);
  });

  test('проверка не пустая: над читаемой строкой addContact работает', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    await addContact(me, peer.publicKey, 'Роберт');
    invalidateContactsList();

    const read = await listContactsReadFor(1);
    expect(read?.[0].displayName).toBe('Роберт');
  });

  test('ensureImplicitContact не заводит неявную строку поверх непрочитанной', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    const kept = mockLocal.__kv[rowKey(peer.publicKey)];

    mockUnreadable.add(rowKey(peer.publicKey));
    expect(await ensureImplicitContact(1, me, peer.publicKey, 'незнакомец')).toBe(false);
    expect(mockLocal.__kv[rowKey(peer.publicKey)]).toBe(kept);

    // Имя, которое задал человек, на месте — а не затёрто неявной строкой.
    mockUnreadable.clear();
    invalidateContactsList();
    expect((await listContactsReadFor(1))?.[0].displayName).toBe('Боб');
  });

  test('проверка не пустая: незнакомца без строки ensureImplicitContact заводит', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    expect(await ensureImplicitContact(1, me, peer.publicKey, 'незнакомец')).toBe(true);
    expect(mockLocal.__kv[rowKey(peer.publicKey)]).toBeDefined();
  });
});
