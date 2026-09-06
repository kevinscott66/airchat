/**
 * Ключ к локальным данным заводится один раз, а не по одному на вызов (v4.32.615).
 *
 * Дефект. Между чтением хранилища и записью выбранного ключа в
 * `getOrCreateDataEncryptionKey` стоят несколько await, а зовут её из сотни
 * мест. На первом запуске два параллельных вызова успевали оба решить «ключа
 * нет» и сгенерировать РАЗНЫЕ случайные ключи: часть строк уезжала под первый,
 * часть под второй, канарейка оставалась от третьего сочетания — и следующий
 * запуск отказывался открывать базу (`stored_does_not_match_data`).
 */
const mockStore = new Map<string, string>();
const mockReads: string[] = [];
const mockWrites: string[] = [];
let mockThrowOnDekRead = false;

/** Каждое обращение к хранилищу уступает поток — иначе гонки не случается. */
const mockYield = () => new Promise((r) => setImmediate(r));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: async (k: string) => {
    await mockYield();
    mockReads.push(k);
    if (mockThrowOnDekRead && k === 'airchat_local_dek_v1') throw new Error('keychain busy');
    return mockStore.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    await mockYield();
    mockWrites.push(k);
    mockStore.set(k, v);
  },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
  isAvailableAsync: async () => true,
}));

jest.mock('../../backup/seedPhrase', () => ({ getStoredMnemonic: async () => null }));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  DEK_KEY,
  clearDekMemory,
  setDekMemory,
  getOrCreateDataEncryptionKey,
} from '../localEncryption';

const hex = (a: Uint8Array) => Buffer.from(a).toString('hex');
const dekWrites = () => mockWrites.filter((k) => k === DEK_KEY).length;

beforeEach(() => {
  mockStore.clear();
  mockReads.length = 0;
  mockWrites.length = 0;
  mockThrowOnDekRead = false;
  clearDekMemory();
});

describe('DEK: параллельные вызовы складываются в один', () => {
  it('на чистой установке пять вызовов получают ОДИН ключ', async () => {
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => getOrCreateDataEncryptionKey()));
    const first = hex(all[0]);
    expect(all.map(hex)).toEqual([first, first, first, first, first]);
  });

  it('и заводится он ровно один раз', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => getOrCreateDataEncryptionKey()));
    expect(dekWrites()).toBe(1);
  });

  it('в хранилище лежит ровно тот ключ, который раздали', async () => {
    const [dek] = await Promise.all([
      getOrCreateDataEncryptionKey(),
      getOrCreateDataEncryptionKey(),
    ]);
    const stored = new Uint8Array(Buffer.from(mockStore.get(DEK_KEY) as string, 'base64'));
    expect(hex(stored)).toBe(hex(dek));
  });

  it('последовательные вызовы после первого хранилище не трогают', async () => {
    await getOrCreateDataEncryptionKey();
    mockReads.length = 0;
    await getOrCreateDataEncryptionKey();
    expect(mockReads).toEqual([]);
  });
});

describe('DEK: склейка не кэширует отказ', () => {
  it('оба параллельных вызова получают один и тот же отказ', async () => {
    mockStore.set('airchat_local_dek_canary_v1', 'enc2:whatever');
    mockThrowOnDekRead = true;
    const results = await Promise.allSettled([
      getOrCreateDataEncryptionKey(),
      getOrCreateDataEncryptionKey(),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('после отказа следующий вызов читает хранилище заново', async () => {
    mockStore.set('airchat_local_dek_canary_v1', 'enc2:whatever');
    mockThrowOnDekRead = true;
    await expect(getOrCreateDataEncryptionKey()).rejects.toThrow();
    mockThrowOnDekRead = false;
    mockStore.delete('airchat_local_dek_canary_v1');
    mockReads.length = 0;

    const dek = await getOrCreateDataEncryptionKey();
    expect(dek.length).toBe(32);
    expect(mockReads).toContain(DEK_KEY);
  });
});

describe('DEK: смена ключа во время чтения не отменяется', () => {
  it('setDekMemory посреди вызова остаётся в силе', async () => {
    const known = new Uint8Array(32).fill(7);
    const inflight = getOrCreateDataEncryptionKey();
    await mockYield();
    setDekMemory(known);
    await inflight;

    expect(hex(await getOrCreateDataEncryptionKey())).toBe(hex(known));
  });

  it('clearDekMemory посреди вызова не оставляет старый ключ в памяти', async () => {
    const inflight = getOrCreateDataEncryptionKey();
    await mockYield();
    clearDekMemory();
    const created = await inflight;
    mockReads.length = 0;

    // Ключ в памяти не восстановлен — следующий вызов идёт в хранилище.
    const next = await getOrCreateDataEncryptionKey();
    expect(mockReads).toContain(DEK_KEY);
    expect(hex(next)).toBe(hex(created));
  });
});

describe('храповик: работа вынесена из склеивающей обёртки', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'localEncryption.ts'), 'utf8'
  ) as string;
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const bodyOf = (head: string): string => {
    const i = CODE.indexOf(head);
    expect(i).toBeGreaterThan(-1);
    return CODE.slice(i, CODE.indexOf('\n}\n', i));
  };

  it('обёртка только раздаёт обещание', () => {
    const body = bodyOf('export function getOrCreateDataEncryptionKey(');
    expect(body).toContain('dekInflight');
    expect(body).not.toContain('observeStoredDek');
    expect(body).not.toContain('decideDek(');
  });

  it('работа живёт отдельно и сверяет поколение перед записью в память', () => {
    const body = bodyOf('async function resolveDataEncryptionKey(');
    expect(body).toContain('await observeStoredDek()');
    expect(body).toContain('dekGeneration === gen');
  });

  it('сбросы памяти снимают и обещание', () => {
    for (const head of ['export function setDekMemory(', 'export function clearDekMemory(']) {
      const body = bodyOf(head);
      expect(body).toContain('dekGeneration += 1');
      expect(body).toContain('dekInflight = null');
    }
  });
});
