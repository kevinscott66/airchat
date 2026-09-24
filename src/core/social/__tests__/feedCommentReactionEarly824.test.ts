/**
 * Реакция, обогнавшая свой комментарий, больше не пропадает (v4.32.824).
 *
 * Дефект. Реакция на комментарий применяется по строке комментария:
 * `getCommentMeta` отдаёт её список значков, к нему прибавляется свой, и
 * список кладётся обратно. Комментария в базе нет — разбор молча выходил и
 * отвечал «разобрано», а это двигает метку «докуда прочитано» у ретранслятора
 * необратимо. Повторов у реакции нет вовсе, а очередь комментария наполняется
 * только при НЕудаче доставки: конверт, дошедший до всех и отвергнутый
 * получателем, не повторит никто.
 *
 * Цена. Обогнать свой комментарий реакции просто: кадры одной пачки
 * ретранслятора разбираются параллельно, и после долгого offline комментарий
 * с реакцией приезжают вместе. Тот, кто её поставил, видел её у себя и был
 * уверен, что она стоит у обоих.
 *
 * Правка. Полка отложенных приняла пятый род событий. Номер на ней прежний —
 * номер публикации, потому что комментарий кладётся туда же; а разбирается
 * полка теперь не только при приходе публикации, но и при приходе
 * комментария: ждут они разного, и публикация обычно приходит первой.
 *
 * Проверка поведением: модуль настоящий, отказ подделан на уровне kv — ровно
 * там, где отказывает база.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => true) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
}));

type Row = { id: string; authorDid: string; text: string };
type Comment = { postId: string; authorDid: string; reactions: Record<string, string[]> };

const mockPosts = new Map<string, Row>();
const mockComments = new Map<string, Comment>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(row: Row): Promise<void> { mockPosts.set(row.id, row); }
    async getPost(id: string): Promise<Row | null> { return mockPosts.get(id) ?? null; }
    async addReaction(postId: string): Promise<boolean> { return mockPosts.has(postId); }
    async removeReaction(): Promise<void> { /* снятие проверяется не здесь */ }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
    async addComment(row: { id: string; postId: string; authorDid: string }): Promise<boolean> {
      // Настоящая отвечает `false` на повтор — это и останавливает разбор
      // полки, если очистить её не удалось.
      if (mockComments.has(row.id)) return false;
      mockComments.set(row.id, { postId: row.postId, authorDid: row.authorDid, reactions: {} });
      return true;
    }
    async getCommentMeta(id: string): Promise<Comment | null> { return mockComments.get(id) ?? null; }
    async updateCommentReactions(id: string, reactions: Record<string, string[]>): Promise<boolean> {
      const c = mockComments.get(id);
      if (!c) return false;
      c.reactions = reactions;
      return true;
    }
    async getComments(): Promise<unknown[]> { return []; }
  },
}));

const mockKv = new Map<string, string>();
const mockDeferKey = 'feed_deferred_v1:p1';
/** Отвечает ли запись полки отказом. */
let mockFailDeferWrite = false;

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetSecretCell: jest.fn(async (k: string) => {
    const raw = mockKv.get(k);
    return raw === undefined ? { state: 'absent' } : { state: 'plain', text: raw };
  }),
  kvSetSecret: jest.fn(async (k: string, v: string) => {
    if (k === mockDeferKey && mockFailDeferWrite) return false;
    mockKv.set(k, v);
    return true;
  }),
  kvGetInlineAttachment: jest.fn(async () => null),
  kvTryGetInlineAttachment: jest.fn(async () => ({ value: null })),
  kvSetInlineAttachment: jest.fn(async () => true),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => false,
  isPublicPostId: () => false,
  publicPostCopyExists: jest.fn(async () => false),
  putPublicPostCopy: jest.fn(async () => true),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { receiveFeedEnvelope, setFeedProfileContext } from '../feedService';
import { serializeFeedEnvelope, type FeedEnvelopePayload } from '../feedTransport';

type Identity = { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string };

function newIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, did: publicKeyToDidKey(publicKey) };
}

/** Обёртка 0xF1 вокруг подписанного кадра: так конверт приходит от соседа. */
function wrapper(inner: Uint8Array, h: number): Uint8Array {
  const json = JSON.stringify({ h, f: Buffer.from(inner).toString('base64') });
  const bytes = new TextEncoder().encode(json);
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0xf1;
  out.set(bytes, 1);
  return out;
}

