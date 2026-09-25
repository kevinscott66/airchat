/**
 * Контакт «добавлен» только тогда, когда он есть в списке (v4.32.958).
 *
 * Дефект. Строку контакта пишет проверенная форма — `contactRowSet` отвечает,
 * легла ли она, и `addContact` бросает на отказе (v4.32.660). А сам указатель
 * `contacts_index` писался через `profileKvSet` → `kvSet`, а тот гасит отказ
 * базы и отдаёт void: «не влезло на диск» приходило неотличимо от «легло».
 * Закрыта была ровно одна половина, а вторая — обратная и худшая: строка есть,
 * указателя нет.
 *
 * Цена. Список контактов строится ИСКЛЮЧИТЕЛЬНО из указателя (`readContactsFor`),
 * а самолечение умеет только вычёркивать из него мёртвые ключи — дописать
 * потерянное ему нечем. Человеку показывали «Контакт «Имя» добавлен», а контакта
 * не было нигде: ни в записной книжке, ни в присутствии, ни в выборе получателя,
 * и заданное им имя пропадало вместе с записью. Навсегда, до повторного
 * добавления вручную. У неявной строки (`ensureImplicitContact`) было ещё хуже:
 * повторный заход отвечает 'exists' по быстрому проходу и до указателя не
 * доходит вовсе — незнакомец, написавший в личные, оставался невидимым списку
 * до конца жизни установки.
 *
 * Правка. Указатель пишет `scopedKvSetCheckedFor`, исход едет вызывающему.
 * `addContact` бросает — тем же способом, каким уже бросает на несостоявшейся
 * строке; строку при этом не снимает, потому что повтор добавления перезапишет
 * её поверх и попробует указатель заново. `ensureImplicitContact` откатывает
 * строку: у неё повтора «поверх» не бывает, и без отката контакт остался бы
 * невидимым навсегда.
 *
 * Границы. Указатель, урезанный самолечением (`badIds`), и удаление контакта
 * тут ни при чём: там потеря записи проходит сама — следующее чтение повторит
 * вычёркивание.
 */

/** Отказывать ли записи указателя (только ей — строка контакта пишется своей формой). */
let mockIndexWriteFails = false;

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
    kvTryGet: jest.fn(async (key: string) => ({ value: await kvGet(key) })),
    // Настоящий `kvSetChecked` отвечает `false`, когда база отказала: диск
    // переполнен, SQLITE_BUSY. Здесь отказ наводится только на указатель —
    // иначе проверялось бы не то место.
    kvSetChecked: jest.fn(async (key: string, value: string) => {
      if (mockIndexWriteFails && key.endsWith('contacts_index')) return false;
      await kvSet(key, value);
      return true;
    }),
    kvGetSecret: jest.fn(async (key: string) => kvGet(key)),
    kvGetSecretCell: jest.fn(async (key: string) => {
      const v = await kvGet(key);
      return v == null ? { state: 'absent' } : { state: 'plain', text: v };
    }),
    kvSetSecret: jest.fn(async (key: string, value: string) => {
      await kvSet(key, value);
      return true;
    }),
    profileKvGet: jest.fn(async (profileId: number, key: string) => kvGet(`p${profileId}:${key}`)),
    profileKvSet: jest.fn(async (profileId: number, key: string, value: string) =>
      kvSet(`p${profileId}:${key}`, value)),
    profileKvDelete: jest.fn(async (profileId: number, key: string) =>
      kvDelete(`p${profileId}:${key}`)),
    kvDeleteScoped: jest.fn(async (profileId: number, key: string) =>
      kvDelete(`p${profileId}:${key}`)),
    contactNoteKey: jest.fn((b64: string) => `contact_note:${b64}`),
    recentlyDeletedKey: jest.fn((b64: string) => `recently_deleted:${b64}`),
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
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  addContact,
  CONTACT_INDEX_WRITE_FAILED_MESSAGE,
  CONTACT_ROW_WRITE_FAILED_MESSAGE,
  CONTACTS_INDEX_FULL_MESSAGE,
  ensureImplicitContact,
  invalidateContactsList,
  listContactsFor,
} from '../contacts';

const mockLocal = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  kvSetSecret: jest.Mock;
};
const kv = mockLocal.__kv;

const INDEX_KEY = 'p1:contacts_index';

function makeKeyPair() {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey } as { publicKey: Uint8Array; secretKey: Uint8Array };
}

function b64(k: Uint8Array): string {
  return Buffer.from(k).toString('base64');
}

function rowOf(peer: Uint8Array): string | undefined {
  return kv[`p1:contact:${b64(peer)}`];
}

function indexNow(): string[] {
  const raw = kv[INDEX_KEY];
  return raw === undefined ? [] : (JSON.parse(raw) as string[]);
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const CONTACTS_SRC = codeOnly(readFileSync(join(__dirname, '..', 'contacts.ts'), 'utf8'));
const LOCAL_SRC = codeOnly(readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8'));

let me: ReturnType<typeof makeKeyPair>;
let peer: ReturnType<typeof makeKeyPair>;

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockIndexWriteFails = false;
  mockLocal.kvSetSecret.mockClear();
  invalidateContactsList();
  me = makeKeyPair();
  peer = makeKeyPair();
});

