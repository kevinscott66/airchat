/**
 * Канарейка без шифрования не открывается ничем (v4.32.619).
 *
 * Дефект. `canaryOpens` спрашивала у `tryDecryptAtRest`, совпадает ли
 * содержимое канарейки с `CANARY_PLAINTEXT`. Но `tryDecryptAtRest` отдаёт
 * значение БЕЗ префикса `enc2:` как есть — расшифровывать там нечего. Значит
 * открытая строка `airchat-dek-canary-v1`, положенная в SecureStore (на вебе —
 * в IndexedDB, где она доступна любому скрипту того же origin), совпадала с
 * `CANARY_PLAINTEXT` при ЛЮБОМ ключе-кандидате.
 *
 * Канарейка — единственное доказательство того, что ключ и данные — одна пара.
 * Доказательство, которое проходит без ключа, доказательством не является:
 * весь разбор в `dekPolicy` сводился к одной общеизвестной строке, и любой
 * случайно выведенный ключ объявлялся «тем самым» — а база под ним читается
 * пустыми строками, и первая же запись кладёт эту пустоту поверх настоящего
 * шифртекста.
 *
 * Набор поведенческий: канарейка подкладывается в хранилище, дальше спрашивают
 * `canaryOpensWith` — как это делает миграция ключа в local.ts.
 */
const mockStore = new Map<string, string>();

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
  isAvailableAsync: async () => true,
}));

jest.mock('../../backup/seedPhrase', () => ({ getStoredMnemonic: async () => null }));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  DEK_CANARY_KEY,
  AT_REST_PREFIX,
  canaryOpensWith,
  clearDekMemory,
  encryptAtRestString,
} from '../localEncryption';

/** Та же константа, что и в модуле: тест подкладывает её открытым текстом. */
const CANARY_PLAINTEXT = 'airchat-dek-canary-v1';

const KEY_A = new Uint8Array(32).fill(7);
const KEY_B = new Uint8Array(32).fill(9);

beforeEach(() => {
  mockStore.clear();
  clearDekMemory();
});

describe('канарейку нельзя подделать открытым текстом', () => {
  it('проверка не пустая: честная канарейка своим ключом открывается', async () => {
    mockStore.set(DEK_CANARY_KEY, encryptAtRestString(CANARY_PLAINTEXT, KEY_A));
    await expect(canaryOpensWith(KEY_A)).resolves.toBe(true);
  });

  it('проверка не пустая: честная канарейка чужим ключом не открывается', async () => {
    mockStore.set(DEK_CANARY_KEY, encryptAtRestString(CANARY_PLAINTEXT, KEY_A));
    await expect(canaryOpensWith(KEY_B)).resolves.toBe(false);
  });

  it('подложенная открытая константа не открывается ни одним ключом', async () => {
    mockStore.set(DEK_CANARY_KEY, CANARY_PLAINTEXT);
    await expect(canaryOpensWith(KEY_A)).resolves.toBe(false);
    await expect(canaryOpensWith(KEY_B)).resolves.toBe(false);
  });

  it('мусор без префикса тоже не открывается', async () => {
    mockStore.set(DEK_CANARY_KEY, 'что угодно');
    await expect(canaryOpensWith(KEY_A)).resolves.toBe(false);
  });

  it('своя запись префикс несёт всегда — честную канарейку правило не задевает', () => {
    expect(encryptAtRestString(CANARY_PLAINTEXT, KEY_A).startsWith(AT_REST_PREFIX)).toBe(true);
    expect(encryptAtRestString('', KEY_A).startsWith(AT_REST_PREFIX)).toBe(true);
  });
});
