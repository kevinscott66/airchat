/**
 * Удаление копии по ссылке не теряется (v4.32.614).
 *
 * Копия лежит на сервере отдельно от контактов: её открывает кто угодно по
 * ссылке, а не только те, кому запись рассылали. `deleteFeedPost` отправляла
 * запрос на её удаление без ожидания результата — `void ... .catch(() => {})` —
 * и сразу показывала «Публикация удалена у всех». Отказ сервера, разорванная
 * сеть, закрытое приложение: любой из этих исходов оставлял запись открытой по
 * ссылке навсегда, потому что второй попытки не было, а повторно удалить уже
 * нечего — у себя пост стёрт.
 *
 * Теперь исход дожидаются: неудача ложится в очередь и повторяется на каждом
 * прогоне очереди публикации, а вызывающий узнаёт о ней и говорит правду.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

type Row = { id: string; authorDid: string; text: string; timestamp: number };
const mockPosts = new Map<string, Row>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
  },
}));

const mockKv = new Map<string, string>();
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetInlineAttachment: jest.fn(async () => null),
  kvTryGetInlineAttachment: jest.fn(async () => ({ value: null })),
  kvSetInlineAttachment: jest.fn(async () => true),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

/** Что сейчас лежит на сервере под ссылкой. */
const mockCopyOnServer = new Set<string>();
/** Разрешён ли серверу успех удаления — так изображается отказ или обрыв сети. */
const mockDeleteWorks = { ok: true };
const mockDeleteCalls: string[] = [];

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  isPublicPostId: (id: string) => /^[A-Za-z0-9_\-.:]{1,128}$/.test(id),
  publicPostCopyExists: jest.fn(async (postId: string) => mockCopyOnServer.has(postId)),
  putPublicPostCopy: jest.fn(async () => true),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async (_pair: unknown, payload: { postId: string }) => {
    mockDeleteCalls.push(payload.postId);
    if (!mockDeleteWorks.ok) return false;
    mockCopyOnServer.delete(payload.postId);
    return true;
  }),
}));

import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { deleteFeedPost, flushFeedPublishQueue, setFeedProfileContext } from '../feedService';

const OUTBOX_KEY = 'feed_link_delete_outbox_v1';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

const outbox = (): { postId: string; authorDid: string }[] => {
  const raw = mockKv.get(OUTBOX_KEY);
  return raw ? (JSON.parse(raw) as { postId: string; authorDid: string }[]) : [];
};

beforeAll(async () => {
  // Таймер повтора заводится сразу после неудачи; в тесте ему просыпаться незачем.
  jest.useFakeTimers();
  await setFeedProfileContext(1);
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  mockPosts.clear();
  mockKv.clear();
  mockCopyOnServer.clear();
  mockDeleteCalls.length = 0;
  mockDeleteWorks.ok = true;
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'моё', timestamp: 1000 });
});

describe('копия по ссылке при удалении записи', () => {
  it('удалена вместе с записью — охват честный, очередь пуста', async () => {
    mockCopyOnServer.add('p1');
    const reach = await deleteFeedPost(pair, 'p1');
    expect(mockDeleteCalls).toEqual(['p1']);
    expect(mockCopyOnServer.has('p1')).toBe(false);
    expect(reach.linkCopyLeft).toBe(false);
    expect(outbox()).toEqual([]);
  });

  it('сервер отказал — охват говорит правду, а не «удалена у всех»', async () => {
    mockCopyOnServer.add('p1');
    mockDeleteWorks.ok = false;
    const reach = await deleteFeedPost(pair, 'p1');
    expect(reach.linkCopyLeft).toBe(true);
    expect(outbox().map((it) => it.postId)).toEqual(['p1']);
  });

  it('отложенное удаление доводится до конца на следующем прогоне очереди', async () => {
    mockCopyOnServer.add('p1');
    mockDeleteWorks.ok = false;
    await deleteFeedPost(pair, 'p1');
    expect(mockCopyOnServer.has('p1')).toBe(true);

    mockDeleteWorks.ok = true;
    await flushFeedPublishQueue(pair);
    expect(mockCopyOnServer.has('p1')).toBe(false);
    expect(outbox()).toEqual([]);
  });

  it('прогон пустой очереди публикации всё равно доходит до копии', async () => {
    // Очередь постов пуста всегда: пост удалён, отправлять нечего. Ровно этот
    // случай и должен доводить удаление копии до конца.
    mockKv.set(OUTBOX_KEY, JSON.stringify([{ postId: 'p9', authorDid: myDid, createdAt: Date.now() }]));
    mockCopyOnServer.add('p9');
    await flushFeedPublishQueue(pair);
    expect(mockDeleteCalls).toEqual(['p9']);
    expect(outbox()).toEqual([]);
  });

  it('копии не было — отказ сервера не считается потерей', async () => {
    // Ссылку никто не копировал, класть на сервер было нечего. HEAD это
    // подтверждает, и человеку незачем читать про копию, которой нет.
    mockDeleteWorks.ok = false;
    const reach = await deleteFeedPost(pair, 'p1');
    expect(reach.linkCopyLeft).toBe(false);
    expect(outbox()).toEqual([]);
  });

  it('чужую запись очереди не трогает — её удаляет свой ключ', async () => {
    const alien = publicKeyToDidKey(ed25519.keygen().publicKey);
    mockKv.set(OUTBOX_KEY, JSON.stringify([{ postId: 'p8', authorDid: alien, createdAt: Date.now() }]));
    mockCopyOnServer.add('p8');
    await flushFeedPublishQueue(pair);
    expect(mockDeleteCalls).toEqual([]);
    expect(outbox().map((it) => it.postId)).toEqual(['p8']);
  });

  it('просроченная запись очереди отваливается', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    mockKv.set(OUTBOX_KEY, JSON.stringify([{ postId: 'p7', authorDid: myDid, createdAt: old }]));
    await flushFeedPublishQueue(pair);
    expect(mockDeleteCalls).toEqual([]);
    expect(outbox()).toEqual([]);
  });
});

describe('исход удаления копии не выбрасывается', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

  it('вызов больше не «отправил и забыл»', () => {
    expect(SRC).not.toContain('void deletePublicPostCopy(');
  });

  it('охват несёт судьбу копии', () => {
    expect(SRC).toContain('linkCopyLeft: !copyGone,');
  });
});