describe('несостоявшийся указатель не выдаётся за добавленный контакт', () => {
  test('addContact при отказе указателя отказывает, а не молчит', async () => {
    mockIndexWriteFails = true;

    await expect(addContact(me, peer.publicKey, 'Аня')).rejects.toThrow(
      CONTACT_INDEX_WRITE_FAILED_MESSAGE,
    );
  });

  test('и контакта в списке действительно нет — отказ был правдой', async () => {
    mockIndexWriteFails = true;

    await expect(addContact(me, peer.publicKey, 'Аня')).rejects.toThrow();

    expect(await listContactsFor(1)).toEqual([]);
    expect(indexNow()).toEqual([]);
  });

  test('имя и ключ не потеряны: повтор при исправной базе доводит дело до конца', async () => {
    mockIndexWriteFails = true;
    await expect(addContact(me, peer.publicKey, 'Аня')).rejects.toThrow();
    // Строку не снимаем — в ней лежит и symKey, и заданное человеком имя.
    expect(rowOf(peer.publicKey)).toBeDefined();

    mockIndexWriteFails = false;
    invalidateContactsList();
    await expect(addContact(me, peer.publicKey, 'Аня')).resolves.toBeUndefined();

    const list = await listContactsFor(1);
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('Аня');
  });

  test('переполненный указатель тоже отказ, и сказано про переполнение', async () => {
    kv[INDEX_KEY] = JSON.stringify(Array.from({ length: 5000 }, (_, i) => `ключ${i}`));

    await expect(addContact(me, peer.publicKey, 'Аня')).rejects.toThrow(
      CONTACTS_INDEX_FULL_MESSAGE,
    );
  });

  test('неявная строка при отказе указателя откатывается, а не остаётся невидимой', async () => {
    mockIndexWriteFails = true;

    expect(await ensureImplicitContact(1, me, peer.publicKey)).toBe('failed');
    // Без отката быстрый проход следующего захода ответил бы 'exists', и
    // указатель не получил бы ключ уже никогда.
    expect(rowOf(peer.publicKey)).toBeUndefined();
  });

  test('следующее письмо от того же незнакомца заводит контакт заново', async () => {
    mockIndexWriteFails = true;
    expect(await ensureImplicitContact(1, me, peer.publicKey)).toBe('failed');

    mockIndexWriteFails = false;
    invalidateContactsList();
    expect(await ensureImplicitContact(1, me, peer.publicKey)).toBe('created');
    expect(indexNow()).toEqual([b64(peer.publicKey)]);
    expect(await listContactsFor(1)).toHaveLength(1);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Осторожность на отказе не должна превращаться в отказ на исправной базе:
 * добавление контакта — ручное действие, и лишний отказ здесь человек прочитает
 * как сломанную кнопку.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: исправная база работает как прежде', () => {
  test('addContact при исправной базе не бросает и кладёт контакт в список', async () => {
    await expect(addContact(me, peer.publicKey, 'Аня')).resolves.toBeUndefined();

    expect(indexNow()).toEqual([b64(peer.publicKey)]);
    const list = await listContactsFor(1);
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('Аня');
  });

  test('повторное добавление того же ключа по-прежнему проходит без отказа', async () => {
    await addContact(me, peer.publicKey, 'Аня');
    invalidateContactsList();
    await expect(addContact(me, peer.publicKey, 'Аня Ж.')).resolves.toBeUndefined();

    expect(indexNow()).toEqual([b64(peer.publicKey)]);
    expect((await listContactsFor(1))[0].displayName).toBe('Аня Ж.');
  });

  test('ensureImplicitContact при исправной базе заводит строку и указатель', async () => {
    expect(await ensureImplicitContact(1, me, peer.publicKey)).toBe('created');

    expect(rowOf(peer.publicKey)).toBeDefined();
    expect(indexNow()).toEqual([b64(peer.publicKey)]);
    expect(await ensureImplicitContact(1, me, peer.publicKey)).toBe('exists');
  });

  test('прежний отказ записи строки не подменён новым словом', async () => {
    mockLocal.kvSetSecret.mockImplementationOnce(async () => false);

    await expect(addContact(me, peer.publicKey, 'Аня')).rejects.toThrow(
      CONTACT_ROW_WRITE_FAILED_MESSAGE,
    );
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Правка держится на том, что общая форма записи по-прежнему немая: пока
 * `kvSet` гасит отказ и отдаёт void, указателю нужна именно проверенная форма.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: общая запись по-прежнему молчит об отказе', () => {
  test('profileKvSet ведёт в немой kvSet', () => {
    expect(LOCAL_SRC).toContain(
      'export async function profileKvSet(profileId: number, key: string, value: string): Promise<void> {',
    );
    expect(LOCAL_SRC).toContain('return kvSet(profileScopedKey(profileId, key), value);');
  });

  test('список контактов строится только из указателя — потерянную запись взять неоткуда', () => {
    expect(CONTACTS_SRC).toContain("await scopedKvTryGetFor(pid, 'contacts_index')");
    // Самолечение умеет вычёркивать, а дописывать — нет.
    expect(CONTACTS_SRC).toContain('badIds');
  });

  test('вторая половина правки: чем указатель пишется и кто на это смотрит', () => {
    expect(CONTACTS_SRC).toContain(
      "if (!(await scopedKvSetCheckedFor(pid, 'contacts_index', JSON.stringify([...ids])))) {",
    );
    expect(CONTACTS_SRC).toContain('const indexed = await rememberContactIdUnlocked(pid, b64);');
    expect(CONTACTS_SRC).toContain("if (indexed === 'full') throw new Error(CONTACTS_INDEX_FULL_MESSAGE);");
    expect(CONTACTS_SRC).toContain(
      "if (indexed === 'failed') throw new Error(CONTACT_INDEX_WRITE_FAILED_MESSAGE);",
    );
    expect(CONTACTS_SRC).toContain("if ((await rememberContactIdUnlocked(pid, b64)) !== 'ok') {");
  });
});
