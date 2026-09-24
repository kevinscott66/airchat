/**
 * Удаление, обогнавшее свой комментарий, больше не пропадает (v4.32.825).
 *
 * Дефект. Удаление комментария применяется по его строке: она называет автора,
 * и по ней решается, вправе ли отправитель стирать. Строки нет — оставался
 * один надёжный случай: автор публикации, он же хозяин своей ленты, и ему
 * разрешалось поставить надгробие заранее. Всякий другой конверт молча
 * выбрасывался с ответом «разобрано». А всякий другой — это прежде всего сам
 * автор комментария.
 *
 * Цена. Пути у комментария и у его удаления разные: комментарий доходит до
 * третьего лица пересылкой по цепочке, удаление — напрямую от стёршего. Плюс
 * кадры одной пачки ретранслятора разбираются параллельно. Повтора у удаления
 * нет вовсе — очередь наполняется только при НЕудаче доставки, а этот конверт
 * дошёл и был отвергнут. Итог: человек стёр свой комментарий, у себя его не
 * видит, а у соседа тот живёт вечно — и объяснить это нечем.
 *
 * Правка. Полка отложенных приняла шестой род событий. Удаление ложится на неё
 * под номером публикации — туда же, куда ложится сам комментарий, — и ждёт
 * его. Разрешение проверяется при применении, когда автор комментария уже
 * известен, так что полка никому никаких прав не даёт: чужое удаление отсеется
 * ровно так же, как отсеялось бы сразу, — только после того, как станет с чем
 * сравнивать.
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
/** Надгробия: номер комментария → номер публикации. */
const mockTombstones = new Map<string, string>();

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
      // Настоящая отказывает и повтору, и воскрешению стёртого: надгробие для
      // того и ставится, чтобы опоздавший комментарий не вернулся.
      if (mockComments.has(row.id) || mockTombstones.has(row.id)) return false;
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
    async deleteComment(id: string): Promise<void> {
      // Настоящая стирает строку и ставит надгробие одной сделкой (v4.32.626).
      const c = mockComments.get(id);
      if (c) mockTombstones.set(id, c.postId);
      mockComments.delete(id);
    }
    async addCommentTombstone(id: string, postId: string): Promise<void> {
      if (!mockTombstones.has(id)) mockTombstones.set(id, postId);
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

function commentDelete(
  id: Identity,
  postId: string,
  commentId: string,
  ts = T0 + 1000,
): FeedEnvelopePayload {
  return {
    type: 'feed_comment_delete',
    postId,
    authorDid: id.did,
    ts,
    data: { kind: 'comment_delete', commentId },
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
  mockTombstones.clear();
  mockFailDeferWrite = false;
});

describe('комментария ещё нет — удаление ждёт его', () => {
  test('удаление от автора комментария ложится на полку, а не выбрасывается', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'p-1');
    // До правки здесь не оставалось ничего: разбор выходил молча и отвечал
    // «разобрано», а второй раз удаление не шлёт никто.
    expect(await deliver(neighbour, commentDelete(neighbour, 'p-1', 'c-1'))).toBe('consumed');
    expect(shelved('p-1')).toBe(1);
  });

  test('комментарий пришёл — и тут же был стёрт', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'p-2');
    await deliver(neighbour, commentDelete(neighbour, 'p-2', 'c-2'));

    expect(await deliver(neighbour, comment(neighbour, 'p-2', 'c-2'))).toBe('consumed');
    expect(mockComments.has('c-2')).toBe(false);
    // И назад он не вернётся: удаление оставило надгробие.
    expect(mockTombstones.get('c-2')).toBe('p-2');
    // Полка по этой публикации разобрана до конца.
    expect(shelved('p-2')).toBe(0);
  });

  test('полка не приняла удаление — кадр не разобран', async () => {
    mockFailDeferWrite = true;
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'p-3');
    expect(await deliver(neighbour, commentDelete(neighbour, 'p-3', 'c-3'))).toBe('deferred');
  });

  test('и публикации нет тоже: обоих ждёт одна полка', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    await deliver(neighbour, commentDelete(neighbour, 'p-4', 'c-4'));
    await deliver(neighbour, comment(neighbour, 'p-4', 'c-4'));
    expect(shelved('p-4')).toBe(2);

    // Публикация пришла — по возрастанию времени сначала комментарий, потом
    // удаление: то есть ровно тот порядок, в котором всё это случилось.
    const post = {
      type: 'feed_post',
      postId: 'p-4',
      authorDid: postAuthor.did,
      ts: T0,
      data: { kind: 'post', text: 'пост' },
    } as unknown as FeedEnvelopePayload;
    expect(await deliver(postAuthor, post)).toBe('consumed');
    expect(mockComments.has('c-4')).toBe(false);
    expect(mockTombstones.get('c-4')).toBe('p-4');
  });

  test('повтор того же удаления второго места на полке не занимает', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'p-5');
    await deliver(neighbour, commentDelete(neighbour, 'p-5', 'c-5', T0 + 1000));
    await deliver(neighbour, commentDelete(neighbour, 'p-5', 'c-5', T0 + 2000));
    expect(shelved('p-5')).toBe(1);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Полка не выдаёт разрешений. Номер комментария в чужом подписанном конверте
 * выдуман отправителем так же, как номер публикации, и если бы отложенное
 * применялось без проверки, любой контакт стирал бы чужие комментарии, просто
 * успев первым. Проверка стоит там же, где и стояла, — на применении.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: с полки удаление выходит на ту же проверку прав', () => {
  test('посторонний подождал на полке и всё равно отсеян', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    const stranger = newIdentity();
    givenPost(postAuthor, 'ok-1');
    await deliver(stranger, commentDelete(stranger, 'ok-1', 'c-ok1'));
    expect(shelved('ok-1')).toBe(1);

    await deliver(neighbour, comment(neighbour, 'ok-1', 'c-ok1'));
    expect(mockComments.has('c-ok1')).toBe(true);
    expect(mockTombstones.has('c-ok1')).toBe(false);
  });

  test('автор публикации ставит надгробие сразу, а не ложится на полку', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'ok-2');
    expect(await deliver(postAuthor, commentDelete(postAuthor, 'ok-2', 'c-ok2'))).toBe('consumed');
    expect(shelved('ok-2')).toBe(0);
    expect(mockTombstones.get('c-ok2')).toBe('ok-2');

    // И опоздавший комментарий не воскресает — ради этого надгробие и ставят.
    await deliver(neighbour, comment(neighbour, 'ok-2', 'c-ok2'));
    expect(mockComments.has('c-ok2')).toBe(false);
  });

  test('комментарий на месте — удаление применяется сразу', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'ok-3');
    await deliver(neighbour, comment(neighbour, 'ok-3', 'c-ok3'));

    expect(await deliver(neighbour, commentDelete(neighbour, 'ok-3', 'c-ok3'))).toBe('consumed');
    expect(mockComments.has('c-ok3')).toBe(false);
    expect(shelved('ok-3')).toBe(0);
  });

  test('комментарий живёт под другой публикацией — отказ, и ждать нечего', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'ok-4');
    givenPost(postAuthor, 'ok-5');
    await deliver(neighbour, comment(neighbour, 'ok-4', 'c-other'));

    expect(await deliver(neighbour, commentDelete(neighbour, 'ok-5', 'c-other'))).toBe('consumed');
    expect(mockComments.has('c-other')).toBe(true);
    expect(shelved('ok-5')).toBe(0);
  });

  test('негодный конверт отказом и остаётся', async () => {
    const postAuthor = newIdentity();
    const neighbour = newIdentity();
    givenPost(postAuthor, 'ok-6');
    expect(await deliver(neighbour, commentDelete(neighbour, 'ok-6', ''))).toBe('consumed');
    expect(shelved('ok-6')).toBe(0);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отсрочка нужна лишь потому, что второго раза у этого конверта нет. Очередь
 * повторов удаления наполняется по НЕудаче доставки: конверт, дошедший до всех
 * и отвергнутый получателем как сирота, в неё не попадает вовсе.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: дошедший конверт не повторяют', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('в очередь удаление попадает только при неудаче доставки', () => {
    const at = CODE.indexOf("const data: FeedCommentDeleteData = { kind: 'comment_delete', commentId };");
    expect(at).toBeGreaterThan(-1);
    const tail = CODE.slice(at);
    const retry = tail.indexOf('if (feedBroadcastNeedsRetry(res)) {');
    expect(retry).toBeGreaterThan(-1);
    expect(tail.slice(retry, retry + 300)).toContain("kind: 'comment_delete',");
  });
});

describe('форма исходников: шестой род на полке', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedDeferred.ts'), 'utf8');
  const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  const CODE = SERVICE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('удаление откладывается и у него своя ячейка — с отправителем', () => {
    expect(SRC).toContain("  | 'feed_comment_delete';");
    expect(SRC).toContain("  'feed_comment_delete',\n];");
    expect(SRC).toContain("return `cd|${String(d.commentId ?? '')}|${e.authorDid}`;");
  });

  test('надгробие заранее ставит только автор публикации, остальное — на полку', () => {
    const at = CODE.indexOf("case 'feed_comment_delete': {");
    expect(at).toBeGreaterThan(-1);
    const body = CODE.slice(at, CODE.indexOf("case 'feed_repost': {", at));
    const guard = body.indexOf('if (isPostAuthor) {');
    const tomb = body.indexOf('await s.addCommentTombstone(d.commentId, payload.postId);');
    const shelf = body.indexOf("if ((await deferFeedEvent(payload, envelopePid)) === 'failed') return 'deferred';");
    expect(guard).toBeGreaterThan(-1);
    expect(tomb).toBeGreaterThan(guard);
    // Полка — ветка для всех прочих, то есть строго после надгробия.
    expect(shelf).toBeGreaterThan(tomb);
  });
});
