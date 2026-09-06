/**
 * Правка догоняет копию по ссылке (v4.32.614).
 *
 * `editFeedPost` рассылала `feed_edit` контактам и на этом заканчивала. Копия
 * на сервере — та, которую автор выложил в момент «скопировать ссылку», —
 * оставалась прежней. Ссылка после правки продолжала отдавать старую редакцию,
 * в том числе ту самую строку, ради удаления которой человек и полез править;
 * а ссылку он к тому времени уже кому-то отдал, иначе копии бы не было.
 *
 * Обратная сторона так же важна: правка не должна ЗАВОДИТЬ копию. Запись,
 * ссылку на которую никто не копировал, наружу не отдавали, и класть её на
 * сервер по одной лишь правке — значит опубликовать то, чего человек не
 * публиковал. Поэтому копия сначала проверяется на существование (HEAD, без
 * скачивания тела) и только потом переписывается.
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

type Row = {
  id: string;
  authorDid: string;
  text: string;
  timestamp: number;
  authorName?: string;
};
const mockPosts = new Map<string, Row>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
    async updatePostText(id: string, text: string): Promise<void> {
      const row = mockPosts.get(id);
      if (row) row.text = text;
    }
  },
}));

const mockCopyOnServer = new Set<string>();
const mockPutCalls: { postId: string; text: string; ts: number }[] = [];
const mockPutResult = { ok: true };

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  publicPostCopyExists: jest.fn(async (postId: string) => mockCopyOnServer.has(postId)),
  putPublicPostCopy: jest.fn(async (
    _pair: unknown,
    payload: { postId: string; ts: number; data: { text: string } },
  ) => {
    mockPutCalls.push({ postId: payload.postId, text: payload.data.text, ts: payload.ts });
    return mockPutResult.ok;
  }),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { editFeedPost, refreshPublicPostCopy, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => {
  mockPosts.clear();
  mockCopyOnServer.clear();
  mockPutCalls.length = 0;
  mockPutResult.ok = true;
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'старое', timestamp: 1000, authorName: 'я' });
});

describe('копия по ссылке после правки', () => {
  it('переписывается новым текстом, когда копия на сервере есть', async () => {
    mockCopyOnServer.add('p1');
    const outcome = await editFeedPost(pair, 'p1', 'новое');
    expect(mockPutCalls).toEqual([{ postId: 'p1', text: 'новое', ts: 1000 }]);
    expect(outcome.linkCopyStale).toBe(false);
  });

  it('не заводится, если ссылку никто не копировал', async () => {
    const outcome = await editFeedPost(pair, 'p1', 'новое');
    expect(mockPutCalls).toHaveLength(0);
    expect(outcome.linkCopyStale).toBe(false);
  });

  it('неудача записи названа расхождением, а не успехом', async () => {
    mockCopyOnServer.add('p1');
    mockPutResult.ok = false;
    const outcome = await editFeedPost(pair, 'p1', 'новое');
    expect(outcome.linkCopyStale).toBe(true);
  });

  it('сохраняет исходное время записи — конверт остаётся тем же, что у контактов', async () => {
    // Правка меняет текст, но не момент публикации: у контактов конверт лежит
    // под своим ts, и копия по ссылке обязана совпасть с ним, иначе открывший
    // ссылку и получивший запись по сети увидели бы разные даты.
    mockCopyOnServer.add('p1');
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(true);
    expect(mockPutCalls).toEqual([{ postId: 'p1', text: 'старое', ts: 1000 }]);
  });

  it('чужую запись не трогает', async () => {
    const alien = publicKeyToDidKey(ed25519.keygen().publicKey);
    mockPosts.set('p2', { id: 'p2', authorDid: alien, text: 'чужое', timestamp: 1000 });
    mockCopyOnServer.add('p2');
    expect(await refreshPublicPostCopy(pair, 'p2')).toBe(false);
    expect(mockPutCalls).toHaveLength(0);
  });
});
