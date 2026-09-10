/**
 * Кэш счётчика очереди лечится сам, когда его не удалось записать (v4.32.667).
 *
 * Очередь публикации лежит в одной строке kv, а её длина — в отдельном
 * маленьком ключе: читать мегабайтный JSON ради числа над кнопкой дорого.
 * Строку очереди `savePublishQueue` пишет проверенной записью, а производный
 * счёт писала голая `kvSet` — та гасит отказ базы внутри и отдаёт void, так
 * что обёрнутый вокруг неё catch не срабатывал ни разу.
 *
 * Цена промаха не разовая. Читатель `getFeedPublishQueueLength` спрашивает
 * кэш ПЕРВЫМ и пересчитывает только когда ключа нет. Значит несостоявшаяся
 * запись оставляет вчерашнее число до следующей удачной записи очереди:
 * очередь ушла целиком, а баннер держит «1 в очереди» и «Отправить сейчас»
 * молчит, потому что отправлять уже нечего.
 *
 * Теперь запись проверяется, и не легла — ключ стирается: без него счёт
 * считается по самой очереди и снова верен.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
// v4.32.712: очередь спрашивает контакты владельца записи (listContactsFor),
// а не открытого профиля. Оба имени на месте, чтобы подмена не решала за
// проверяемый код, каким из них он пользуется.
jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => []),
  listContactsFor: jest.fn(async () => []),
}));
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
const mockQueueKey = 'feed_publish_queue_v2';
const mockLenKey = 'feed_publish_queue_len_v2';
/** Отвечает ли база отказом на запись ключа со счётом. */
let mockFailLenWrite = false;
/** Сколько раз спрашивали кэш счёта. */
let mockLenReads = 0;

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => {
    if (k === 'feed_publish_queue_len_v2') mockLenReads += 1;
    return mockKv.get(k) ?? null;
  }),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  // Настоящая kvSet гасит отказ базы внутри и возвращает void — здесь так же.
  kvSet: jest.fn(async (k: string, v: string) => {
    if (k === 'feed_publish_queue_len_v2' && mockFailLenWrite) return;
    mockKv.set(k, v);
  }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (k === 'feed_publish_queue_len_v2' && mockFailLenWrite) return false;
    mockKv.set(k, v);
    return true;
  }),
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

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => false,
  isPublicPostId: () => false,
  publicPostCopyExists: jest.fn(async () => false),
  putPublicPostCopy: jest.fn(async () => true),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import {
  flushFeedPublishQueue,
  getFeedPublishQueueLength,
  setFeedProfileContext,
} from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

type Queued = {
  id: string; postId: string; text: string; authorName: string;
  retries: number; createdAt: number; authorDid: string;
};

function seedQueue(ids: string[]): void {
  const now = Date.now();
  const items: Queued[] = ids.map((id) => ({
    id, postId: id, text: `текст ${id}`, authorName: 'Я',
    retries: 0, createdAt: now, authorDid: myDid,
  }));
  mockKv.set(mockQueueKey, JSON.stringify(items));
  for (const id of ids) mockPosts.set(id, { id, authorDid: myDid, text: `текст ${id}`, timestamp: now });
}

/** Сколько записей на самом деле лежит в строке очереди. */
function storedLen(): number {
  const raw = mockKv.get(mockQueueKey);
  return raw === undefined ? -1 : (JSON.parse(raw) as Queued[]).length;
}

beforeAll(async () => {
  jest.useFakeTimers();
  await setFeedProfileContext(1);
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockFailLenWrite = false;
  mockLenReads = 0;
});

describe('повод для правки жив', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  test('kvSet по-прежнему молчит об отказе — на неё счёт вешать нельзя', () => {
    expect(LOCAL).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(LOCAL).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
  });

  test('читатель по-прежнему спрашивает кэш первым', async () => {
    // Иначе стирать ключ было бы незачем: пересчёт шёл бы каждый раз.
    seedQueue(['p1', 'p2', 'p3']);
    mockKv.set(mockLenKey, JSON.stringify({ [myDid]: 99 }));
    await expect(getFeedPublishQueueLength(pair)).resolves.toBe(99);
    expect(mockLenReads).toBe(1);
  });
});

describe('проверка не пустая: счёт записался — всё как было', () => {
  test('после прохода рассылки кэш обновлён, а не стёрт', async () => {
    seedQueue(['p1', 'p2', 'p3']);
    await expect(getFeedPublishQueueLength(pair)).resolves.toBe(3);
    expect(mockKv.get(mockLenKey)).toBe(JSON.stringify({ [myDid]: 3 }));

    await flushFeedPublishQueue(pair);
    expect(storedLen()).toBe(0);
    expect(mockKv.get(mockLenKey)).toBe(JSON.stringify({}));
    await expect(getFeedPublishQueueLength(pair)).resolves.toBe(0);
  });
});

describe('счёт не записался — кэш не остаётся вчерашним', () => {
  test('ключ стёрт, счёт считается по самой очереди', async () => {
    seedQueue(['p1', 'p2', 'p3']);
    await expect(getFeedPublishQueueLength(pair)).resolves.toBe(3);

    mockFailLenWrite = true;
    await flushFeedPublishQueue(pair);
    // Очередь ушла целиком — это и есть новая правда.
    expect(storedLen()).toBe(0);
    // До правки здесь оставалось { myDid: 3 }: «в очереди 3» при пустой
    // очереди и молчащая кнопка «Отправить сейчас».
    expect(mockKv.has(mockLenKey)).toBe(false);
    mockFailLenWrite = false;
    await expect(getFeedPublishQueueLength(pair)).resolves.toBe(0);
  });

  test('отказ счёта не выдаёт очередь за незаписанную', async () => {
    seedQueue(['p1']);
    mockFailLenWrite = true;
    // Сама очередь легла — проход не должен объявлять её несостоявшейся.
    await expect(flushFeedPublishQueue(pair)).resolves.toBeUndefined();
    expect(storedLen()).toBe(0);
  });
});
