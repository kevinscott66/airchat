/**
 * Свой комментарий: отказ записи больше не выдаётся за отправленный (v4.32.894).
 *
 * Дефект: `addAndBroadcastComment` писал строку через `await s.addComment(row)`
 * и выбрасывал ответ. `addComment` при отказе не бросает — он отдаёт `false`.
 * Экран после этого дописывал комментарий в тред из своего состояния, очищал
 * поле ввода и прокручивал к нему. Текст при этом не сохранён и не разослан:
 * он исчезал при первой же перерисовке ленты, вместе с поводом его переписать,
 * а человек был уверен, что ответил, и ждал реакции.
 *
 * `false` значил три разные вещи: надгробие, потолок на автора под постом и
 * повтор по `id`. Приёмнику чужих конвертов различать их незачем — он в любом
 * случае не поднимает баннер. Своему только что написанному комментарию `id`
 * выдаётся случайным прямо перед записью, так что ни надгробия, ни повтора у
 * него быть не может: единственный достижимый отказ — потолок в 50, и о нём
 * человеку надо сказать словами.
 *
 * Правка: `addCommentChecked` отдаёт причину, `addComment` остаётся тонкой
 * обёрткой над ней — приёмник конвертов не тронут. Сам бросок и его текст
 * проверяются по исходнику: `addAndBroadcastComment` тянет за собой ключи,
 * сеть и очередь повторов, а спорное здесь — что стоит ДО `emitFeedUpdate`.
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
const SRC = join(__dirname, '..', '..');
/** Файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (rel: string): string =>
  readFileSync(join(SRC, rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const comment = (id: string, authorDid = 'did:key:zMine', postId = 'post-1'): FeedCommentRow => ({
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

async function fillToCeiling(authorDid: string, postId: string): Promise<void> {
  for (let i = 0; i < MAX; i += 1) {
    expect(await s.addComment(comment(`${postId}-${authorDid}-${i}`, authorDid, postId))).toBe(true);
  }
}

describe('запись комментария называет причину отказа', () => {
  it('потолок автора под постом отличим от прочих отказов', async () => {
    await fillToCeiling('did:key:zMine', 'post-1');
    expect(await s.addCommentChecked(comment('over-1'))).toBe('author_limit');
    expect(mockComments).toHaveLength(MAX);
  });

  it('надгробие отличимо от потолка', async () => {
    mockCommentTombstones.push({ comment_id: 'buried-1' });
    expect(await s.addCommentChecked(comment('buried-1'))).toBe('tombstoned');
    expect(mockComments).toHaveLength(0);
  });

  it('повтор по id отличим от обоих', async () => {
    expect(await s.addCommentChecked(comment('dup-1'))).toBe('inserted');
    expect(await s.addCommentChecked(comment('dup-1'))).toBe('duplicate');
    expect(mockComments).toHaveLength(1);
  });

  it('удача так и называется удачей', async () => {
    expect(await s.addCommentChecked(comment('fresh-1'))).toBe('inserted');
    expect(mockComments).toHaveLength(1);
  });
});

describe('свой комментарий не показывается отправленным, пока не записан', () => {
  it('исход проверяется ДО того, как лента узнает о комментарии', () => {
    const s2 = bare('social/feedService.ts');
    expect(s2).not.toContain('await s.addComment(row);');
    const at = s2.indexOf('const wrote = await s.addCommentChecked(row);');
    expect(at).toBeGreaterThan(0);
    const gate = s2.indexOf("if (wrote !== 'inserted') {", at);
    expect(gate).toBeGreaterThan(at);
    // `emitFeedUpdate` — то, чем экран узнаёт о новой строке; рассылка идёт
    // ещё ниже. Оба обязаны стоять после проверки.
    expect(s2.indexOf('emitFeedUpdate();', at)).toBeGreaterThan(gate);
    expect(s2.indexOf('const online = await checkOnlineWrite();', at)).toBeGreaterThan(gate);
  });

  it('на потолке человеку названо число, а не «ошибка»', () => {
    const s2 = bare('social/feedService.ts');
    expect(s2).toContain("wrote === 'author_limit'");
    expect(s2).toContain('${COMMENTS_MAX_PER_AUTHOR_PER_POST} ваших ${ruPlural(COMMENTS_MAX_PER_AUTHOR_PER_POST');
    expect(s2).toContain("['комментарий', 'комментария', 'комментариев']");
  });

  it('склонение берётся из общего правила, а не пишется заново', () => {
    const { ruPlural } = require('../../text/ruPlural') as {
      ruPlural: (n: number, f: readonly [string, string, string]) => string;
    };
    const forms = ['комментарий', 'комментария', 'комментариев'] as const;
    expect(`Под этой публикацией уже ${MAX} ваших ${ruPlural(MAX, forms)} — новый не сохранён`)
      .toBe('Под этой публикацией уже 50 ваших комментариев — новый не сохранён');
  });

  it('текст броска доходит до экрана: он кириллический и однострочный', () => {
    const { isUserFacingMessage } = require('../../../ui/components/userErrorText') as {
      isUserFacingMessage: (t: string) => boolean;
    };
    expect(isUserFacingMessage('Под этой публикацией уже 50 ваших комментариев — новый не сохранён')).toBe(true);
    expect(isUserFacingMessage('Комментарий не сохранился — попробуйте ещё раз')).toBe(true);
  });

  it('экран отдаёт этот текст человеку и не чистит поле ввода', () => {
    const s2 = bare('../ui/screens/FeedScreen.tsx');
    const at = s2.indexOf('const row = await addAndBroadcastComment(pair, commentPostId, commentText.trim(), myName);');
    expect(at).toBeGreaterThan(0);
    // Всё, что делает вид «отправлено», стоит после ожидания — значит бросок
    // до него не доходит.
    expect(s2.indexOf("setCommentText('');", at)).toBeGreaterThan(at);
    expect(s2.indexOf('setComments((prev) => appendOwnComment(', at)).toBeGreaterThan(at);
    expect(s2).toContain("showError(userErrorText(e, t('common.error')));");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: потолок и приёмник конвертов не тронуты', () => {
  it('булева обёртка осталась и отвечает ровно как прежде', async () => {
    await fillToCeiling('did:key:zSpam', 'post-1');
    expect(await s.addComment(comment('over-2', 'did:key:zSpam', 'post-1'))).toBe(false);
    expect(await s.addComment(comment('other-1', 'did:key:zGuest', 'post-1'))).toBe(true);
    expect(await s.addComment(comment('elsewhere-1', 'did:key:zSpam', 'post-2'))).toBe(true);
  });

  it('приёмник чужих конвертов по-прежнему зовёт булеву обёртку', () => {
    const s2 = bare('social/feedService.ts');
    expect(s2).toContain('const commentStored = await s.addComment({');
    expect(s2).toContain('if (!commentStored) {');
    expect(s2).toContain("log.debug('feed_comment_duplicate_skip', { commentId: d.commentId.slice(0, 16) });");
  });

  it('прежние отказы до записи на месте: пустой и слишком длинный', () => {
    const s2 = bare('social/feedService.ts');
    expect(s2).toContain("if (!trimmed) throw new Error('Комментарий пустой');");
    expect(s2).toContain('Комментарий слишком длинный (макс. ${FEED_COMMENT_MAX_CHARS} символов)');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('`id` своего комментария выдаётся случайным прямо перед записью', () => {
    // Потому и сказано, что надгробие с повтором ему не грозят.
    const s2 = bare('social/feedService.ts');
    expect(s2).toContain('const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;');
  });

  it('потолок в 50 на автора под постом всё так же существует', () => {
    expect(MAX).toBe(50);
    const s2 = bare('storage/feedStorage.ts');
    expect(s2).toContain('if ((mine?.count ?? 0) >= COMMENTS_MAX_PER_AUTHOR_PER_POST) {');
  });

  it('отказ базы сюда не приходит — он остаётся исключением', () => {
    const s2 = bare('storage/feedStorage.ts');
    const at = s2.indexOf('async addCommentChecked(row: FeedCommentRow): Promise<FeedCommentWrite> {');
    expect(at).toBeGreaterThan(0);
    const end = s2.indexOf('async getComments(postId: string)', at);
    expect(s2.slice(at, end)).not.toContain('catch');
  });
});
