/**
 * Отметка «опубликовано по ссылке» и отзыв ссылки (AC-04).
 *
 * Отметка ставится только после того, как сервер принял копию, снимается
 * отзывом и удалением записи. Отзыв убирает с сервера открытую копию своим
 * подписанным `feed_delete` и не трогает саму запись; отказ сервера оставляет
 * отметку — ссылка ещё открывается, и говорить обратное нельзя.
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
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetInlineAttachment: jest.fn(async () => null),
  kvTryGetInlineAttachment: jest.fn(async () => ({ value: null })),
  kvSetInlineAttachment: jest.fn(async () => true),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  kvListKeysByPrefix: jest.fn(async (prefix: string) => [...mockKv.keys()].filter((k) => k.startsWith(prefix))),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

const mockServer = { copies: new Set<string>(), putWorks: true, deleteWorks: true };
const mockDeleteTypes: string[] = [];

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  isPublicPostId: () => true,
  publicPostCopyExists: jest.fn(async (postId: string) => mockServer.copies.has(postId)),
  putPublicPostCopy: jest.fn(async (_p: unknown, payload: { postId: string }) => {
    if (!mockServer.putWorks) return false;
    mockServer.copies.add(payload.postId);
    return true;
  }),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async (_p: unknown, payload: { postId: string; type: string }) => {
    mockDeleteTypes.push(payload.type);
    if (!mockServer.deleteWorks) return false;
    mockServer.copies.delete(payload.postId);
    return true;
  }),
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { publishPostLinkCopy, refreshPublicPostCopy, revokePostLinkCopy, setFeedProfileContext } from '../feedService';
import { listLinkPublishedPostIds } from '../postLinkState';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => {
  mockPosts.clear();
  mockKv.clear();
  mockServer.copies.clear();
  mockServer.putWorks = true;
  mockServer.deleteWorks = true;
  mockDeleteTypes.length = 0;
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'запись', timestamp: 1000 });
});

describe('отметка «опубликовано по ссылке»', () => {
  it('ставится после того, как сервер принял копию', async () => {
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect([...(await listLinkPublishedPostIds())]).toEqual(['p1']);
  });

  it('не ставится, если сервер копию не принял', async () => {
    mockServer.putWorks = false;
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    expect((await listLinkPublishedPostIds()).size).toBe(0);
  });

  it('копия, выложенная старой версией, находится при правке и получает отметку', async () => {
    mockServer.copies.add('p1');
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(true);
    expect((await listLinkPublishedPostIds()).has('p1')).toBe(true);
  });

  it('правка неопубликованной записи отметку не ставит', async () => {
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(true);
    expect((await listLinkPublishedPostIds()).size).toBe(0);
  });
});

describe('отзыв ссылки', () => {
  it('снимает копию и отметку, но не трогает саму запись', async () => {
    await publishPostLinkCopy(pair, 'p1');
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockServer.copies.has('p1')).toBe(false);
    expect((await listLinkPublishedPostIds()).size).toBe(0);
    expect(mockPosts.has('p1')).toBe(true);
    // Сервер принимает для снятия копии подписанный feed_delete.
    expect(mockDeleteTypes).toEqual(['feed_delete']);
  });

  it('отказ сервера — отметка остаётся, отзыв не выдаётся за удавшийся', async () => {
    await publishPostLinkCopy(pair, 'p1');
    mockServer.deleteWorks = false;
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(false);
    expect(mockServer.copies.has('p1')).toBe(true);
    expect((await listLinkPublishedPostIds()).has('p1')).toBe(true);
  });
});
