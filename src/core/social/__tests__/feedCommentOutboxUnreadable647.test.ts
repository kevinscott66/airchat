/**
 * Непрочитанная очередь комментариев — не пустая очередь (v4.32.647).
 *
 * Комментарий, удаление комментария и реакция на него, которые не доехали до
 * контактов с первого раза, ложатся в одну kv-строку и разбираются повторами.
 * Строку читали через `kvGet`, который отвечает `null` и когда её нет, и когда
 * её не удалось прочитать. Один сбой чтения означал «в очереди ничего нет», а
 * записывают её целиком: `enqueueCommentOutboxItem` клал поверх файла очередь
 * из одной своей записи, и все остальные недоставленные комментарии, удаления
 * и реакции пропадали. Потерянное удаление обиднее прочего — у получателя
 * комментарий так и остаётся висеть, хотя автор его стёр.
 *
 * Писали через `kvSet`, который гасит свой отказ и возвращает `void`: запись,
 * которой не случилось, выглядела ровно так же, как отложенная на повтор.
 *
 * И тот же ответ `null` гасил таймер повторов: разбор не заводил себя заново,
 * а `resumeCommentOutbox` молча уходил — очередь оставалась лежать до
 * следующего запуска приложения.
 */
// Без этого мока проба сети падает, checkOnlineWrite отвечает offline, и рассылка
// не случается вовсе — проверять было бы нечего.
jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));

/** Доходит ли рассылка до единственного контакта. */
const mockDeliver = { ok: false };
// jest.mock поднимается выше объявлений, поэтому сама заглушка создаётся внутри
// фабрики, а наружу берётся уже из мока — иначе в объект лёг бы undefined.
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => mockDeliver.ok) },
}));

const mockPeerPk = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => [{ peerPublicKey: mockPeerPk }]),
}));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

type PostRow = { id: string; authorDid: string; text: string; timestamp: number };
type CommentRow = { id: string; postId: string; authorDid: string; authorName: string; text: string; timestamp: number };
const mockPosts = new Map<string, PostRow>();
const mockComments = new Map<string, CommentRow>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
    async addComment(row: CommentRow): Promise<boolean> { mockComments.set(row.id, row); return true; }
    async deleteComment(id: string): Promise<void> { mockComments.delete(id); }
    async getComments(postId: string): Promise<CommentRow[]> {
      return [...mockComments.values()].filter((c) => c.postId === postId);
    }
    async getCommentMeta(id: string): Promise<unknown> {
      const c = mockComments.get(id);
      return c ? { authorDid: c.authorDid, postId: c.postId, reactions: null } : null;
    }
  },
}));

const mockKv = new Map<string, string>();
const mockOutboxKey = 'feed_comment_outbox_v1';
/** Сколько раз строку очереди комментариев уже читали за тест. */
let mockReads = 0;
/** С какого по счёту чтения строка «не читается». 0 — читается всегда. */
let mockFailReadFrom = 0;
/** Отвечает ли запись строки отказом. */
let mockFailWrite = false;

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => {
    if (k !== mockOutboxKey) return { value: mockKv.get(k) ?? null };
    mockReads += 1;
    if (mockFailReadFrom > 0 && mockReads >= mockFailReadFrom) return null;
    return { value: mockKv.get(k) ?? null };
  }),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (k === mockOutboxKey && mockFailWrite) return false;
    mockKv.set(k, v);
    return true;
  }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetInlineAttachment: jest.fn(async () => null),
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
  putPublicPostCopy: jest.fn(async () => false),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { multiTransportRouter } from '../../transport/multiTransport';
import {
  addAndBroadcastComment,
  deleteFeedComment,
  resumeCommentOutbox,
  setFeedProfileContext,
} from '../feedService';

const mockSend = multiTransportRouter.send as unknown as jest.Mock;

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

type OutboxItem = {
  key: string; authorDid: string; kind: string; commentId: string; postId: string;
  text: string; authorName: string; ts: number; retries: number; createdAt: number;
};

/** Что сейчас лежит в строке очереди на «диске». `null` — строки нет вовсе. */
function stored(): OutboxItem[] | null {
  const raw = mockKv.get(mockOutboxKey);
  return raw === undefined ? null : (JSON.parse(raw) as OutboxItem[]);
}

