/**
 * Нечитаемая запись веб-хранилища — не отсутствующая (AC-03).
 *
 * Дефект. `getItemAsync` веб-реализации отвечал `null` и на «записи нет», и
 * на «запись не того формата», и на любой сбой расшифровки. Вызывающий код
 * (keyManager, seedPhrase, syncApi) различает `absent` и `unreadable` именно
 * по наличию строки, так что порча шифротекста превращалась в «ключей нет» —
 * и дальше в новую личность поверх старой.
 *
 * Контракт теперь как у нативного expo-secure-store: `null` — только
 * отсутствие; запись, которая есть, но не открылась, —
 * `SecureStoreUnreadableError` с ключом и причиной. Шифротекст при этом не
 * трогается.
 */
import { webcrypto } from 'crypto';
import { createFakeIndexedDb, type FakeIndexedDb } from './fakeIndexedDb';
import { isSecureStoreUnreadable, SecureStoreUnreadableError } from '../secureStoreErrors';

type WebStore = typeof import('../secureStoreQueued.web');

const g = globalThis as unknown as Record<string, unknown>;
let fake: FakeIndexedDb;
let store: WebStore;

if (typeof globalThis.crypto?.subtle === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

function freshModule(): WebStore {
  let mod!: WebStore;
  jest.isolateModules(() => {
    mod = require('../secureStoreQueued.web') as WebStore;
  });
  return mod;
}

beforeEach(() => {
  fake = createFakeIndexedDb();
  g.indexedDB = fake.factory;
  store = freshModule();
});

afterAll(() => {
  delete g.indexedDB;
});

async function expectUnreadable(p: Promise<unknown>, key: string, reason: SecureStoreUnreadableError['reason']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(isSecureStoreUnreadable(err)).toBe(true);
  expect(err).toMatchObject({ name: 'SecureStoreUnreadableError', key, reason });
}

describe('отсутствие', () => {
  it('записи нет — null, а не ошибка', async () => {
    await store.setItemAsync('other', 'x');
    expect(await store.getItemAsync('missing')).toBeNull();
  });

  it('после deleteItemAsync — снова null', async () => {
    await store.setItemAsync('k', 'v');
    await store.deleteItemAsync('k');
    expect(await store.getItemAsync('k')).toBeNull();
  });

  it('целая запись читается как есть', async () => {
    await store.setItemAsync('k', 'значение');
    expect(await freshModule().getItemAsync('k')).toBe('значение');
  });
});

describe('неверный формат', () => {
  it.each<[string, unknown]>([
    ['строка', 'garbage'],
    ['null', null],
    ['без iv', { data: new ArrayBuffer(16) }],
    ['iv не буфер', { iv: 'abc', data: new ArrayBuffer(16) }],
    ['iv не той длины', { iv: new ArrayBuffer(4), data: new ArrayBuffer(16) }],
  ])('%s — типизированная ошибка malformed, запись на месте', async (_label, value) => {
    await store.setItemAsync('seed', 'words');
    fake.raw('entries').set('seed', value);
    await expectUnreadable(store.getItemAsync('seed'), 'seed', 'malformed');
    expect(fake.raw('entries').get('seed')).toBe(value);
  });

  it('ключ в ошибке — без пространства имён, как его передал вызывающий', async () => {
    await store.setItemAsync('warmup', '1');
    fake.raw('entries').set('svc airchat_x', 'garbage');
    await expectUnreadable(store.getItemAsync('airchat_x', { keychainService: 'svc' }), 'airchat_x', 'malformed');
  });
});

describe('повреждённый шифротекст', () => {
  it('сбой расшифровки — decrypt_failed, шифротекст не удалён и не переписан', async () => {
    await store.setItemAsync('pwd', '{"v":1}');
    const entry = fake.raw('entries').get('pwd') as { iv: ArrayBuffer; data: ArrayBuffer };
    const bytes = new Uint8Array(entry.data);
    bytes[0] ^= 0xff;
    const snapshot = Buffer.from(bytes).toString('hex');

    const reader = freshModule();
    await expectUnreadable(reader.getItemAsync('pwd'), 'pwd', 'decrypt_failed');
    // Повторное чтение — та же ошибка, а не «теперь пусто».
    await expectUnreadable(reader.getItemAsync('pwd'), 'pwd', 'decrypt_failed');
    expect(fake.raw('entries').get('pwd')).toBe(entry);
    expect(Buffer.from(new Uint8Array(entry.data)).toString('hex')).toBe(snapshot);
  });

  it('мастер-ключ пропал — master_key_unusable, и чтение не заводит новый', async () => {
    await store.setItemAsync('sk', 'secret');
    fake.raw('master').clear();
    await expectUnreadable(freshModule().getItemAsync('sk'), 'sk', 'master_key_unusable');
    expect(fake.raw('master').size).toBe(0);
    expect(fake.raw('entries').has('sk')).toBe(true);
  });

  it('мастер-ключ испорчен — master_key_unusable, и его не перезаписывает даже запись', async () => {
    await store.setItemAsync('sk', 'secret');
    fake.raw('master').set('aes-gcm-v1', { junk: true });
    const tab = freshModule();
    await expectUnreadable(tab.getItemAsync('sk'), 'sk', 'master_key_unusable');
    await expect(tab.setItemAsync('other', 'x')).rejects.toThrow('secure_store_master_key_malformed');
    expect(fake.raw('master').get('aes-gcm-v1')).toEqual({ junk: true });
  });

  it('одна порченая запись не мешает читать соседние', async () => {
    await store.setItemAsync('a', 'A');
    await store.setItemAsync('b', 'B');
    fake.raw('entries').set('a', 'garbage');
    await expectUnreadable(store.getItemAsync('a'), 'a', 'malformed');
    expect(await store.getItemAsync('b')).toBe('B');
  });
});

describe('isSecureStoreUnreadable', () => {
  it('узнаёт ошибку и из другого экземпляра модуля', () => {
    let Other!: typeof SecureStoreUnreadableError;
    jest.isolateModules(() => {
      Other = (require('../secureStoreErrors') as typeof import('../secureStoreErrors')).SecureStoreUnreadableError;
    });
    expect(Other).not.toBe(SecureStoreUnreadableError);
    expect(isSecureStoreUnreadable(new Other('k', 'malformed'))).toBe(true);
  });

  it('обычную ошибку за нечитаемую запись не принимает', () => {
    expect(isSecureStoreUnreadable(new Error('boom'))).toBe(false);
    expect(isSecureStoreUnreadable(null)).toBe(false);
  });
});
