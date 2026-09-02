/**
 * Надгробие удалённой публикации (v4.32.546).
 *
 * «Удалить у всех» — это не команда серверу, а рассылка конверта `feed_delete`
 * каждому контакту. Пока сокет забирал только последние десять минут, гонка была
 * незаметна: не дошло — значит не дошло. С 4.32.545 при выходе в сеть
 * переигрывается до двенадцати часов накопленного, и в этом окне ретрай
 * `feed_post` спокойно приезжает ПОСЛЕ `feed_delete` — своим ли повтором автора,
 * вторым ли транспортом, облачным ли снимком второго устройства. Без надгробия
 * удалённая публикация возвращалась к получателю и оставалась у него навсегда.
 *
 * Проверяется и обратное: надгробие адресное. `post_id` придумывает отправитель,
 * поэтому запись, поставленная одним автором, не должна затыкать публикацию
 * другого с тем же идентификатором — иначе достаточно было бы удалить свой пост
 * с чужим id, чтобы у всех пропала чужая запись.
 */
type Row = Record<string, unknown>;

const mockFeed: Row[] = [];
const mockTombstones: Row[] = [];
const mockComments: Row[] = [];
const mockViews: Row[] = [];

/** Мини-движок: понимает ровно те запросы, которые шлёт FeedStorage. */
function mockTableFor(sql: string): Row[] | null {
  if (sql.includes('feed_post_tombstones')) return mockTombstones;
  if (sql.includes('feed_comments')) return mockComments;
  if (sql.includes('feed_post_views')) return mockViews;
  if (/\bfeed\b/.test(sql)) return mockFeed;
  return null;
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      const t = mockTableFor(sql);
      if (!t) return null;
      const id = params[0];
      const col = sql.includes('feed_post_tombstones') ? 'post_id' : 'id';
      return t.find((r) => r[col] === id) ?? null;
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      const t = mockTableFor(sql);
      if (!t) return { changes: 0, lastInsertRowId: 0 };
      if (sql.startsWith('DELETE')) {
        const col = sql.includes('post_id = ?') ? 'post_id' : 'id';
        for (let i = t.length - 1; i >= 0; i -= 1) if (t[i][col] === params[0]) t.splice(i, 1);
        return { changes: 1, lastInsertRowId: 0 };
      }
      if (sql.includes('INSERT') && sql.includes('feed_post_tombstones')) {
        const [post_id, author_did, deleted_at] = params as [string, string, number];
        if (!mockTombstones.some((r) => r.post_id === post_id)) {
          mockTombstones.push({ post_id, author_did, deleted_at });
        }
        return { changes: 1, lastInsertRowId: 0 };
      }
      if (sql.includes('INSERT') && /INTO feed\b/.test(sql)) {
        const [id, author_did] = params as [string, string];
        if (!mockFeed.some((r) => r.id === id)) mockFeed.push({ id, author_did });
        return { changes: 1, lastInsertRowId: 0 };
      }
      return { changes: 0, lastInsertRowId: 0 };
    }),
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
  resetDataEncryptionKeyCache: jest.fn(),
}));

import { FeedStorage, type FeedPostRow } from '../feedStorage';

const AUTHOR = 'did:key:zAuthor';
const OTHER = 'did:key:zOther';
const PID = 'post-1';

function post(id: string, authorDid: string): Omit<FeedPostRow, 'read' | 'reactions'> {
  return { id, authorDid, authorName: 'A', text: 'привет', mediaCids: null, timestamp: 1000, cid: null };
}

let s: FeedStorage;

beforeEach(() => {
  mockFeed.length = 0;
  mockTombstones.length = 0;
  mockComments.length = 0;
  mockViews.length = 0;
  s = new FeedStorage(1);
});

describe('удаление ставит надгробие', () => {
  it('после deletePost запись об удалении остаётся с автором поста', async () => {
    await s.savePost(post(PID, AUTHOR));
    await s.deletePost(PID, 777);
    expect(mockFeed).toHaveLength(0);
    expect(mockTombstones).toEqual([{ post_id: PID, author_did: AUTHOR, deleted_at: 777 }]);
  });

  it('запоздавший тот же пост больше не воскресает', async () => {
    await s.savePost(post(PID, AUTHOR));
    await s.deletePost(PID);
    await s.savePost(post(PID, AUTHOR));
    expect(mockFeed).toHaveLength(0);
  });

  it('облачный снимок второго устройства тоже не возвращает пост', async () => {
    await s.savePost(post(PID, AUTHOR));
    await s.deletePost(PID);
    await s.upsertSyncPost({ ...post(PID, AUTHOR), read: 0, reactions: null } as FeedPostRow);
    expect(mockFeed).toHaveLength(0);
  });

  it('надгробие без строки поста — feed_delete пришёл раньше публикации', async () => {
    await s.savePostTombstone(PID, AUTHOR, 500);
    await s.savePost(post(PID, AUTHOR));
    expect(mockFeed).toHaveLength(0);
  });

  it('первое время удаления не переписывается повтором', async () => {
    await s.savePostTombstone(PID, AUTHOR, 500);
    await s.savePostTombstone(PID, AUTHOR, 900);
    expect(mockTombstones).toEqual([{ post_id: PID, author_did: AUTHOR, deleted_at: 500 }]);
  });
});

describe('надгробие адресное', () => {
  it('чужую публикацию с тем же id оно не затыкает', async () => {
    await s.savePostTombstone(PID, AUTHOR, 500);
    await s.savePost(post(PID, OTHER));
    expect(mockFeed).toHaveLength(1);
    expect(mockFeed[0].author_did).toBe(OTHER);
  });

  it('и не затыкает её на облачном пути', async () => {
    await s.savePostTombstone(PID, AUTHOR, 500);
    await s.upsertSyncPost({ ...post(PID, OTHER), read: 0, reactions: null } as FeedPostRow);
    expect(mockFeed).toHaveLength(1);
  });
});

describe('вместе с постом уходит его обвязка', () => {
  it('комментарии и просмотры удалённого поста не остаются сиротами', async () => {
    mockComments.push({ id: 'c1', post_id: PID }, { id: 'c2', post_id: 'post-2' });
    mockViews.push({ post_id: PID }, { post_id: 'post-2' });
    await s.savePost(post(PID, AUTHOR));
    await s.deletePost(PID);
    expect(mockComments.map((r) => r.id)).toEqual(['c2']);
    expect(mockViews.map((r) => r.post_id)).toEqual(['post-2']);
  });
});
