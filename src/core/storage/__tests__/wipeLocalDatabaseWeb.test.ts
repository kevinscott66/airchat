/**
 * Снос локальной базы в браузере (v4.32.603).
 *
 * На web у базы нет файлов: expo-sqlite держит её в OPFS, а
 * expo-file-system там — заглушка, у которой `documentDirectory === null`, а
 * `getInfoAsync` бросает `UnavailabilityError`. Прежний код всё равно собирал
 * пути и проверял ими результат — то есть спрашивал у отсутствующей файловой
 * системы, исчез ли отсутствующий файл, получал исключение и объявлял базу
 * неудалённой. Само удаление при этом проходило: `deleteDatabaseAsync` на web
 * поддержан.
 *
 * Цена ошибки не в тексте лога: `wipeLocalDatabase` вызывается из сброса
 * кошелька, и его шаг `local_db` в браузере не завершался успехом никогда.
 */
let mockDeleteFails = 0;
const mockDeleted: string[] = [];
let mockDocumentDirectory: string | null = null;
/** Файлы, которые «остались» после удаления (проверяются только там, где файлы есть). */
let mockExistingFiles = new Set<string>();

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async (name: string) => {
    if (mockDeleteFails > 0) {
      mockDeleteFails -= 1;
      throw new Error('database is locked');
    }
    mockDeleted.push(name);
  }),
}));

jest.mock('expo-file-system/legacy', () => ({
  get documentDirectory(): string | null {
    return mockDocumentDirectory;
  },
  getInfoAsync: jest.fn(async (uri: string) => {
    // Ровно то, что делает заглушка expo-file-system в браузере.
    if (mockDocumentDirectory === null) {
      throw new Error("The method or property getInfoAsync is not available on web");
    }
    return { exists: mockExistingFiles.has(uri) };
  }),
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

import { wipeLocalDatabase } from '../local';

beforeEach(() => {
  mockDeleteFails = 0;
  mockDeleted.length = 0;
  mockDocumentDirectory = null;
  mockExistingFiles = new Set<string>();
});

describe('wipeLocalDatabase', () => {
  it('в браузере доводит снос до конца, хотя файлов проверить нечем', async () => {
    await expect(wipeLocalDatabase()).resolves.toBeUndefined();
    expect(mockDeleted.length).toBeGreaterThan(0);
  });

  it('в браузере отказ удаления остаётся отказом', async () => {
    // Обратная сторона: раз проверять нечем, единственный факт — прошло ли
    // само удаление. Молча считать неудачу успехом нельзя.
    mockDeleteFails = 99;

    await expect(wipeLocalDatabase()).rejects.toThrow('Локальная база не удалена');
    expect(mockDeleted).toEqual([]);
  });

  it('в браузере разовый сбой добивается второй попыткой', async () => {
    mockDeleteFails = 1;

    await expect(wipeLocalDatabase()).resolves.toBeUndefined();
    expect(mockDeleted.length).toBe(1);
  });

  it('на устройстве проверка файлов остаётся: уцелевший файл — это отказ', async () => {
    // Правка не должна была ослабить нативную ветку: там файлы есть, и
    // «удалили» без проверки — то самое утверждение, которому верить нельзя.
    mockDocumentDirectory = 'file:///data/';
    mockExistingFiles.add('file:///data/SQLite/airchat_local.db-wal');

    await expect(wipeLocalDatabase()).rejects.toThrow('Локальная база не удалена');
  });

  it('на устройстве чистый каталог — это успех', async () => {
    mockDocumentDirectory = 'file:///data/';

    await expect(wipeLocalDatabase()).resolves.toBeUndefined();
    expect(mockDeleted.length).toBe(1);
  });
});
