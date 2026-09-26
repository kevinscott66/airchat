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
    // v4.32.973: закрытие базы — часть штатного выключения ленты.
    async close(): Promise<void> { /* закрывать нечего */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
  },
}));

const mockKv = new Map<string, string>();
/**
 * v4.32.895: отдельный выключатель на запись ОТМЕТКИ «опубликовано по ссылке».
 * Именно на неё, а не на базу целиком: очередь повторов удаления пишется тем
 * же `kvSetChecked`, и общий отказ не дал бы отличить «отметка не легла» от
 * «ничего вообще не пишется».
 */
const mockKvWrites = { markOk: true };
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (!mockKvWrites.markOk && k.includes('feed_link_published:')) return false;
    mockKv.set(k, v);
    return true;
  }),
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
  // v4.32.902: скан ключей идёт трёхсостоянной формой — заглушка «всегда
  // пусто» после правки означала бы «отметок нет», а не «их не искали».
  kvTryListKeysByPrefix: jest.fn(async (prefix: string) => [...mockKv.keys()].filter((k) => k.startsWith(prefix))),
  kvListKeysByPrefix: jest.fn(async (prefix: string) => [...mockKv.keys()].filter((k) => k.startsWith(prefix))),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

const mockServer = { copies: new Set<string>(), putWorks: true, deleteWorks: true };
const mockDeleteIds: string[] = [];

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
  deletePublicPostCopy: jest.fn(async (_p: unknown, postId: string) => {
    mockDeleteIds.push(postId);
    if (!mockServer.deleteWorks) return false;
    mockServer.copies.delete(postId);
    return true;
  }),
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { closeFeedStorage, publishPostLinkCopy, refreshPublicPostCopy, revokePostLinkCopy, setFeedProfileContext } from '../feedService';
import { listLinkPublishedPostIds } from '../postLinkState';

/**
 * Отметки как набор. v4.32.902: чтение стало трёхсостоянием, и `null` здесь
 * означало бы, что база отказала на ровном месте, — такого в этих тестах быть
 * не должно, поэтому проверяется отдельно.
 */
async function publishedIds(): Promise<Set<string>> {
  const ids = await listLinkPublishedPostIds();
  expect(ids).not.toBeNull();
  return ids ?? new Set<string>();
}

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
  mockServer.putWorks = true;
  mockServer.deleteWorks = true;
  mockKvWrites.markOk = true;
  mockDeleteIds.length = 0;
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'запись', timestamp: 1000 });
});

describe('отметка «опубликовано по ссылке»', () => {
  it('ставится после того, как сервер принял копию', async () => {
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect([...(await publishedIds())]).toEqual(['p1']);
  });

  it('не ставится, если сервер копию не принял', async () => {
    mockServer.putWorks = false;
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    expect((await publishedIds()).size).toBe(0);
  });

  /**
   * v4.32.895. Отметка — единственный след публикации, переживающий
   * перезапуск: «Отозвать ссылку» строится из `listLinkPublishedPostIds`.
   * Копия без отметки открыта всем, у кого есть ссылка, и убрать её изнутри
   * приложения нечем.
   */
  it('отметка не легла — копия снимается, а не остаётся открытой навсегда', async () => {
    mockKvWrites.markOk = false;
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    expect(mockServer.copies.has('p1')).toBe(false);
    expect(mockDeleteIds).toEqual(['p1']);
    expect((await publishedIds()).size).toBe(0);
  });

  it('отметка не легла и снять не вышло — отзыв ушёл в очередь повторов', async () => {
    mockKvWrites.markOk = false;
    mockServer.deleteWorks = false;
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(false);
    const queued = JSON.parse(mockKv.get('feed_link_delete_outbox_v1') ?? '[]') as { postId: string }[];
    expect(queued.map((it) => it.postId)).toEqual(['p1']);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: с рабочей записью отметки всё идёт как прежде', async () => {
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockServer.copies.has('p1')).toBe(true);
    // Копию никто не снимал — ни запроса к серверу, ни записи в очередь.
    expect(mockDeleteIds).toEqual([]);
    expect(mockKv.has('feed_link_delete_outbox_v1')).toBe(false);
  });

  it('копия, выложенная старой версией, находится при правке и получает отметку', async () => {
    mockServer.copies.add('p1');
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(true);
    expect((await publishedIds()).has('p1')).toBe(true);
  });

  it('правка неопубликованной записи отметку не ставит', async () => {
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(true);
    expect((await publishedIds()).size).toBe(0);
  });
});

describe('отзыв ссылки', () => {
  it('снимает копию и отметку, но не трогает саму запись', async () => {
    await publishPostLinkCopy(pair, 'p1');
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockServer.copies.has('p1')).toBe(false);
    expect((await publishedIds()).size).toBe(0);
    expect(mockPosts.has('p1')).toBe(true);
    // v4.32.941: снятие названо самим постом — конверт ленты для этого не нужен.
    expect(mockDeleteIds).toEqual(['p1']);
  });

  it('отказ сервера — отметка остаётся, отзыв не выдаётся за удавшийся', async () => {
    await publishPostLinkCopy(pair, 'p1');
    mockServer.deleteWorks = false;
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(false);
    expect(mockServer.copies.has('p1')).toBe(true);
    expect((await publishedIds()).has('p1')).toBe(true);
  });
});
