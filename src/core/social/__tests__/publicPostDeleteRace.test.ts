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
    // v4.32.973: закрытие базы — часть штатного выключения ленты.
    async close(): Promise<void> { /* закрывать нечего */ }
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
  /**
   * Полки ленты лежат шифртекстом: `kvSetSecret` кладёт, `kvGetSecretCell`
   * открывает (v4.32.973). Без этой пары `loadPublishQueue` падал прямо
   * посреди прогона — «kvGetSecretCell is not a function», — а падение
   * доставалось таймеру повторов и всплывало уже после конца набора.
   */
  kvSetSecret: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvGetSecretCell: jest.fn(async (k: string) => {
    const v = mockKv.get(k);
    return v == null ? { state: 'absent' } : { state: 'plain', text: v };
  }),
  kvGetSecretCellUpgrading: jest.fn(async (k: string) => {
    const v = mockKv.get(k);
    return v == null ? { state: 'absent' } : { state: 'plain', text: v };
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
  deletePublicPostCopy: jest.fn(async (_p: unknown, postId: string) => {
    mockCalls.push(`del:${postId}`);
    if (!mockServer.deleteWorks) return false;
    mockServer.copies.delete(postId);
    return true;
  }),
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { closeFeedStorage, publishPostLinkCopy, refreshPublicPostCopy, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

beforeAll(async () => { await setFeedProfileContext(1); });

/**
 * v4.32.973: набор заводит профиль ленты, а значит и таймер повторов. Тот
 * переживал конец прогона, просыпался на уже разобранном окружении и ронял
 * сам процесс jest. `closeFeedStorage` — штатный выключатель продукта, тот
 * же, что зовут «выйти» и «стереть данные»; здесь он просто парный к
 * `setFeedProfileContext` выше.
 */
afterAll(async () => { await closeFeedStorage(); });

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
