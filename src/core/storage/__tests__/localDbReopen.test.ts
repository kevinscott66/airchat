/**
 * Неудачная попытка открыть базу не должна убивать хранилище до перезапуска
 * (v4.32.436).
 *
 * Ссылка на открытие лежит в модульном поле. Раньше туда попадал и отказ:
 * если первое обращение к базе случилось в неудачный момент (база ещё занята
 * прошлым процессом, миграция споткнулась), то отказ оставался в поле навсегда
 * и каждое следующее обращение получало его же. Снаружи это не похоже на
 * ошибку: kvGet отдаёт null, kvSetChecked — false, переписки пусты, ничего не
 * сохраняется, и всё молча. Помогал только перезапуск приложения.
 *
 * Проверки идут по порядку: модульное состояние общее, и вторая проверка
 * опирается на отказ из первой — как и в жизни.
 */
let mockFailNextOpens = 0;
let mockNow = 1_000_000;
const mockOpenAttempts: string[] = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async (name: string) => {
    mockOpenAttempts.push(name);
    if (mockFailNextOpens > 0) {
      mockFailNextOpens -= 1;
      throw new Error('database is locked');
    }
    return {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
      getAllAsync: jest.fn(async () => []),
      getFirstAsync: jest.fn(async () => null),
      withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
      closeAsync: jest.fn(async () => undefined),
    };
  }),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: null,
  getInfoAsync: jest.fn(async () => ({ exists: false })),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
  encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
  decryptAtRestString: jest.fn((v: string) => v.replace('enc2:', '')),
  decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : v.replace('enc2:', ''))),
  isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import { ensureLocalStorageReadyForBoot, wipeLocalDatabase } from '../local';

/** Пауза между попытками (DB_REOPEN_COOLDOWN_MS в local.ts). */
const COOLDOWN_MS = 2000;

beforeAll(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('повторное открытие локальной базы', () => {
  it('первое обращение проваливается вместе с базой', async () => {
    mockFailNextOpens = 1;
    await expect(ensureLocalStorageReadyForBoot()).rejects.toThrow('database is locked');
    expect(mockOpenAttempts.length).toBe(1);
  });

  it('сразу следом база не дёргается заново — но и не молчит', async () => {
    // Пауза нужна, иначе на нерабочей базе каждое обращение прогоняло бы всю
    // цепочку миграций заново.
    await expect(ensureLocalStorageReadyForBoot()).rejects.toThrow('database is locked');
    expect(mockOpenAttempts.length).toBe(1);
  });

  it('после паузы попытка повторяется и хранилище оживает', async () => {
    mockNow += COOLDOWN_MS;
    await expect(ensureLocalStorageReadyForBoot()).resolves.toBeUndefined();
    expect(mockOpenAttempts.length).toBe(2);
  });

  it('удачное открытие запоминается: база не открывается на каждый вызов', async () => {
    mockNow += COOLDOWN_MS;
    await expect(ensureLocalStorageReadyForBoot()).resolves.toBeUndefined();
    expect(mockOpenAttempts.length).toBe(2);
  });

  it('снос базы снимает и паузу: следующая попытка идёт сразу', async () => {
    // Прошлый отказ относился к базе, которой больше нет. Выжидать нечего.
    mockFailNextOpens = 1;
    await wipeLocalDatabase();
    await expect(ensureLocalStorageReadyForBoot()).rejects.toThrow('database is locked');
    expect(mockOpenAttempts.length).toBe(3);

    // Без сноса пауза действует: база не дёргается.
    await expect(ensureLocalStorageReadyForBoot()).rejects.toThrow('database is locked');
    expect(mockOpenAttempts.length).toBe(3);

    await wipeLocalDatabase();
    await expect(ensureLocalStorageReadyForBoot()).resolves.toBeUndefined();
    expect(mockOpenAttempts.length).toBe(4);
  });
});
