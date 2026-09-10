/**
 * Конверт по ссылке собирается целиком или не собирается вовсе (v4.32.614).
 *
 * Фотографии и документы лежат не в строке публикации, а отдельными ключами.
 * Сборка конверта пропускала ключ, которого не нашлось, — и наружу уходила
 * запись без части вложений, подписанная как настоящая. Автор при этом видел
 * успех: со стороны отправителя ссылка выглядела готовой.
 *
 * Хуже всего это ложилось на правку: она кладёт новую копию ПОВЕРХ прежней,
 * то есть запись с потерянной картинкой затирала на сервере целую. Поэтому
 * правило здесь то же, что и у нечитаемых столбцов: нет вложения — нет и
 * конверта, а вызывающий узнаёт об этом отказом.
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
  mediaCids?: string[] | null;
  documents?: { name: string; mime: string; size: number }[] | null;
};
const mockPosts = new Map<string, Row>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
  },
}));

/** Что из вложений вообще лежит на устройстве. */
const mockBlobs = new Map<string, string>();
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async () => null),
  kvTryGet: jest.fn(async () => ({ value: null })),
  kvSet: jest.fn(async () => true),
  kvSetChecked: jest.fn(async () => true),
  kvDelete: jest.fn(async () => undefined),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetInlineAttachment: jest.fn(async (k: string) => mockBlobs.get(k) ?? null),
  kvTryGetInlineAttachment: jest.fn(async (k: string) => ({ value: mockBlobs.get(k) ?? null })),
  kvSetInlineAttachment: jest.fn(async () => true),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

const mockCopyOnServer = new Set<string>();
const mockPutCalls: { postId: string; media: number; docs: number }[] = [];

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  isPublicPostId: () => true,
  publicPostCopyExists: jest.fn(async (postId: string) => mockCopyOnServer.has(postId)),
  putPublicPostCopy: jest.fn(async (
    _pair: unknown,
    payload: { postId: string; data: { media?: string[]; documents?: unknown[] } },
  ) => {
    mockPutCalls.push({
      postId: payload.postId,
      media: payload.data.media?.length ?? 0,
      docs: payload.data.documents?.length ?? 0,
    });
    return true;
  }),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { publishPostLinkCopy, refreshPublicPostCopy, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

function photoPost(n: number): Row {
  return {
    id: 'p1',
    authorDid: myDid,
    text: 'с фотографиями',
    timestamp: 1000,
    mediaCids: Array.from({ length: n }, (_, i) => `inline:image/jpeg;${i}:p1`),
  };
}

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => {
  mockPosts.clear();
  mockBlobs.clear();
  mockCopyOnServer.clear();
  mockPutCalls.length = 0;
});

describe('вложения в копии по ссылке', () => {
  it('все фотографии на месте — конверт уходит целиком', async () => {
    mockPosts.set('p1', photoPost(2));
    mockBlobs.set('feed_inline_media:p1:0', 'AAAA');
    mockBlobs.set('feed_inline_media:p1:1', 'BBBB');
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockPutCalls).toEqual([{ postId: 'p1', media: 2, docs: 0 }]);
  });

  it('одной фотографии не нашлось — наружу не уходит ничего', async () => {
    mockPosts.set('p1', photoPost(2));
    mockBlobs.set('feed_inline_media:p1:0', 'AAAA');
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    expect(mockPutCalls).toHaveLength(0);
  });

  it('правка не затирает целую копию урезанной', async () => {
    mockPosts.set('p1', photoPost(2));
    mockBlobs.set('feed_inline_media:p1:0', 'AAAA');
    mockCopyOnServer.add('p1');
    // `false` — «расхождение осталось»: экран скажет об этом автору, а прежняя
    // копия на сервере не тронута.
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(false);
    expect(mockPutCalls).toHaveLength(0);
  });

  it('документ без байтов отменяет конверт так же, как фотография', async () => {
    mockPosts.set('p1', {
      id: 'p1',
      authorDid: myDid,
      text: 'с документом',
      timestamp: 1000,
      documents: [{ name: 'смета.pdf', mime: 'application/pdf', size: 10 }],
    });
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    expect(mockPutCalls).toHaveLength(0);

    mockBlobs.set('feed_inline_doc:p1:0', 'CCCC');
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockPutCalls).toEqual([{ postId: 'p1', media: 0, docs: 1 }]);
  });

  it('запись без вложений отказом не задевается', async () => {
    mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'просто текст', timestamp: 1000 });
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockPutCalls).toEqual([{ postId: 'p1', media: 0, docs: 0 }]);
  });
});
