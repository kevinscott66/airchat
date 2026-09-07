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
const mockExec: string[] = [];
/** `pk` у author_did в PRAGMA table_info: 0 — старый ключ, 2 — составной. */
let mockTombstonePk = 2;

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
    execAsync: jest.fn(async (sql: string) => {
      mockExec.push(sql);
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
    getAllAsync: jest.fn(async (sql: string) => {
      if (sql.includes('PRAGMA table_info(feed_post_tombstones)')) {
        return [
          { name: 'post_id', pk: 1 },
          { name: 'author_did', pk: mockTombstonePk },
          { name: 'deleted_at', pk: 0 },
        ];
      }
      return [];
    }),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      const t = mockTableFor(sql);
      if (!t) return null;
      const id = params[0];
      // Составной ключ надгробий: строк на один post_id может быть несколько.
      if (sql.includes('feed_post_tombstones')) {
        return sql.includes('author_did = ?')
          ? (t.find((r) => r.post_id === id && r.author_did === params[1]) ?? null)
          : (t.find((r) => r.post_id === id) ?? null);
      }
      return t.find((r) => r.id === id) ?? null;
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
        if (!mockTombstones.some((r) => r.post_id === post_id && r.author_did === author_did)) {
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

import { readFileSync } from 'fs';
import { join } from 'path';

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
  mockExec.length = 0;
  mockTombstonePk = 2;
  s = new FeedStorage(1);
});

describe('право писать содержимое публикации', () => {
  // v4.32.614: вложения лежат в kv по ключу из одного лишь номера поста,
  // поэтому чужой конверт с занятым номером подменял картинки под чужой
  // записью. Строку savePost бы не тронул — а байты подменились бы.
  it('свободный номер и повтор своего поста — можно', async () => {
    expect(await s.postWriteGuard(PID, AUTHOR)).toBe('ok');
    await s.savePost(post(PID, AUTHOR));
    expect(await s.postWriteGuard(PID, AUTHOR)).toBe('ok');
  });

  it('занятый чужим автором номер — нельзя', async () => {
    await s.savePost(post(PID, AUTHOR));
    expect(await s.postWriteGuard(PID, OTHER)).toBe('foreign');
  });

  it('свой удалённый пост не воскрешается вложениями', async () => {
    await s.savePost(post(PID, AUTHOR));
    await s.deletePost(PID, 777);
    expect(await s.postWriteGuard(PID, AUTHOR)).toBe('tombstoned');
    // Надгробие адресное: чужому автору оно ничего не запрещает.
    expect(await s.postWriteGuard(PID, OTHER)).toBe('ok');
  });
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

describe('индексы надгробий', () => {
  const SRC = readFileSync(join(__dirname, '..', 'feedStorage.ts'), 'utf8');

  it('по deleted_at индекса нет — читателя у него не появилось', () => {
    // Чистки надгробий нет и не планируется, а SELECT'ы идут по post_id.
    expect(SRC).not.toContain('CREATE INDEX IF NOT EXISTS idx_fpt_at');
    expect(SRC).toContain('DROP INDEX IF EXISTS idx_fpt_at;');
  });

  it('и не появился запрос, которому такой индекс был бы нужен', () => {
    for (const m of SRC.matchAll(/feed_post_tombstones[\s\S]{0,160}/g)) {
      expect(m[0]).not.toMatch(/(WHERE|ORDER BY)[\s\S]{0,60}deleted_at/);
    }
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

describe('надгробие не занять чужим', () => {
  // v4.32.615: ключом был один post_id, а вставка идёт через INSERT OR IGNORE.
  // Номер публикации придумывает отправитель, поэтому любой контакт мог
  // прислать feed_delete со своим DID и чужим номером до того, как сама
  // публикация к нам доехала. Его строка занимала ключ, настоящее «удалить
  // у всех» от автора молча игнорировалось — и запоздавший feed_post
  // воскрешал удалённую публикацию навсегда.
  const THIRD = 'did:key:zThird';

  it('чужая запись не глушит удаление автора', async () => {
    await s.savePostTombstone(PID, OTHER, 400);
    await s.savePostTombstone(PID, AUTHOR, 500);
    expect(mockTombstones).toHaveLength(2);
    await s.savePost(post(PID, AUTHOR));
    expect(mockFeed).toHaveLength(0);
  });

  it('и не запрещает писать вложения тому, кто ничего не удалял', async () => {
    await s.savePostTombstone(PID, OTHER, 400);
    await s.savePostTombstone(PID, AUTHOR, 500);
    expect(await s.postWriteGuard(PID, AUTHOR)).toBe('tombstoned');
    expect(await s.postWriteGuard(PID, THIRD)).toBe('ok');
  });

  it('на облачном пути результат тот же', async () => {
    await s.savePostTombstone(PID, OTHER, 400);
    await s.savePostTombstone(PID, AUTHOR, 500);
    await s.upsertSyncPost({ ...post(PID, AUTHOR), read: 0, reactions: null } as FeedPostRow);
    expect(mockFeed).toHaveLength(0);
  });

  it('время удаления у каждого автора своё', async () => {
    await s.savePostTombstone(PID, OTHER, 400);
    await s.savePostTombstone(PID, AUTHOR, 500);
    await s.savePostTombstone(PID, AUTHOR, 900);
    expect(mockTombstones).toEqual([
      { post_id: PID, author_did: OTHER, deleted_at: 400 },
      { post_id: PID, author_did: AUTHOR, deleted_at: 500 },
    ]);
  });
});

describe('перенос старой таблицы надгробий', () => {
  const rebuilt = () => mockExec.filter((q) => q.includes('feed_post_tombstones_v2'));

  it('база со старым ключом перестраивается', async () => {
    mockTombstonePk = 0;
    await s.postWriteGuard(PID, AUTHOR);
    const sql = rebuilt().join('\n');
    expect(sql).toContain('PRIMARY KEY (post_id, author_did)');
    expect(sql).toContain('INSERT OR IGNORE INTO feed_post_tombstones_v2');
    expect(sql).toContain('DROP TABLE feed_post_tombstones;');
    expect(sql).toContain('ALTER TABLE feed_post_tombstones_v2 RENAME TO feed_post_tombstones;');
  });

  it('база с новым ключом не трогается', async () => {
    await s.postWriteGuard(PID, AUTHOR);
    expect(rebuilt()).toEqual([]);
  });
});

describe('источник: ключ надгробий составной', () => {
  const SRC = readFileSync(join(__dirname, '..', 'feedStorage.ts'), 'utf8');

  it('в схеме объявлен ключ (post_id, author_did)', () => {
    expect(SRC).toContain(`CREATE TABLE IF NOT EXISTS feed_post_tombstones (
            post_id TEXT NOT NULL,
            author_did TEXT NOT NULL,
            deleted_at INTEGER NOT NULL,
            PRIMARY KEY (post_id, author_did)
          );`);
  });

  it('автор отбирается запросом, а не сравнением после выборки', () => {
    expect(SRC).toContain(
      "'SELECT post_id FROM feed_post_tombstones WHERE post_id = ? AND author_did = ?'"
    );
    expect(SRC).not.toContain("'SELECT author_did FROM feed_post_tombstones WHERE post_id = ?'");
  });
});