/** Доставить конверт и вернуть исход разбора — то, чем двигается метка. */
async function deliver(id: Identity, payload: FeedEnvelopePayload): Promise<string> {
  const frame = await serializeFeedEnvelope(id.pair, payload);
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  const intake = await receiveFeedEnvelope(wrapper(frame, 0), '');
  // Пересылка запускается без await — дать очереди микрозадач провернуться.
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  return intake;
}

const T0 = Date.now();

function comment(id: Identity, postId: string, commentId: string, ts = T0): FeedEnvelopePayload {
  return {
    type: 'feed_comment',
    postId,
    authorDid: id.did,
    ts,
    data: { kind: 'comment', commentId, text: 'и правда хорошо', authorName: 'Сосед' },
  } as unknown as FeedEnvelopePayload;
}

function commentReaction(
  id: Identity,
  postId: string,
  commentId: string,
  emoji: string,
  over: { remove?: boolean; ts?: number } = {},
): FeedEnvelopePayload {
  return {
    type: 'feed_comment_reaction',
    postId,
    authorDid: id.did,
    ts: over.ts ?? T0 + 1000,
    data: { kind: 'comment_reaction', commentId, emoji, remove: over.remove },
  } as unknown as FeedEnvelopePayload;
}

/** Публикация уже у нас: ждут здесь именно комментария, а не её. */
function givenPost(id: Identity, postId: string): void {
  mockPosts.set(postId, { id: postId, authorDid: id.did, text: 'пост' });
}

/** Сколько событий лежит на полке по этой публикации. */
function shelved(postId: string): number {
  const raw = mockKv.get(mockDeferKey);
  if (!raw) return 0;
  const store = JSON.parse(raw) as Record<string, { events: unknown[] }>;
  return store[postId]?.events.length ?? 0;
}

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockComments.clear();
  mockFailDeferWrite = false;
});

