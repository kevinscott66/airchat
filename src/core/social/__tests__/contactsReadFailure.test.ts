/**
 * Сорванное чтение контактов отличимо от пустой записной книжки (v4.32.622).
 *
 * `listContactsFor` отвечает пустым списком в обоих случаях — и для проверок
 * «в контактах ли он» это верно. Но экран рисует по тому же списку «Добавьте
 * первый контакт», и отказ базы выглядел как «все контакты пропали».
 * `listContactsRead` отвечает null ровно при отказе.
 */

let mockReadFails = false;
// v4.32.685: отказ базы приходит не только как «нет ответа» от kvTryGet.
// Строка контакта читается ГЛУБЖЕ, уже после разбора указателя, и там сбой
// SQLite прилетает исключением — его ловит catch всей функции.
let mockCellThrows = false;

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
    // v4.32.641: contacts.ts читает строку контакта трёхзначно. Здесь шифра нет,
    // поэтому «непрочитанная» из этой заглушки не приходит вовсе — приходят
    // только «есть» и «нет», а отказ базы (mockReadFails) кидает, как и настоящая.
    kvGetSecretCell: jest.fn(async (key: string) => {
      if (mockCellThrows) throw new Error('database is locked');
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
    // v4.32.659: прежде отказ базы здесь БРОСАЛ, и оба чтения выше проходили
    // только благодаря этому — настоящие kvTryGet/kvGet ошибку гасят внутри и
    // отдают null, то есть ровно то же, что «записи нет». Заглушка теперь ведёт
    // себя как настоящая: отказ — это null, а не исключение. Разбор «отказ или
    // пусто» делает scopedKvTryGetFor, у которого для этого три состояния.
    kvTryGet: jest.fn(async (key: string) => {
      if (mockReadFails) return null;
      return { value: await kvGet(key) };
    }),
    kvSetChecked: jest.fn(async (key: string, value: string) => {
      await kvSet(key, value);
      return true;
    }),
    profileKvGet: jest.fn(async (profileId: number, key: string) => {
      if (mockReadFails) return null;
      return kvGet(`p${profileId}:${key}`);
    }),
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
  addContact,
  invalidateContactsList,
  listContactsFor,
  listContactsRead,
  listContactsReadFor,
} from '../contacts';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };

function reset(): void {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockReadFails = false;
  mockCellThrows = false;
  // Модульный TTL-кэш списка иначе переживает очистку kv.
  invalidateContactsList();
}

function makeKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

beforeEach(reset);

describe('listContactsRead отличает отказ от пустоты', () => {
  test('отказ чтения — null', async () => {
    mockReadFails = true;
    expect(await listContactsRead()).toBeNull();
    expect(await listContactsReadFor(1)).toBeNull();
  });

  test('проверка не пустая: пустая база — пустой массив, а не null', async () => {
    expect(await listContactsRead()).toEqual([]);
  });

  test('проверка не пустая: контакт есть — он и возвращается', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    invalidateContactsList();

    const read = await listContactsRead();
    expect(read).not.toBeNull();
    expect(read).toHaveLength(1);
    expect(read?.[0].displayName).toBe('Боб');
  });

  test('listContactsFor при отказе по-прежнему отвечает пустым списком', async () => {
    mockReadFails = true;
    // Проверкам «в контактах ли он» диагноз не нужен: у них ответ, а не null.
    expect(await listContactsFor(1)).toEqual([]);
  });
});

/**
 * Сбой ПОСРЕДИ чтения — тоже отказ, а не пустая записная книжка (v4.32.685).
 *
 * Отказ приходит двумя разными путями. Первый — kvTryGet не отвечает вовсе:
 * его разбирает ранний выход по `read === null`, и его проверял круг 622.
 * Второй — SQLite срывается уже после того, как указатель разобран, на чтении
 * очередной строки контакта; такой отказ прилетает исключением, и ловит его
 * catch всей функции. Оба обязаны отвечать null: экран рисует по одному и тому
 * же списку, и во втором случае человек с полной записной книжкой увидел бы
 * «Добавьте первый контакт» ровно так же.
 */
describe('сбой посреди чтения — тоже отказ', () => {
  test('исключение на строке контакта — null, а не пустой список', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    invalidateContactsList();

    mockCellThrows = true;
    expect(await listContactsRead()).toBeNull();
    invalidateContactsList();
    expect(await listContactsReadFor(1)).toBeNull();
  });

  test('проверка не пустая: без сбоя тот же контакт читается', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    invalidateContactsList();

    const read = await listContactsReadFor(1);
    expect(read).toHaveLength(1);
    expect(read?.[0].displayName).toBe('Боб');
  });

  test('listContactsFor и на исключении отвечает пустым списком', async () => {
    const me = makeKeyPair();
    const peer = makeKeyPair();
    await addContact(me, peer.publicKey, 'Боб');
    invalidateContactsList();

    mockCellThrows = true;
    // Проверкам «в контактах ли он» диагноз не нужен: у них ответ, а не null.
    expect(await listContactsFor(1)).toEqual([]);
  });
});
