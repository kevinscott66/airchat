/**
 * Счётчик непрочитанного считает то же, что показывает лента (v4.32.669).
 *
 * `getFeed` отдаёт строки с `COALESCE(archived, 0) = 0`, а `getUnreadCount`
 * считал всю таблицу. Человек убирал непрочитанную публикацию в архив, и
 * полоса «N непрочитанных — обновить» повисала навсегда: в ленту эта строка
 * больше не приходила, значит обработчик видимости FlatList её не пометит, а
 * нажатие на полосу лишь перезагружало ленту с тем же числом.
 *
 * Проверяется поведение: поддельный SQLite честно применяет ровно те условия,
 * которые перечислены в самом запросе, — как настоящий.
 */
type Row = {
  id: string;
  read: number;
  archived: number;
  author_did: string;
  author_name: string | null;
  text: string | null;
  media_cids: string | null;
  timestamp: number;
  cid: string | null;
  reactions: string | null;
  repost_of: string | null;
  repost_author_name: string | null;
  repost_author_did: string | null;
  bookmarked: number;
  edited_at: number | null;
  documents: string | null;
};

const mockFeed: Row[] = [];

/** Условия берём из текста запроса — что перечислено, то и применяем. */
function mockSelectFeed(sql: string): Row[] {
  let rows = mockFeed.slice();
  if (sql.includes('read = 0')) rows = rows.filter((r) => r.read === 0);
  if (sql.includes('archived')) {
    rows = sql.includes('archived = 1')
      ? rows.filter((r) => r.archived === 1)
      : rows.filter((r) => r.archived === 0);
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
    getAllAsync: jest.fn(async (sql: string) =>
      sql.includes('FROM feed ') || sql.includes('FROM feed\n') ? mockSelectFeed(sql) : []
    ),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (sql.includes('COUNT(*) as count FROM feed ')) return { count: mockSelectFeed(sql).length };
      return null;
    }),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 0 })),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system/legacy', () => ({ documentDirectory: '/doc/' }));

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
  readAtRestCell: jest.fn((v: string | null) =>
    v === null ? { state: 'absent' } : { state: 'plain', text: v }
  ),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import { FeedStorage } from '../feedStorage';

function post(id: string, read: number, archived: number, timestamp = 1000): Row {
  return {
    id,
    read,
    archived,
    author_did: 'did:key:zAuthor',
    author_name: 'Аня',
    text: 'привет',
    media_cids: null,
    timestamp,
    cid: null,
    reactions: null,
    repost_of: null,
    repost_author_name: null,
    repost_author_did: null,
    bookmarked: 0,
    edited_at: null,
    documents: null,
  };
}

let s: FeedStorage;

beforeEach(() => {
  mockFeed.length = 0;
  s = new FeedStorage(1);
});

describe('непрочитанное считается по тому же правилу, что и лента', () => {
  it('убранная в архив непрочитанная публикация в счётчик не идёт', async () => {
    mockFeed.push(post('p-1', 0, 1, 3000));
    expect(await s.getUnreadCount()).toBe(0);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: обычная непрочитанная считается', async () => {
    mockFeed.push(post('p-2', 0, 0, 2000));
    expect(await s.getUnreadCount()).toBe(1);
  });

  it('счётчик сходится с тем, что отдаёт лента', async () => {
    mockFeed.push(post('p-1', 0, 1, 3000));
    mockFeed.push(post('p-2', 0, 0, 2000));
    mockFeed.push(post('p-3', 1, 0, 1000));
    const shown = await s.getFeed(50, 0);
    expect(shown.map((p) => p.id)).toEqual(['p-2', 'p-3']);
    expect(await s.getUnreadCount()).toBe(shown.filter((p) => p.read === 0).length);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: архив прячет строку из ленты и не помечает её прочитанной', async () => {
    mockFeed.push(post('p-1', 0, 1, 3000));
    // Строки в ленте нет — значит пометить её прочитанной некому.
    expect((await s.getFeed(50, 0)).map((p) => p.id)).toEqual([]);
    // А в архиве она есть и по-прежнему непрочитанная.
    const arch = await s.listArchived(50, 0);
    expect(arch.map((p) => p.id)).toEqual(['p-1']);
    expect(arch[0].read).toBe(0);
  });
});
