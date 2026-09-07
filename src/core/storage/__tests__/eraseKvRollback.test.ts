/**
 * Провалившееся удаление корзины больше не фиксируется как успешное стирание
 * (v4.32.615).
 *
 * Дефект. eraseAtomically обещает в докблоке «либо стёрто всё, либо ROLLBACK и
 * не стёрто ничего», и держится это обещание ровно на одном — на исключении из
 * `rows`. Но внутри `rows` стояли kvDeleteScoped и kvDeleteByPrefix, а обе
 * гасят свою ошибку в log.warn и возвращаются как ни в чём не бывало. Значит,
 * при нехватке места или заблокированной базе сбой до ROLLBACK не доходил:
 * COMMIT состоялся, сообщения стёрты, а корзина «недавно удалённые» с копиями
 * их текстов пережила очистку и лежит там ещё месяц. Действие при этом
 * отчитывалось об успехе, и повторить его было нечем — стирать уже нечего.
 *
 * Стенд повторяет транзакцию честно: записи под открытым BEGIN видны только
 * после COMMIT и пропадают при ROLLBACK, а «диск полон» бросается ровно на
 * удалении kv-строки, как и было бы у настоящего SQLite.
 */
type Run = { changes: number; lastInsertRowId: number };

let mockOpen = false;
let mockStaged: string[] = [];
let mockCommitted: string[] = [];
/** Включает отказ на любом удалении kv-строки — точечно, чтобы миграции жили. */
let mockKvDeleteFails = false;

function mockExec(sql: string): void {
  const head = sql.trim().toUpperCase();
  if (head.startsWith('BEGIN')) {
    mockOpen = true;
    mockStaged = [];
    return;
  }
  if (head.startsWith('COMMIT')) {
    mockCommitted = mockCommitted.concat(mockStaged);
    mockStaged = [];
    mockOpen = false;
    return;
  }
  if (head.startsWith('ROLLBACK')) {
    mockStaged = [];
    mockOpen = false;
  }
}

/** Что именно стирает запрос — только следы, за которыми следит тест. */
function mockTagOf(sql: string): string | null {
  const one = sql.replace(/\s+/g, ' ').trim();
  if (one.startsWith('DELETE FROM chat_messages')) return 'messages';
  if (one.startsWith('DELETE FROM group_messages')) return 'group_messages';
  if (one.startsWith('DELETE FROM kv WHERE k = ?')) return 'bin';
  if (one.startsWith('DELETE FROM kv WHERE k LIKE ?')) return 'bin_prefix';
  return null;
}

function mockIsKvDelete(sql: string): boolean {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.startsWith('DELETE FROM kv WHERE k = ?') || one.startsWith('DELETE FROM kv WHERE k LIKE ?');
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async (sql: string) => {
      mockExec(sql);
    }),
    runAsync: jest.fn(async (sql: string): Promise<Run> => {
      if (mockKvDeleteFails && mockIsKvDelete(sql)) {
        throw new Error('SQLITE_FULL: database or disk is full');
      }
      const tag = mockTagOf(sql);
      if (tag) {
        if (mockOpen) mockStaged.push(tag);
        else mockCommitted.push(tag);
      }
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
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
  encryptAtRestString: jest.fn((v: string) => v),
  encryptAtRestNullable: jest.fn((v: string | null) => v),
  decryptAtRestString: jest.fn((v: string) => v),
  decryptAtRestNullable: jest.fn((v: string | null) => v),
  isAtRestCiphertext: jest.fn(() => false),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import {
  clearAllMessageHistory,
  clearChatHistory,
  kvDelete,
  kvDeleteByPrefix,
  kvDeleteByPrefixChecked,
  kvDeleteChecked,
  kvDeleteScoped,
  kvDeleteScopedChecked,
} from '../local';

/** База поднимается лениво; открываем её до того, как включён отказ. */
beforeAll(async () => {
  await kvDelete('warmup');
});

beforeEach(() => {
  mockOpen = false;
  mockStaged = [];
  mockCommitted = [];
  mockKvDeleteFails = false;
});

describe('стенд не пустой', () => {
  it('без отказа очистка переписки доходит до COMMIT', async () => {
    await clearChatHistory('peer-pub-b64', 1);
    expect(mockCommitted).toContain('messages');
    expect(mockCommitted).toContain('bin');
    expect(mockOpen).toBe(false);
  });

  it('отказ включается только на удалении kv-строки', async () => {
    mockKvDeleteFails = true;
    await expect(kvDeleteChecked('k')).rejects.toThrow('SQLITE_FULL');
  });
});

describe('очистка переписки: корзина не удалилась — не удалилось ничего', () => {
  it('вызов сообщает о провале, а не молчит', async () => {
    mockKvDeleteFails = true;
    await expect(clearChatHistory('peer-pub-b64', 1)).rejects.toThrow('SQLITE_FULL');
  });

  it('сообщения остаются на месте: транзакция откатилась', async () => {
    mockKvDeleteFails = true;
    await expect(clearChatHistory('peer-pub-b64', 1)).rejects.toThrow();
    expect(mockCommitted).not.toContain('messages');
    expect(mockCommitted).toEqual([]);
    expect(mockOpen).toBe(false);
  });

  it('после отката повтор проходит целиком', async () => {
    mockKvDeleteFails = true;
    await expect(clearChatHistory('peer-pub-b64', 1)).rejects.toThrow();
    mockKvDeleteFails = false;
    await clearChatHistory('peer-pub-b64', 1);
    expect(mockCommitted).toContain('messages');
    expect(mockCommitted).toContain('bin');
  });
});

describe('очистка всей истории: то же самое на удалении по префиксу', () => {
  it('возвращает false и не фиксирует стирание', async () => {
    mockKvDeleteFails = true;
    await expect(clearAllMessageHistory(1)).resolves.toBe(false);
    expect(mockCommitted).not.toContain('messages');
    expect(mockCommitted).not.toContain('group_messages');
    expect(mockCommitted).toEqual([]);
    expect(mockOpen).toBe(false);
  });

  it('без отказа возвращает true и фиксирует обе таблицы', async () => {
    await expect(clearAllMessageHistory(1)).resolves.toBe(true);
    expect(mockCommitted).toContain('messages');
    expect(mockCommitted).toContain('group_messages');
    expect(mockCommitted).toContain('bin_prefix');
  });
});

describe('две версии помощников расходятся ровно в обработке отказа', () => {
  it('kvDelete гасит ошибку, kvDeleteChecked — пробрасывает', async () => {
    mockKvDeleteFails = true;
    await expect(kvDelete('k')).resolves.toBeUndefined();
    await expect(kvDeleteChecked('k')).rejects.toThrow('SQLITE_FULL');
  });

  it('kvDeleteByPrefix возвращает 0, kvDeleteByPrefixChecked — пробрасывает', async () => {
    mockKvDeleteFails = true;
    await expect(kvDeleteByPrefix('pref:')).resolves.toBe(0);
    await expect(kvDeleteByPrefixChecked('pref:')).rejects.toThrow('SQLITE_FULL');
  });

  it('kvDeleteScoped молчит, kvDeleteScopedChecked — пробрасывает', async () => {
    mockKvDeleteFails = true;
    await expect(kvDeleteScoped(1, 'k')).resolves.toBeUndefined();
    await expect(kvDeleteScopedChecked(1, 'k')).rejects.toThrow('SQLITE_FULL');
  });

  it('без отказа обе версии снимают и своё имя, и общее', async () => {
    await kvDeleteScopedChecked(1, 'k');
    expect(mockCommitted.filter((t) => t === 'bin')).toHaveLength(2);
  });
});
