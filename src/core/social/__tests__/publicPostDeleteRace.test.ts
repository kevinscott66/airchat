/**
 * Копия по ссылке не переживает удаления публикации (v4.32.614).
 *
 * Конверт подписывается до запроса, а сам запрос живёт до двадцати секунд.
 * В этот промежуток целиком помещается удаление: строка стёрта, контактам
 * ушёл `feed_delete`, сервер копию убрал — и следом приходит наш PUT и кладёт
 * её обратно. Убирать её потом некому: у удаления запрос прошёл успешно и в
 * очередь повторов оно ничего не поставило.
 *
 * Ссылка после этого открывает запись, которой нет ни у автора, ни у его
 * контактов, — и открывает кому угодно, а не только им.
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
  },
}));

const mockKv = new Map<string, string>();
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
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

/** Что происходит на сервере, пока идёт наш запрос. */
const mockServer = { copies: new Set<string>(), deleteWorks: true };
const mockCalls: string[] = [];
/** Удаление публикации, которое случается ровно во время PUT. */
let mockDeleteDuringPut: (() => void) | null = null;

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  isPublicPostId: () => true,
  publicPostCopyExists: jest.fn(async (postId: string) => mockServer.copies.has(postId)),
  putPublicPostCopy: jest.fn(async (_p: unknown, payload: { postId: string }) => {
    mockCalls.push(`put:${payload.postId}`);
    mockServer.copies.add(payload.postId);
    mockDeleteDuringPut?.();
    return true;
  }),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async (_p: unknown, payload: { postId: string }) => {
    mockCalls.push(`del:${payload.postId}`);
    if (!mockServer.deleteWorks) return false;
    mockServer.copies.delete(payload.postId);
    return true;
  }),
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { publishPostLinkCopy, refreshPublicPostCopy, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => {
  mockPosts.clear();
  mockKv.clear();
  mockServer.copies.clear();
  mockServer.deleteWorks = true;
  mockCalls.length = 0;
  mockDeleteDuringPut = null;
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'запись', timestamp: 1000 });
});

describe('удаление во время выкладки копии', () => {
  it('без удаления копия остаётся лежать', async () => {
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockServer.copies.has('p1')).toBe(true);
    expect(mockCalls).toEqual(['put:p1']);
  });

  it('публикацию удалили во время запроса — копия не остаётся на сервере', async () => {
    mockDeleteDuringPut = () => { mockPosts.delete('p1'); };

    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    expect(mockServer.copies.has('p1')).toBe(false);
    expect(mockCalls).toEqual(['put:p1', 'del:p1']);
  });

  it('сервер не убрал копию — она попадает в очередь повторов', async () => {
    mockDeleteDuringPut = () => { mockPosts.delete('p1'); };
    mockServer.deleteWorks = false;

    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    // Отказ удаления перепроверяется через HEAD; копия там осталась.
    expect(mockServer.copies.has('p1')).toBe(true);
    const queued = JSON.parse(mockKv.get('feed_link_delete_outbox_v1') ?? '[]') as { postId: string }[];
    expect(queued.map((it) => it.postId)).toEqual(['p1']);
  });

  it('то же самое при обновлении копии после правки', async () => {
    mockServer.copies.add('p1');
    mockDeleteDuringPut = () => { mockPosts.delete('p1'); };

    await refreshPublicPostCopy(pair, 'p1');
    expect(mockServer.copies.has('p1')).toBe(false);
    expect(mockCalls).toEqual(['put:p1', 'del:p1']);
  });
});
