/**
 * Минимальный IndexedDB для тестов веб-хранилища ключей.
 *
 * fake-indexeddb в зависимостях нет, а от IndexedDB здесь нужно немного, но
 * это «немного» должно вести себя честно — иначе тест гонки ничего не
 * докажет:
 *
 *   - одна общая «база на диске» на все экземпляры модуля (как на одном
 *     происхождении у нескольких вкладок): `createFakeIndexedDb()` отдаёт
 *     фабрику, каждый `open` видит те же сторы;
 *   - запросы исполняются асинхронно (macrotask), а не синхронно — между
 *     транзакциями разных «вкладок» успевают вклиниться чужие await;
 *   - транзакции исполняются по одной (IndexedDB сериализует пересекающиеся
 *     readwrite; сериализовать и readonly — строже, но не мягче);
 *   - транзакция коммитится сама, когда после очередного обработчика не
 *     осталось запросов, и применяет записи разом; `add` на занятом ключе —
 *     ConstraintError, и если обработчик не вызвал `preventDefault`,
 *     транзакция откатывается целиком.
 *
 * Значения не клонируются (CryptoKey в jest клонировать нечем) — модуль под
 * тестом их и не мутирует.
 */

type Req = {
  result: unknown;
  error: { name: string; message: string } | null;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: { preventDefault(): void; stopPropagation(): void }) => void) | null;
  onupgradeneeded?: (() => void) | null;
};

type Op = { kind: 'get' | 'put' | 'add' | 'delete'; store: string; key: string; value?: unknown; req: Req };

export type FakeIdbStats = {
  /** Сколько раз `put` переписал уже существующий ключ — по сторам. */
  overwrites: Record<string, number>;
};

export type FakeIndexedDb = {
  factory: { open(name: string, version?: number): Req };
  /** Прямой доступ к «диску»: подложить порченую запись, проверить итог. */
  raw(store: string): Map<string, unknown>;
  stats: FakeIdbStats;
};

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

export function createFakeIndexedDb(): FakeIndexedDb {
  const stores = new Map<string, Map<string, unknown>>();
  const stats: FakeIdbStats = { overwrites: {} };
  let queue: Promise<void> = Promise.resolve();

  const storeOf = (name: string): Map<string, unknown> => {
    const s = stores.get(name);
    if (!s) throw new Error(`NotFoundError: no store ${name}`);
    return s;
  };

  function makeTransaction(scope: string[]) {
    const ops: Op[] = [];
    const staged = new Map<string, Map<string, unknown | typeof DELETED>>();
    const tx = {
      error: null as Req['error'],
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore(name: string) {
        if (!scope.includes(name)) throw new Error(`NotFoundError: ${name} not in scope`);
        const push = (kind: Op['kind'], key: string, value?: unknown): Req => {
          const req: Req = { result: undefined, error: null, onsuccess: null, onerror: null };
          ops.push({ kind, store: name, key, value, req });
          return req;
        };
        return {
          get: (key: string) => push('get', key),
          put: (value: unknown, key: string) => push('put', key, value),
          add: (value: unknown, key: string) => push('add', key, value),
          delete: (key: string) => push('delete', key),
        };
      },
    };

    const view = (store: string, key: string): unknown => {
      const st = staged.get(store);
      if (st?.has(key)) {
        const v = st.get(key);
        return v === DELETED ? undefined : v;
      }
      return storeOf(store).get(key);
    };
    const stage = (store: string, key: string, v: unknown) => {
      if (!staged.has(store)) staged.set(store, new Map());
      staged.get(store)!.set(key, v);
    };

    // Транзакция встаёт в общую очередь и исполняется, когда до неё дойдёт.
    queue = queue.then(async () => {
      await nextTick();
      let aborted = false;
      while (ops.length > 0 && !aborted) {
        const op = ops.shift()!;
        await nextTick();
        const { req } = op;
        if (op.kind === 'get') {
          req.result = view(op.store, op.key);
          req.onsuccess?.({ target: req });
          continue;
        }
        if (op.kind === 'add' && view(op.store, op.key) !== undefined) {
          req.error = { name: 'ConstraintError', message: 'Key already exists in the object store.' };
          let prevented = false;
          req.onerror?.({ preventDefault: () => { prevented = true; }, stopPropagation: () => undefined });
          if (!prevented) {
            tx.error = req.error;
            aborted = true;
          }
          continue;
        }
        if (op.kind === 'put' && view(op.store, op.key) !== undefined) {
          stats.overwrites[op.store] = (stats.overwrites[op.store] ?? 0) + 1;
        }
        stage(op.store, op.key, op.kind === 'delete' ? DELETED : op.value);
        req.result = op.key;
        req.onsuccess?.({ target: req });
      }
      await nextTick();
      if (aborted) {
        tx.onerror?.();
        tx.onabort?.();
        return;
      }
      for (const [store, entries] of staged) {
        const target = storeOf(store);
        for (const [k, v] of entries) {
          if (v === DELETED) target.delete(k);
          else target.set(k, v);
        }
      }
      tx.oncomplete?.();
    });
    return tx;
  }

  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => {
      stores.set(n, new Map());
    },
    transaction: (scope: string | string[], _mode?: string) =>
      makeTransaction(Array.isArray(scope) ? scope : [scope]),
  };

  const factory = {
    open(_name: string, _version?: number): Req {
      const req: Req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        if (stores.size === 0) req.onupgradeneeded?.();
        req.onsuccess?.({ target: req });
      }, 0);
      return req;
    },
  };

  return {
    factory,
    raw: (store: string) => storeOf(store),
    stats,
  };
}

const DELETED = Symbol('deleted');
