/**
 * Повторно приехавший комментарий (v4.32.581).
 *
 * Очередь комментариев при частичной доставке шлёт конверт заново ВСЕМ
 * контактам: списка уже доставленных у неё, в отличие от очереди публикаций,
 * нет вовсе. Значит повтор — не редкий сбой, а обычный ход событий, и повторы
 * идут до получаса: 30 с → 1 мин → 2 мин и дальше.
 *
 * `addComment` возвращала `void`, и вызывающий не мог отличить новый
 * комментарий от повторного: баннер «новый комментарий» всплывал на каждой
 * попытке над одним и тем же, уже прочитанным. Второй случай — надгробие,
 * приехавшее раньше самого комментария: в ленту он не попадал (и правильно), а
 * баннер о нём показывался, и по нажатию человек не находил ничего.
 *
 * Проверяется договор хранилища — «записал/не записал» — и то, что лента этим
 * ответом действительно пользуется.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

type Row = Record<string, unknown>;

const mockComments: Row[] = [];
const mockCommentTombstones: Row[] = [];

function mockTableFor(sql: string): Row[] | null {
  if (sql.includes('feed_comment_tombstones')) return mockCommentTombstones;
  if (sql.includes('feed_comments')) return mockComments;
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
      const col = sql.includes('feed_comment_tombstones') ? 'comment_id' : 'id';
      return t.find((r) => r[col] === params[0]) ?? null;
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
        const [id, post_id] = params as [string, string];
        // INSERT OR IGNORE: повтор по первичному ключу не меняет ни строки —
        // ровно так же, как настоящий SQLite.
        if (mockComments.some((r) => r.id === id)) return { changes: 0, lastInsertRowId: 0 };
        mockComments.push({ id, post_id });
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

import { FeedStorage, type FeedCommentRow } from '../feedStorage';

const comment = (id: string): FeedCommentRow => ({
  id,
  postId: 'post-1',
  authorDid: 'did:key:zAuthor',
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

describe('addComment отвечает, записался ли комментарий', () => {
  it('новый — true', async () => {
    expect(await s.addComment(comment('c-1'))).toBe(true);
    expect(mockComments).toHaveLength(1);
  });

  it('повтор того же конверта — false, строка не удваивается', async () => {
    await s.addComment(comment('c-1'));
    expect(await s.addComment(comment('c-1'))).toBe(false);
    expect(mockComments).toHaveLength(1);
  });

  it('комментарий, опоздавший за собственным удалением, — false', async () => {
    await s.addCommentTombstone('c-2', 'post-1');
    expect(await s.addComment(comment('c-2'))).toBe(false);
    expect(mockComments).toHaveLength(0);
  });
});

describe('лента поднимает баннер только на действительно новый комментарий', () => {
  const feedService = readFileSync(join(__dirname, '..', '..', 'social', 'feedService.ts'), 'utf8');

  it('приём комментария выходит из ветки, если запись не состоялась', () => {
    expect(feedService).toContain('const commentStored = await s.addComment({');
    const idx = feedService.indexOf('const commentStored = await s.addComment({');
    const after = feedService.slice(idx, idx + 1600);
    expect(after).toContain('if (!commentStored) {');
    // Выход стоит ДО баннера, иначе вся правка ничего не значит.
    expect(after.indexOf('if (!commentStored) {')).toBeLessThan(after.indexOf('emitFeedNotify({'));
  });
});
