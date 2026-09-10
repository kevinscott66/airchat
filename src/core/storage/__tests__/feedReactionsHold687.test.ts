/**
 * Реакции ленты, которые ключ этого устройства не открывает (v4.32.687).
 *
 * Столбец `reactions` лежит шифртекстом (feedAtRest.ts) и в ленте, и у
 * комментариев. Писать в непрочитанный столбец запрещено с v4.32.544, а у
 * сообщений с v4.32.600 он и читается тремя состояниями. Лента этой второй
 * половины не получила: пять мест читали столбец через `decryptAtRestNullable`,
 * а тот при неудаче отдаёт пустоту — неотличимо от «никто не реагировал».
 *
 * Дороже показа оказалась выгрузка. `exportSyncSnapshot` отдаёт строку целиком,
 * `feedPostIsHeldFromSync` про реакции не знал, и запись уезжала наверх новой
 * ревизией с пустой картой. Приёмник кладёт её без вопросов —
 * `reactions = excluded.reactions`, — так что целые реакции на втором
 * устройстве аккаунта стирались, и молча: там просто становилось пусто.
 *
 * Проверяется поведение: поддельный SQLite отдаёт строки, а поддельная
 * расшифровка честно различает «нет столбца», «прочитан» и «не открылся».
 */
type PostRow = {
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

type CommentRow = {
  id: string;
  post_id: string;
  author_did: string;
  author_name: string | null;
  text: string;
  timestamp: number;
  reactions: string | null;
};

/** Столбец, который не открывается ключом этого устройства. */
const LOCKED = 'enc2:LOCKED';

const mockPosts: PostRow[] = [];
const mockComments: CommentRow[] = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
    getAllAsync: jest.fn(async (sql: string) => {
      if (sql.includes('FROM feed_comment_tombstones')) return [];
      if (sql.includes('FROM feed_comments')) return mockComments.slice();
      if (sql.includes('FROM feed ') || sql.includes('FROM feed\n')) return mockPosts.slice();
      return [];
    }),
    getFirstAsync: jest.fn(async () => null),
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
  // Три состояния, как у настоящего чтения: нет столбца, прочитан, не открылся.
  readAtRestCell: jest.fn((v: string | null) =>
    v === null || v === undefined
      ? { state: 'absent' }
      : v === 'enc2:LOCKED'
        ? { state: 'unreadable' }
        : { state: 'plain', text: v }
  ),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import fs from 'fs';
import path from 'path';

import { FeedStorage } from '../feedStorage';
import {
  feedCommentIsHeldFromSync,
  feedPostIsHeldFromSync,
  feedPostIsUnreadable,
  mayRepublishFeedPost,
} from '../../social/feedPostGuard';

const STORAGE = () => fs.readFileSync(path.join(__dirname, '..', 'feedStorage.ts'), 'utf8');

/** Кусок файла между двумя опорами — чтобы утверждение не ловило соседей. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  const body = src.slice(a, b);
  expect(body.length).toBeGreaterThan(120);
  return body;
}

function post(id: string, reactions: string | null): PostRow {
  return {
    id,
    read: 0,
    archived: 0,
    author_did: 'did:key:zAuthor',
    author_name: 'Аня',
    text: 'привет',
    media_cids: null,
    timestamp: 1000,
    cid: null,
    reactions,
    repost_of: null,
    repost_author_name: null,
    repost_author_did: null,
    bookmarked: 0,
    edited_at: null,
    documents: null,
  };
}

function comment(id: string, reactions: string | null): CommentRow {
  return {
    id,
    post_id: 'p-1',
    author_did: 'did:key:zAuthor',
    author_name: 'Аня',
    text: 'и тебе',
    timestamp: 1000,
    reactions,
  };
}

let s: FeedStorage;

beforeEach(() => {
  mockPosts.length = 0;
  mockComments.length = 0;
  s = new FeedStorage(1);
});

describe('запись ленты различает «реакций нет» и «не прочитал»', () => {
  it('непрочитанный столбец поднимает признак, а карту оставляет пустой', async () => {
    mockPosts.push(post('p-1', LOCKED));
    const [row] = await s.getFeed(50, 0);
    expect(row.reactions).toBeNull();
    expect(row.reactionsUnreadable).toBe(true);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: прочитанный столбец разбирается и признака не поднимает', async () => {
    mockPosts.push(post('p-2', JSON.stringify({ '👍': ['did:key:zBob'] })));
    const [row] = await s.getFeed(50, 0);
    expect(row.reactions).toEqual({ '👍': ['did:key:zBob'] });
    expect(row.reactionsUnreadable).toBe(false);
  });

  it('пустой столбец — это не «не прочитал»', async () => {
    mockPosts.push(post('p-3', null));
    const [row] = await s.getFeed(50, 0);
    expect(row.reactions).toBeNull();
    expect(row.reactionsUnreadable).toBe(false);
  });

  it('выгрузка наверх несёт тот же признак, что и показ', async () => {
    mockPosts.push(post('p-1', LOCKED));
    const snap = await s.exportSyncSnapshot();
    expect(snap.posts).toHaveLength(1);
    expect(snap.posts[0].reactionsUnreadable).toBe(true);
    expect(snap.posts[0].reactions).toBeNull();
  });
});

describe('комментарий читается тем же правилом', () => {
  it('показ поднимает признак', async () => {
    mockComments.push(comment('c-1', LOCKED));
    const [row] = await s.getComments('p-1');
    expect(row.reactions).toBeNull();
    expect(row.reactionsUnreadable).toBe(true);
  });

  it('выгрузка наверх — тоже', async () => {
    mockComments.push(comment('c-1', LOCKED));
    const snap = await s.exportSyncSnapshot();
    expect(snap.comments).toHaveLength(1);
    expect(snap.comments[0].reactionsUnreadable).toBe(true);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: целый столбец разбирается и признака не поднимает', async () => {
    mockComments.push(comment('c-2', JSON.stringify({ '🔥': ['did:key:zBob'] })));
    const [row] = await s.getComments('p-1');
    expect(row.reactions).toEqual({ '🔥': ['did:key:zBob'] });
    expect(row.reactionsUnreadable).toBe(false);
  });
});

describe('придержание при выгрузке', () => {
  it('запись с непрочитанными реакциями наверх не отдаётся', () => {
    expect(feedPostIsHeldFromSync({ reactionsUnreadable: true })).toBe(true);
  });

  it('комментарий с непрочитанными реакциями — тоже', () => {
    expect(feedCommentIsHeldFromSync({ reactionsUnreadable: true })).toBe(true);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: целая запись не придерживается', () => {
    expect(feedPostIsHeldFromSync({ reactionsUnreadable: false })).toBe(false);
    expect(feedCommentIsHeldFromSync({ reactionsUnreadable: false })).toBe(false);
  });

  it('придержание шире показа: читаемый текст из-за реакций не прячется', () => {
    const p = { reactionsUnreadable: true };
    expect(feedPostIsUnreadable(p)).toBe(false);
    expect(mayRepublishFeedPost(p)).toBe(true);
    expect(feedPostIsHeldFromSync(p)).toBe(true);
  });

  it('сквозной: то, что отдала выгрузка, придерживается по её же признаку', async () => {
    mockPosts.push(post('p-1', LOCKED));
    mockPosts.push(post('p-2', JSON.stringify({ '👍': ['did:key:zBob'] })));
    mockComments.push(comment('c-1', LOCKED));
    const snap = await s.exportSyncSnapshot();
    expect(snap.posts.filter((p) => feedPostIsHeldFromSync(p)).map((p) => p.id)).toEqual(['p-1']);
    expect(snap.comments.filter((c) => feedCommentIsHeldFromSync(c)).map((c) => c.id)).toEqual(['c-1']);
  });
});

describe('чтение столбца в ленте больше не двухсостоянийное', () => {
  it('все места ходят через общего читателя', () => {
    const src = STORAGE();
    expect(src).not.toContain('decryptAtRestNullable(');
    const helper = slice(src, 'function readFeedReactions(', '\n}\n');
    expect(helper).toContain('readAtRestCell(stored, dek)');
    expect(helper).toContain('reactions: parseJsonColumn<Record<string, string[]>>(cellTextOrNull(cell))');
    expect(helper).toContain('reactionsUnreadable: unreadableFromCellState(cell.state)');
  });

  it('и показ, и выгрузка, и комментарии — через него же', () => {
    const src = STORAGE();
    expect(slice(src, 'function toPost(', '\n}\n')).toContain('...readFeedReactions(r.reactions, dek),');
    expect(slice(src, 'async exportSyncSnapshot(', '\n  /** Apply one authenticated remote post')).toContain(
      '...readFeedReactions(row.reactions, dek),'
    );
    expect(slice(src, 'async getComments(', '\n  /**')).toContain('...readFeedReactions(r.reactions, dek),');
  });

  it('обе строки ленты несут признак в типе', () => {
    const src = STORAGE();
    expect(slice(src, 'export type FeedCommentRow = {', 'export type FeedSyncTombstone = {')).toMatch(
      /^ {2}reactionsUnreadable\?: boolean;$/m
    );
    expect(slice(src, 'export type FeedPostRow = {', 'export type FeedDocumentMeta = {')).toMatch(
      /^ {2}reactionsUnreadable\?: boolean;$/m
    );
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: приёмник кладёт реакции без вопросов', () => {
    // Цена промаха записана здесь же: придержать строку должна отдающая
    // сторона — принимающей нечем отличить пустую карту от стёртой.
    const src = STORAGE();
    expect(slice(src, 'async upsertSyncPost(', '\n  /** Apply one authenticated remote comment')).toContain(
      'reactions = excluded.reactions,'
    );
    expect(slice(src, 'async upsertSyncComment(', '\n  /** v4.32.546')).toContain(
      'reactions = excluded.reactions'
    );
  });
});
