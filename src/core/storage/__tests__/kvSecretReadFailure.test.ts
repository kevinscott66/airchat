/**
 * Несостоявшееся чтение — не «записи нет» (v4.32.615).
 *
 * kvGetSecretCell заведён ради различения трёх состояний, и его же docblock
 * говорит: не открыв запись, разрешать её перезапись нельзя. Но читал он через
 * kvGet, а тот сводит отказ базы к тому же null, что и отсутствие строки.
 *
 * Цена ошибки конкретная: kvUpdateSecretScoped получал «пусто», вызывающий
 * собирал корзину «недавно удалённые» (30 дней в переписке, 7 в группе) или
 * заметку о контакте с чистого листа, и получившееся ложилось поверх целой
 * прежней записи. Заблокированной базы на секунду хватало, чтобы стереть
 * месяц.
 */
let mockReadFails = false;
const mockWrites: Array<[string, string]> = [];
const KEY_MARK = 'secret_read_failure_probe';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      if (/INTO kv/i.test(sql) && Array.isArray(params)) {
        mockWrites.push([String(params[0]), String(params[1])]);
      }
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (_sql: string, params?: unknown[]) => {
      // Отказ ровно на своих ключах: уронить любое чтение значит уронить и
      // раскладку базы при первом обращении, а речь не о ней.
      if (mockReadFails && Array.isArray(params) && String(params[0]).includes(KEY_MARK)) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return null;
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
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
  readAtRestCell: jest.fn((stored: string | null) =>
    stored == null ? { state: 'absent' } : { state: 'plain', text: stored.replace('enc2:', '') }
  ),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { kvGetSecretCell, kvUpdateSecretScoped, recentlyDeletedKey } from '../local';

beforeEach(() => {
  mockReadFails = false;
  mockWrites.length = 0;
});

describe('отказ базы не выдаётся за пустую запись', () => {
  it('kvGetSecretCell отвечает unreadable, а не absent', async () => {
    mockReadFails = true;
    expect(await kvGetSecretCell(KEY_MARK)).toEqual({ state: 'unreadable' });
  });

  it('строки просто нет — по-прежнему absent', async () => {
    expect(await kvGetSecretCell(KEY_MARK)).toEqual({ state: 'absent' });
  });

  it('корзина не переписывается поверх непрочитанной', async () => {
    mockReadFails = true;
    const seen: Array<string | null> = [];
    const res = await kvUpdateSecretScoped(1, recentlyDeletedKey(KEY_MARK), (current) => {
      seen.push(current);
      return JSON.stringify([{ id: 'm1' }]);
    });
    expect(res).toBe('unreadable');
    // Вызывающего даже не спросили: спрашивать «что дописать» к тому, чего мы
    // не прочитали, значит получить ответ «всё заново».
    expect(seen).toEqual([]);
    expect(mockWrites).toEqual([]);
  });

  it('на живой базе дописывание работает как прежде', async () => {
    const res = await kvUpdateSecretScoped(1, recentlyDeletedKey(KEY_MARK), (current) => {
      expect(current).toBeNull();
      return JSON.stringify([{ id: 'm1' }]);
    });
    expect(res).toBe('written');
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0][0]).toBe(`p1:${recentlyDeletedKey(KEY_MARK)}`);
  });
});

describe('чтение идёт через различающий отказ вариант', () => {
  const SRC = readFileSync(join(__dirname, '..', 'local.ts'), 'utf8');
  const body = SRC.slice(
    SRC.indexOf('export async function kvGetSecretCell('),
    SRC.indexOf('export async function kvGetSecret(')
  );

  it('kvGetSecretCell не зовёт kvGet', () => {
    expect(body).toContain('await kvTryGet(key)');
    expect(body).not.toContain('await kvGet(key)');
  });
});
