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
  DEK_CANARY_KEY,
  canaryOpensWith,
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

  it('clearDekMemory посреди вызова заставляет начать заново', async () => {
    const inflight = getOrCreateDataEncryptionKey();
    await mockYield();
    clearDekMemory();
    const created = await inflight;

    // Попытка после сброса перечитала хранилище, а не дописала свой ключ
    // поверх чужой смены: чтений ключа две штуки, по одной на попытку.
    expect(mockReads.filter((k) => k === DEK_KEY).length).toBeGreaterThanOrEqual(2);
    const stored = new Uint8Array(Buffer.from(mockStore.get(DEK_KEY) as string, 'base64'));
    expect(hex(stored)).toBe(hex(created));
  });
});

/**
 * Стирание аккаунта: `performLocalWalletWipe` сбрасывает память (это поднимает
 * счётчик поколений) на несколько шагов раньше, чем удаляет ключ и канарейку
 * из SecureStore. Вызов, начавшийся до выхода из аккаунта, дописывал свои
 * значения уже ПОСЛЕ вытирания — на устройстве оставался рабочий ключ к данным
 * аккаунта, который считается стёртым.
 */
describe('DEK: стирание аккаунта посреди вызова', () => {
  const OLD = new Uint8Array(32).fill(3);

  /** Так вытирает аккаунт: сначала память, потом секреты. */
  const wipeMidFlight = () => {
    clearDekMemory();
    mockStore.delete(DEK_KEY);
    mockStore.delete(DEK_CANARY_KEY);
  };

  const startWithOldKeyAndWipe = async (): Promise<Uint8Array> => {
    mockStore.set(DEK_KEY, Buffer.from(OLD).toString('base64'));
    const inflight = getOrCreateDataEncryptionKey();
    await mockYield();
    wipeMidFlight();
    return inflight;
  };

  it('старый ключ не выдаётся как действующий', async () => {
    const dek = await startWithOldKeyAndWipe();
    expect(hex(dek)).not.toBe(hex(OLD));
  });

  it('канарейка стёртого аккаунта не восстанавливается', async () => {
    await startWithOldKeyAndWipe();
    expect(await canaryOpensWith(OLD)).not.toBe(true);
  });

  it('в хранилище не остаётся канарейки без ключа', async () => {
    const dek = await startWithOldKeyAndWipe();
    expect(mockStore.has(DEK_CANARY_KEY)).toBe(mockStore.has(DEK_KEY));
    expect(await canaryOpensWith(dek)).toBe(true);
  });

  it('ключ в хранилище совпадает с выданным', async () => {
    const dek = await startWithOldKeyAndWipe();
    const stored = new Uint8Array(Buffer.from(mockStore.get(DEK_KEY) as string, 'base64'));
    expect(hex(stored)).toBe(hex(dek));
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

  it('работа живёт отдельно, а внешняя функция её только повторяет', () => {
    const body = bodyOf('async function resolveDataEncryptionKey(');
    expect(body).toContain('resolveDekOnce(dekGeneration)');
    expect(body).toContain('DEK_RESOLVE_ATTEMPTS');
    expect(body).toContain("DekUnavailableError('dek_changed_while_resolving')");
    expect(body).not.toContain('decideDek(');
  });

  it('поколение сверяется ДО записей в хранилище, а не после них', () => {
    const body = bodyOf('async function resolveDekOnce(');
    const guard = body.indexOf('if (dekGeneration !== gen) return null;');
    expect(guard).toBeGreaterThan(-1);
    expect(body.indexOf('await SecureStore.setItemAsync(DEK_KEY')).toBeGreaterThan(guard);
    // Канарейка — тоже запись, и она тоже под проверкой.
    expect(body).toContain('decision.writeCanary && dekGeneration === gen');
  });

  it('запись, обогнанная чужой сменой ключа, снимается', () => {
    const body = bodyOf('async function resolveDekOnce(');
    expect(body).toContain('await dropOwnWrite(DEK_CANARY_KEY, wroteCanary)');
    expect(body).toContain('await dropOwnWrite(DEK_KEY, wroteKey)');
    // Стираем только СВОЁ: запись persistDek трогать нельзя.
    expect(bodyOf('async function dropOwnWrite(')).toContain(
      'await SecureStore.getItemAsync(key)) === written'
    );
  });

  it('сбросы памяти снимают и обещание', () => {
    for (const head of ['export function setDekMemory(', 'export function clearDekMemory(']) {
      const body = bodyOf(head);
      expect(body).toContain('dekGeneration += 1');
      expect(body).toContain('dekInflight = null');
    }
  });
});