function keys_(): string[] {
  return (stored() ?? []).map((it) => it.key);
}

function seedOutbox(items: OutboxItem[]): void {
  mockKv.set(mockOutboxKey, JSON.stringify(items));
}

function item(key: string, commentId: string): OutboxItem {
  return {
    key, authorDid: myDid, kind: 'comment', commentId, postId: 'p1',
    text: 'отложенный', authorName: 'Я',
    ts: Date.now(), retries: 0, createdAt: Date.now(),
  };
}

/** Дать доработать разбору очереди, который запущен без ожидания результата. */
async function settle(): Promise<void> {
  await jest.advanceTimersByTimeAsync(1);
}

beforeAll(async () => {
  // Таймер повтора заводится сразу после неудачи; будить его в тесте незачем.
  jest.useFakeTimers();
  await setFeedProfileContext(1);
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.clearAllTimers();
  mockKv.clear();
  mockPosts.clear();
  mockComments.clear();
  mockSend.mockClear();
  mockDeliver.ok = false;
  mockReads = 0;
  mockFailReadFrom = 0;
  mockFailWrite = false;
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'пост', timestamp: Date.now() });
  mockPosts.set('p2', { id: 'p2', authorDid: myDid, text: 'второй', timestamp: Date.now() });
});

describe('повод для правки жив', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  test('kvGet по-прежнему не различает «нет строки» и «не прочиталось»', () => {
    expect(LOCAL).toContain('export async function kvGet(key: string): Promise<string | null> {\n  return (await kvTryGet(key))?.value ?? null;\n}');
    expect(LOCAL).toContain('export async function kvTryGet(key: string): Promise<{ value: string | null } | null> {');
  });

  test('kvSet по-прежнему молчит об отказе, kvSetChecked — нет', () => {
    expect(LOCAL).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(LOCAL).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
  });
});

describe('проверка не пустая: очередь читается — всё как было', () => {
  test('два недоставленных комментария копятся, а не вытесняют друг друга', async () => {
    const a = await addAndBroadcastComment(pair, 'p1', 'первый', 'Я');
    const b = await addAndBroadcastComment(pair, 'p2', 'второй', 'Я');
    expect(keys_()).toEqual([a.id, b.id]);
  });

  test('удаление вытесняет свой же коммент, чужую запись не трогая', async () => {
    const a = await addAndBroadcastComment(pair, 'p1', 'первый', 'Я');
    const b = await addAndBroadcastComment(pair, 'p2', 'второй', 'Я');
    await deleteFeedComment(pair, a.id);
    expect(keys_()).toEqual([b.id, `del:${a.id}`]);
  });

  test('доставленный комментарий в очередь не ложится', async () => {
    mockDeliver.ok = true;
    await addAndBroadcastComment(pair, 'p1', 'дошёл', 'Я');
    expect(stored()).toBeNull();
  });
});

