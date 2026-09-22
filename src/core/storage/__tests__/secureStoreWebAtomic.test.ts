/**
 * Мастер-ключ веб-хранилища заводится один раз на всё происхождение (AC-02).
 *
 * Дефект. `secureStoreQueued.web` заводил мастер-ключ отдельными шагами
 * `idbGet → generateKey → idbPut`, а очередь `chain` и кэш ключа жили в одном
 * экземпляре модуля. Две вкладки на пустом IndexedDB обе видели «ключа нет»,
 * обе заводили свой и обе его записывали — последний `put` вытеснял первый.
 * Записанное первой вкладкой больше не открывалось ничем: воспроизводилось
 * как `test-a=A`, `test-b=B` с двух копий модуля и `{a:null,b:"B"}` на
 * третьей.
 *
 * Здесь каждая «вкладка» — отдельный экземпляр модуля (jest.isolateModules)
 * поверх ОДНОЙ общей базы, а «перезапуск» — ещё один свежий экземпляр.
 */
import { webcrypto } from 'crypto';
import { createFakeIndexedDb, type FakeIndexedDb } from './fakeIndexedDb';

type WebStore = typeof import('../secureStoreQueued.web');

const g = globalThis as unknown as Record<string, unknown>;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let fake: FakeIndexedDb;

if (typeof globalThis.crypto?.subtle === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

function tab(): WebStore {
  let mod!: WebStore;
  jest.isolateModules(() => {
    mod = require('../secureStoreQueued.web') as WebStore;
  });
  return mod;
}

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

/** Эксклюзивная блокировка по имени — как navigator.locks, только в памяти. */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const requested: string[] = [];
  return {
    requested,
    locks: {
      request(name: string, _opts: unknown, cb: (lock: unknown) => Promise<unknown>) {
        requested.push(name);
        const prev = tails.get(name) ?? Promise.resolve();
        const run = prev.then(() => cb({ name, mode: 'exclusive' }));
        tails.set(name, run.catch(() => undefined));
        return run;
      },
    },
  };
}

beforeEach(() => {
  fake = createFakeIndexedDb();
  g.indexedDB = fake.factory;
  // По умолчанию — без navigator.locks: правильность обязана держаться на
  // транзакции, блокировка лишь экономит лишний generateKey.
  setNavigator(undefined);
});

afterAll(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  delete g.indexedDB;
});

async function writeFromTabs(count: number): Promise<void> {
  const tabs = Array.from({ length: count }, () => tab());
  await Promise.all(tabs.map((t, i) => t.setItemAsync(`test-${i}`, `V${i}`)));
}

async function readAfterRestart(count: number): Promise<(string | null)[]> {
  const restarted = tab();
  return Promise.all(Array.from({ length: count }, (_, i) => restarted.getItemAsync(`test-${i}`)));
}

describe('мастер-ключ между экземплярами модуля', () => {
  it('две вкладки на пустой базе: обе записи читаются третьей (воспроизведение из ревью)', async () => {
    const a = tab();
    const b = tab();
    await Promise.all([a.setItemAsync('test-a', 'A'), b.setItemAsync('test-b', 'B')]);
    const c = tab();
    expect({ a: await c.getItemAsync('test-a'), b: await c.getItemAsync('test-b') }).toEqual({ a: 'A', b: 'B' });
  });

  it('восемь вкладок одновременно: ровно один мастер-ключ, ничего не перезаписано', async () => {
    await writeFromTabs(8);
    expect(fake.raw('master').size).toBe(1);
    expect(fake.stats.overwrites.master ?? 0).toBe(0);
    expect(await readAfterRestart(8)).toEqual(Array.from({ length: 8 }, (_, i) => `V${i}`));
  });

  it('стресс: двадцать прогонов по шесть вкладок — ни одна запись не теряется', async () => {
    for (let round = 0; round < 20; round++) {
      fake = createFakeIndexedDb();
      g.indexedDB = fake.factory;
      await writeFromTabs(6);
      expect(await readAfterRestart(6)).toEqual(Array.from({ length: 6 }, (_, i) => `V${i}`));
      expect(fake.raw('master').size).toBe(1);
    }
  });

  it('каждая вкладка читает записи соседей и после своих записей', async () => {
    const tabs = [tab(), tab(), tab()];
    await Promise.all(tabs.map((t, i) => t.setItemAsync(`test-${i}`, `V${i}`)));
    for (const t of tabs) {
      expect(await Promise.all([0, 1, 2].map((i) => t.getItemAsync(`test-${i}`)))).toEqual(['V0', 'V1', 'V2']);
    }
  });

  it('существующий мастер-ключ не перезаписывается никем', async () => {
    await tab().setItemAsync('first', '1');
    const original = fake.raw('master').get('aes-gcm-v1');
    expect(original).toBeDefined();
    await writeFromTabs(5);
    expect(fake.raw('master').get('aes-gcm-v1')).toBe(original);
    expect(fake.stats.overwrites.master ?? 0).toBe(0);
    expect(await tab().getItemAsync('first')).toBe('1');
  });

  it('чтение на пустой базе мастер-ключ не заводит', async () => {
    expect(await tab().getItemAsync('nothing')).toBeNull();
    expect(fake.raw('master').size).toBe(0);
  });
});

describe('navigator.locks', () => {
  it('где есть — создание ключа идёт под общей блокировкой, результат тот же', async () => {
    const { locks, requested } = fakeLocks();
    setNavigator({ locks });
    await writeFromTabs(6);
    expect(requested.length).toBeGreaterThan(0);
    expect(new Set(requested)).toEqual(new Set(['airchat-secure-store-master-v1']));
    expect(fake.raw('master').size).toBe(1);
    expect(await readAfterRestart(6)).toEqual(Array.from({ length: 6 }, (_, i) => `V${i}`));
  });

  it('отказ блокировки до входа — работаем без неё', async () => {
    setNavigator({
      locks: {
        request: () => Promise.reject(Object.assign(new Error('denied'), { name: 'SecurityError' })),
      },
    });
    await writeFromTabs(4);
    expect(fake.raw('master').size).toBe(1);
    expect(await readAfterRestart(4)).toEqual(['V0', 'V1', 'V2', 'V3']);
  });
});
