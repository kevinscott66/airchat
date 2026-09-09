/**
 * Потолок комментариев одного автора под одним постом (v4.32.663).
 *
 * У приёма комментариев проверялась только ФОРМА конверта: id и postId до 128
 * символов, текст до 2000, имя автора обрезалось, сироты (комментарий без
 * поста) откладывались на полку. Количество не проверялось нигде: под реальным
 * постом контакт мог одной рассылкой набить получателю таблицу feed_comments
 * без предела. Отдельно это дорого тем, что getComments читает всю таблицу по
 * посту БЕЗ LIMIT и расшифровывает каждую строку — на каждом открытии поста.
 *
 * Проверяется, что потолок считается на пару «автор + пост», а не глобально:
 * иначе живое обсуждение несколькими людьми упиралось бы в него мгновенно.
 */
type Row = Record<string, unknown>;

const mockComments: Row[] = [];
const mockCommentTombstones: Row[] = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('feed_comment_tombstones')) {
        return mockCommentTombstones.find((r) => r.comment_id === params[0]) ?? null;
      }
      // Счётчик потолка: считаем ровно по паре «пост + автор», как настоящий SQLite.
      if (sql.includes('COUNT(*)') && sql.includes('feed_comments')) {
        const [postId, authorDid] = params as [string, string];
        return {
          count: mockComments.filter((r) => r.post_id === postId && r.author_did === authorDid).length,
        };
      }
      if (sql.includes('feed_comments')) {
        return mockComments.find((r) => r.id === params[0]) ?? null;
      }
      return null;
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT') && sql.includes('feed_comment_tombstones')) {
        const [comment_id] = params as [string];
        if (mockCommentTombstones.some((r) => r.comment_id === comment_id)) {
          return { changes: 0, lastInsertRowId: 0 };
        }
        mockCommentTombstones.push({ comment_id });
        return { changes: 1, lastInsertRowId: 0 };
      }
      if (sql.includes('INSERT') && sql.includes('feed_comments')) {
        const [id, post_id, author_did] = params as [string, string, string];
        // INSERT OR IGNORE: повтор по первичному ключу не меняет ни строки.
        if (mockComments.some((r) => r.id === id)) return { changes: 0, lastInsertRowId: 0 };
        mockComments.push({ id, post_id, author_did });
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
import { FeedStorage, COMMENTS_MAX_PER_AUTHOR_PER_POST, type FeedCommentRow } from '../feedStorage';

const MAX = COMMENTS_MAX_PER_AUTHOR_PER_POST;

const comment = (id: string, authorDid = 'did:key:zSpam', postId = 'post-1'): FeedCommentRow => ({
  id,
  postId,
  authorDid,
  authorName: 'Аня',
  text: 'да',
  timestamp: 1000,
});

let s: FeedStorage;

beforeEach(() => {
  mockComments.length = 0;
  mockCommentTombstones.length = 0;
  s = new FeedStorage(1);
});

/** Заполняет пост комментариями одного автора до потолка. */
async function fillToCeiling(authorDid: string, postId: string): Promise<void> {
  for (let i = 0; i < MAX; i += 1) {
    const ok = await s.addComment(comment(`${postId}-${authorDid}-${i}`, authorDid, postId));
    expect(ok).toBe(true);
  }
}

describe('потолок комментариев одного автора под одним постом', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: чтение комментариев поста идёт без LIMIT', () => {
    const src = readFileSync(join(__dirname, '..', 'feedStorage.ts'), 'utf8');
    // Каждая принятая строка потом читается и расшифровывается целиком, на
    // каждом открытии поста. Появится LIMIT — этот повод ослабнет, и цену
    // потолка можно будет пересмотреть осознанно, а не случайно.
    expect(src).toContain("'SELECT * FROM feed_comments WHERE post_id = ? ORDER BY timestamp ASC'");
    expect(MAX).toBeGreaterThanOrEqual(10);
    expect(MAX).toBeLessThanOrEqual(200);
  });

  it('на потолке следующий комментарий того же автора не принимается', async () => {
    await fillToCeiling('did:key:zSpam', 'post-1');
    expect(mockComments).toHaveLength(MAX);
    expect(await s.addComment(comment('over-1', 'did:key:zSpam', 'post-1'))).toBe(false);
    expect(mockComments).toHaveLength(MAX);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: другой автор под тем же постом всё ещё пишет', async () => {
    await fillToCeiling('did:key:zSpam', 'post-1');
    expect(await s.addComment(comment('other-1', 'did:key:zGuest', 'post-1'))).toBe(true);
    expect(mockComments).toHaveLength(MAX + 1);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: тот же автор под другим постом всё ещё пишет', async () => {
    await fillToCeiling('did:key:zSpam', 'post-1');
    expect(await s.addComment(comment('elsewhere-1', 'did:key:zSpam', 'post-2'))).toBe(true);
    expect(mockComments).toHaveLength(MAX + 1);
  });

  it('поведение повторов не поменялось: дубликат ниже потолка — false, без второй строки', async () => {
    expect(await s.addComment(comment('c-1'))).toBe(true);
    expect(await s.addComment(comment('c-1'))).toBe(false);
    expect(mockComments).toHaveLength(1);
  });
});