describe('очередь не прочиталась — её не переписывают', () => {
  test('новый комментарий не кладётся поверх остальных', async () => {
    seedOutbox([item('c1', 'c1'), item('c2', 'c2')]);
    const before = mockKv.get(mockOutboxKey);
    mockFailReadFrom = 1;
    await addAndBroadcastComment(pair, 'p1', 'третий', 'Я');
    // До правки здесь оставалась одна новая запись, а c1 и c2 исчезали
    // навсегда — вместе с удалениями, которых получатель так и не увидит.
    expect(mockKv.get(mockOutboxKey)).toBe(before);
  });

  test('удаление комментария не стирает очередь', async () => {
    const a = await addAndBroadcastComment(pair, 'p1', 'первый', 'Я');
    seedOutbox([item('c1', 'c1'), item('c2', 'c2')]);
    const before = mockKv.get(mockOutboxKey);
    mockReads = 0;
    mockFailReadFrom = 1;
    await deleteFeedComment(pair, a.id);
    expect(mockKv.get(mockOutboxKey)).toBe(before);
  });

  test('проход по непрочитанной очереди ничего не пишет и не рассылает', async () => {
    seedOutbox([item('c1', 'c1')]);
    const before = mockKv.get(mockOutboxKey);
    mockDeliver.ok = true;
    mockFailReadFrom = 1;
    resumeCommentOutbox(pair);
    await settle();
    expect(mockKv.get(mockOutboxKey)).toBe(before);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('очередь не записалась — отказ не выдают за успех', () => {
  test('на диске остаётся прежнее', async () => {
    seedOutbox([item('c1', 'c1')]);
    const before = mockKv.get(mockOutboxKey);
    mockFailWrite = true;
    await addAndBroadcastComment(pair, 'p1', 'третий', 'Я');
    expect(mockKv.get(mockOutboxKey)).toBe(before);
  });

  test('комментарий всё равно сохраняется локально и наружу не падает', async () => {
    mockFailWrite = true;
    const row = await addAndBroadcastComment(pair, 'p1', 'третий', 'Я');
    expect(mockComments.get(row.id)?.text).toBe('третий');
  });

  test('итог прохода не лёг — записи остаются в очереди', async () => {
    seedOutbox([item('c1', 'c1')]);
    const before = mockKv.get(mockOutboxKey);
    mockDeliver.ok = true;
    mockFailWrite = true;
    resumeCommentOutbox(pair);
    await settle();
    // Доставленный второй раз комментарий получатель отбросит по INSERT OR
    // IGNORE; потерянная запись — это комментарий, которого он не увидит.
    expect(mockKv.get(mockOutboxKey)).toBe(before);
    expect(mockSend).toHaveBeenCalled();
  });

  test('проверка не пустая: когда запись проходит, разобранное из очереди уходит', async () => {
    seedOutbox([item('c1', 'c1')]);
    mockDeliver.ok = true;
    resumeCommentOutbox(pair);
    await settle();
    expect(stored()).toEqual([]);
  });
});

describe('форма источника: отказ очереди комментариев виден всем её путям', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  /** Строки кода без комментариев — иначе объяснение сойдёт за сам код. */
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('очередь читают через kvTryGet, а не через kvGet', () => {
    expect(CODE).not.toContain('await kvGet(COMMENT_OUTBOX_KEY)');
    expect(CODE).toContain('const read = await kvTryGet(COMMENT_OUTBOX_KEY);');
    expect(CODE).toContain('async function loadCommentOutbox(): Promise<CommentOutboxItem[] | null> {');
  });

  test('очередь пишут проверенной записью', () => {
    expect(CODE).not.toContain('await kvSet(COMMENT_OUTBOX_KEY');
    expect(CODE).toContain('async function saveCommentOutbox(q: CommentOutboxItem[]): Promise<boolean> {');
    expect(CODE).toContain('if (await kvSetChecked(COMMENT_OUTBOX_KEY,');
  });

  test('изменение либо ложится целиком, либо не происходит', () => {
    expect(CODE).toContain('if (current === null) throw new Error(COMMENT_OUTBOX_UNAVAILABLE);');
    expect(CODE).toContain('if (!(await saveCommentOutbox(next))) throw new Error(COMMENT_OUTBOX_UNAVAILABLE);');
  });

  test('у файла очереди один владелец, и он не ждёт сеть', () => {
    // Единственная запись — внутри транзакции.
    expect((CODE.match(/await saveCommentOutbox\(/g) ?? []).length).toBe(1);
    expect(CODE).toContain('const started = commentQueueTx.then(run, run);');
    // `apply` синхронная: в неё нельзя вписать поход в сеть, а значит нельзя и
    // снова завести «прочитал старое, записал поверх нового».
    expect(CODE).toContain('apply: (q: CommentOutboxItem[]) => { next: CommentOutboxItem[]; value: T }');
  });

  test('непрочитанная очередь держит таймер повторов, а не гасит его', () => {
    expect(CODE).toContain('scheduleCommentOutboxRetry(p, delayMs);');
    expect(CODE).toContain('if (q === null) { scheduleCommentOutboxRetry(pair, RETRY_DELAY_MS); return; }');
    expect(CODE).toContain('if (tail === null || tail.length > 0) scheduleCommentOutboxRetry(pair, RETRY_DELAY_MS);');
  });
});
