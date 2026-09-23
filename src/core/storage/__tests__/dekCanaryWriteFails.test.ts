/**
 * Отказ канарейки останавливает запись ключа (v4.32.724).
 *
 * Дефект. `persistDek` кладёт в Keychain две записи подряд — сперва канарейку,
 * потом сам ключ, — и порядок этот выбран нарочно (v4.32.617): обрыв между
 * ними должен оставлять установку поправимой. Но отказ ПЕРВОЙ записи
 * проглатывался (`writeCanary` ловит и возвращает null), и управление шло
 * дальше — во вторую. Получалось ровно то состояние «ключ первым», против
 * которого порядок и переставляли.
 *
 * Чем это кончается. Keychain на запирающемся устройстве отвечает «User
 * interaction is not allowed» не всей сессии, а конкретной операции: одна
 * запись отвергнута, следующая проходит. Значит на диске остаются данные под
 * новым ключом, в хранилище новый ключ, а канарейка — от старого. Ни один из
 * двух ключей её не открывает: следующий запуск отвечает
 * `stored_does_not_match_data` и отказывается открыть базу — на каждом запуске,
 * навсегда, хотя данные целы и верный ключ лежит рядом. Спасает только
 * переустановка, то есть потеря всей переписки.
 *
 * Поэтому канарейка снова становится условием: не легла она — не ложится и
 * ключ, а вызывающий получает отказ значением и решает сам (см. пины на
 * миграцию в dekCanary.test.ts).
 */
const mockStore = new Map<string, string>();
let mockThrowOnCanaryWrite = false;

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    if (mockThrowOnCanaryWrite && k === 'airchat_local_dek_canary_v1') {
      throw new Error('User interaction is not allowed');
    }
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
  persistDek,
  getOrCreateDataEncryptionKey,
} from '../localEncryption';

const hex = (a: Uint8Array) => Buffer.from(a).toString('hex');

const OLD = new Uint8Array(32).fill(3);
const NEW = new Uint8Array(32).fill(9);

/** Установка до вызова: ключ и канарейка от OLD, он же в памяти. */
async function installedWithOldKey(): Promise<void> {
  mockStore.set(DEK_KEY, Buffer.from(OLD).toString('base64'));
  await persistDek(OLD);
  clearDekMemory();
  setDekMemory(OLD);
}

beforeEach(() => {
  mockStore.clear();
  mockThrowOnCanaryWrite = false;
  clearDekMemory();
});

describe('persistDek: канарейка легла', () => {
  it('отвечает успехом', async () => {
    expect(await persistDek(NEW)).toBe(true);
  });

  it('ключ в хранилище — тот самый', async () => {
    await persistDek(NEW);
    expect(mockStore.get(DEK_KEY)).toBe(Buffer.from(NEW).toString('base64'));
  });

  it('канарейка открывается им же', async () => {
    await persistDek(NEW);
    expect(await canaryOpensWith(NEW)).toBe(true);
  });

  it('ключ становится действующим в памяти', async () => {
    await persistDek(NEW);
    expect(hex(await getOrCreateDataEncryptionKey())).toBe(hex(NEW));
  });
});

describe('persistDek: канарейка не легла', () => {
  it('отвечает отказом, а не исключением', async () => {
    await installedWithOldKey();
    mockThrowOnCanaryWrite = true;
    await expect(persistDek(NEW)).resolves.toBe(false);
  });

  it('ключ в хранилище остаётся прежним', async () => {
    await installedWithOldKey();
    mockThrowOnCanaryWrite = true;
    await persistDek(NEW);
    // Здесь и был дефект: новый ключ ложился поверх старого рядом с канарейкой
    // от старого — сочетание, которое не открывает базу уже никогда.
    expect(mockStore.get(DEK_KEY)).toBe(Buffer.from(OLD).toString('base64'));
  });

  it('ключ и канарейка остаются парой — иначе база не откроется никогда', async () => {
    await installedWithOldKey();
    mockThrowOnCanaryWrite = true;
    await persistDek(NEW);
    // Единственная проверка, которую делает следующий запуск: открывает ли
    // канарейку ключ из хранилища. Расходились они — `stored_does_not_match_data`.
    const stored = new Uint8Array(Buffer.from(mockStore.get(DEK_KEY) as string, 'base64'));
    expect(await canaryOpensWith(stored)).toBe(true);
    expect(await canaryOpensWith(NEW)).toBe(false);
  });

  it('действующим ключом новый не становится', async () => {
    await installedWithOldKey();
    mockThrowOnCanaryWrite = true;
    await persistDek(NEW);
    expect(hex(await getOrCreateDataEncryptionKey())).toBe(hex(OLD));
  });

  it('на чистой установке не остаётся ни ключа, ни канарейки', async () => {
    mockThrowOnCanaryWrite = true;
    expect(await persistDek(NEW)).toBe(false);
    expect(mockStore.has(DEK_KEY)).toBe(false);
    expect(mockStore.has(DEK_CANARY_KEY)).toBe(false);
  });

  it('следующая попытка проходит целиком: отказ Keychain — не приговор', async () => {
    mockThrowOnCanaryWrite = true;
    await persistDek(NEW);
    mockThrowOnCanaryWrite = false;
    expect(await persistDek(NEW)).toBe(true);
    expect(await canaryOpensWith(NEW)).toBe(true);
    expect(mockStore.get(DEK_KEY)).toBe(Buffer.from(NEW).toString('base64'));
  });
});