describe('комментария ещё нет — реакция на него ждёт его', () => {
  test('реакция ложится на полку, а не выбрасывается', async () => {
    const author = newIdentity();
    givenPost(author, 'p-1');
    // До правки здесь не оставалось ничего: разбор выходил молча и отвечал
    // «разобрано», а второй раз реакцию не шлёт никто.
    expect(await deliver(author, commentReaction(author, 'p-1', 'c-1', '👍'))).toBe('consumed');
    expect(shelved('p-1')).toBe(1);
  });

  test('комментарий пришёл — реакция встала на место', async () => {
    const author = newIdentity();
    givenPost(author, 'p-2');
    await deliver(author, commentReaction(author, 'p-2', 'c-2', '🔥'));

    expect(await deliver(author, comment(author, 'p-2', 'c-2'))).toBe('consumed');
    expect(mockComments.get('c-2')?.reactions).toEqual({ '🔥': [author.did] });
    // Полка по этой публикации разобрана до конца.
    expect(shelved('p-2')).toBe(0);
  });

  test('полка не приняла реакцию — кадр не разобран', async () => {
    mockFailDeferWrite = true;
    const author = newIdentity();
    givenPost(author, 'p-3');
    expect(await deliver(author, commentReaction(author, 'p-3', 'c-3', '👍'))).toBe('deferred');
  });

  test('поставил и снял до прихода комментария — останется снятие', async () => {
    const author = newIdentity();
    givenPost(author, 'p-4');
    await deliver(author, commentReaction(author, 'p-4', 'c-4', '👍', { ts: T0 + 1000 }));
    await deliver(author, commentReaction(author, 'p-4', 'c-4', '👍', { remove: true, ts: T0 + 2000 }));
    // Ячейка на полке у постановки и снятия общая: это одно действие над одним
    // значком, и остаться должно последнее по времени.
    expect(shelved('p-4')).toBe(1);

    await deliver(author, comment(author, 'p-4', 'c-4'));
    expect(mockComments.get('c-4')?.reactions).toEqual({});
  });

  test('и публикации нет тоже: обоих ждёт одна полка', async () => {
    const author = newIdentity();
    await deliver(author, commentReaction(author, 'p-5', 'c-5', '👍'));
    await deliver(author, comment(author, 'p-5', 'c-5'));
    expect(shelved('p-5')).toBe(2);
    expect(mockComments.has('c-5')).toBe(false);

    // Публикация пришла — по возрастанию времени сначала комментарий, потом
    // реакция на него.
    const post = {
      type: 'feed_post',
      postId: 'p-5',
      authorDid: author.did,
      ts: T0,
      data: { kind: 'post', text: 'пост' },
    } as unknown as FeedEnvelopePayload;
    expect(await deliver(author, post)).toBe('consumed');
    expect(mockComments.get('c-5')?.reactions).toEqual({ '👍': [author.did] });
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Полка — не свалка: её наполняет чужой подписанный конверт, и номер
 * комментария в нём выдуман отправителем ровно так же, как номер публикации.
 * Откладывать можно только опоздание; несогласие конверта с базой обязано
 * остаться отказом, иначе полку забьют реакциями на комментарии, которых нет.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный ход вещей полки не касается', () => {
  test('комментарий на месте — реакция применяется сразу', async () => {
    const author = newIdentity();
    givenPost(author, 'ok-1');
    await deliver(author, comment(author, 'ok-1', 'c-ok'));

    expect(await deliver(author, commentReaction(author, 'ok-1', 'c-ok', '👍'))).toBe('consumed');
    expect(mockComments.get('c-ok')?.reactions).toEqual({ '👍': [author.did] });
    expect(shelved('ok-1')).toBe(0);
  });

  test('комментарий живёт под другой публикацией — отказ, и ждать нечего', async () => {
    const author = newIdentity();
    givenPost(author, 'ok-2');
    givenPost(author, 'ok-3');
    await deliver(author, comment(author, 'ok-2', 'c-other'));

    expect(await deliver(author, commentReaction(author, 'ok-3', 'c-other', '👍'))).toBe('consumed');
    expect(mockComments.get('c-other')?.reactions).toEqual({});
    expect(shelved('ok-3')).toBe(0);
  });

  test('негодный конверт отказом и остаётся', async () => {
    const author = newIdentity();
    givenPost(author, 'ok-4');
    const bad = commentReaction(author, 'ok-4', 'c-bad', '');
    expect(await deliver(author, bad)).toBe('consumed');
    expect(shelved('ok-4')).toBe(0);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отсрочка нужна лишь потому, что второго раза у этого конверта нет. Очередь
 * повторов реакции на комментарий наполняется по НЕудаче доставки: конверт,
 * дошедший до всех и отвергнутый получателем, в неё не попадает вовсе.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: дошедший конверт не повторяют', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('в очередь реакция попадает только при неудаче доставки', () => {
    const at = CODE.indexOf("type: 'feed_comment_reaction',");
    expect(at).toBeGreaterThan(-1);
    const tail = CODE.slice(at);
    const retry = tail.indexOf('if (feedBroadcastNeedsRetry(res)) {');
    expect(retry).toBeGreaterThan(-1);
    expect(tail.slice(retry, retry + 400)).toContain("kind: 'comment_reaction',");
  });

  test('запись значков отвечает словом, а не бросает', () => {
    expect(CODE).toContain('if (!(await s.updateCommentReactions(d.commentId, reactions))) {');
  });
});

describe('форма исходников: пятый род на полке и второй повод её разобрать', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedDeferred.ts'), 'utf8');
  const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  const CODE = SERVICE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('реакция на комментарий откладывается и у неё своя ячейка', () => {
    // v4.32.825: следом за реакцией на полку лёг шестой род — удаление
    // комментария, — так что реакция перестала быть последней в перечислении.
    expect(SRC).toContain("  | 'feed_comment_reaction'\n");
    expect(SRC).toContain("  'feed_comment_reaction',\n");
    expect(SRC).toContain("return `cr|${String(d.commentId ?? '')}|${e.authorDid}|${String(d.emoji ?? '')}`;");
  });

  test('полка разбирается и при приходе комментария', () => {
    const at = CODE.indexOf("case 'feed_comment': {");
    expect(at).toBeGreaterThan(-1);
    const body = CODE.slice(at, CODE.indexOf("case 'feed_comment_delete': {", at));
    const dup = body.indexOf("log.debug('feed_comment_duplicate_skip'");
    const drain = body.indexOf('await drainDeferred(payload.postId, s, envelopePid);');
    expect(dup).toBeGreaterThan(-1);
    // Разбор полки стоит ПОСЛЕ проверки на повтор: иначе неочистившаяся полка
    // звала бы сама себя без конца.
    expect(drain).toBeGreaterThan(dup);
  });
});
