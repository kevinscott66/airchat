/**
 * Непрочитанная очередь публикации больше не выдаётся за пустую (v4.32.645).
 *
 * Очередь лежит в одной строке kv и записывается целиком: `updateQueue` читает
 * её, отдаёт `apply`, записывает результат. Читала она через `kvGet`, который
 * отвечает `null` и на «строки нет», и на «прочитать не удалось», — то есть
 * сбой базы означал «в очереди пусто», и следом за ним шла запись массива,
 * собранного из этой пустоты.
 *
 * Цена ошибки в обе стороны необратима. Постановка в очередь записывала бы
 * `[новая запись]`, стирая все остальные ожидающие посты. `commitFlushOutcomes`
 * записывала бы `mergeQueue([], решения)` — то есть пустой массив: очередь
 * выносило целиком. Это ровно та потеря, ради которой в v4.32.456 и заводился
 * `mergeQueue`, только подошедшая с другой стороны — не через устаревший
 * снимок, а через несостоявшееся чтение.
 *
 * Запись молчала о себе так же: `kvSet` гасит собственный отказ и возвращает
 * void, а вызывающий на этом строил «поставлено в очередь».
 *
 * Теперь чтение отличает «нет» от «не прочиталось», запись сообщает, легла ли
 * она, и при любом из отказов очередь остаётся на диске нетронутой.
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
const mockQueueKey = 'feed_publish_queue_v2';
/** Сколько раз строку очереди уже читали за тест. */
let mockQueueReads = 0;
/** С какого по счёту чтения строка очереди «не читается». 0 — читается всегда. */
let mockFailQueueReadFrom = 0;
/** Отвечает ли запись строки очереди отказом. */
let mockFailQueueWrite = false;

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => {
    if (k !== mockQueueKey) return { value: mockKv.get(k) ?? null };
    mockQueueReads += 1;
    if (mockFailQueueReadFrom > 0 && mockQueueReads >= mockFailQueueReadFrom) return null;
    return { value: mockKv.get(k) ?? null };
  }),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (k === mockQueueKey && mockFailQueueWrite) return false;
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

const LEN_KEY = 'feed_publish_queue_len_v2';

type Queued = {
  id: string; postId: string; text: string; authorName: string;
  retries: number; createdAt: number; authorDid: string;
};

function seedQueue(ids: string[]): Queued[] {
  const now = Date.now();
  const items: Queued[] = ids.map((id) => ({
    id, postId: id, text: `текст ${id}`, authorName: 'Я',
    retries: 0, createdAt: now, authorDid: myDid,
  }));
  mockKv.set(mockQueueKey, JSON.stringify(items));
  for (const id of ids) mockPosts.set(id, { id, authorDid: myDid, text: `текст ${id}`, timestamp: now });
  return items;
}

/** Что сейчас лежит в строке очереди на «диске». */
function storedQueue(): Queued[] | null {
  const raw = mockKv.get(mockQueueKey);
  return raw === undefined ? null : (JSON.parse(raw) as Queued[]);
}

beforeAll(async () => {
  jest.useFakeTimers();
  await setFeedProfileContext(1);
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockQueueReads = 0;
  mockFailQueueReadFrom = 0;
  mockFailQueueWrite = false;
});

describe('повод для правки жив', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  test('kvGet по-прежнему не различает «нет строки» и «не прочиталось»', () => {
    expect(LOCAL).toContain('export async function kvGet(key: string): Promise<string | null> {\n  return (await kvTryGet(key))?.value ?? null;\n}');
  });

  test('kvTryGet различает: null — сбой, { value: null } — строки нет', () => {
    expect(LOCAL).toContain('export async function kvTryGet(key: string): Promise<{ value: string | null } | null> {');
    expect(LOCAL).toContain('    return { value: row?.v ?? null };');
    expect(LOCAL).toMatch(/catch \(e\) \{\n\s*log\.warn\('kv_get_failed'[\s\S]{0,120}\n\s*return null;/);
  });

  test('kvSet по-прежнему молчит об отказе, kvSetChecked — нет', () => {
    expect(LOCAL).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(LOCAL).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
  });
});

describe('проверка не пустая: очередь читается — всё как было', () => {
  test('проход рассылки снимает записи с очереди', async () => {
    seedQueue(['p1', 'p2']);
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual([]);
    // Записывали именно через проверенную запись, а не мимо неё.
    expect(mockQueueReads).toBeGreaterThanOrEqual(2);
  });

  test('счётчик очереди считает записи и кладёт счёт в кэш', async () => {
    seedQueue(['p1', 'p2', 'p3']);
    await expect(getFeedPublishQueueLength(pair)).resolves.toBe(3);
    expect(mockKv.get(LEN_KEY)).toBe(JSON.stringify({ [myDid]: 3 }));
  });
});

describe('очередь не прочиталась — её не переписывают', () => {
  test('итоги рассылки не записаны, но и очередь цела', async () => {
    const seeded = seedQueue(['p1', 'p2']);
    // Первое чтение (сам проход) удаётся, чтение в момент записи — нет.
    mockFailQueueReadFrom = 2;
    await flushFeedPublishQueue(pair);
    expect(mockQueueReads).toBeGreaterThanOrEqual(2);
    // До правки здесь оставался пустой массив: mergeQueue([], решения) === [].
    expect(storedQueue()).toEqual(seeded);
  });

  test('обе записи остаются отправляемыми — потери нет', async () => {
    seedQueue(['p1', 'p2']);
    mockFailQueueReadFrom = 2;
    await flushFeedPublishQueue(pair);
    mockFailQueueReadFrom = 0;
    expect((storedQueue() ?? []).map((i) => i.id)).toEqual(['p1', 'p2']);
  });

  test('проход по пустому ответу чтения ничего не пишет', async () => {
    seedQueue(['p1']);
    const before = mockKv.get(mockQueueKey);
    mockFailQueueReadFrom = 1;
    await flushFeedPublishQueue(pair);
    expect(mockKv.get(mockQueueKey)).toBe(before);
  });

  test('счётчик не записывает выдуманный ноль в кэш', async () => {
    seedQueue(['p1', 'p2', 'p3']);
    mockFailQueueReadFrom = 1;
    await expect(getFeedPublishQueueLength(pair)).resolves.toBe(0);
    // Записанный ноль держался бы до следующей записи очереди: «в очереди 0»
    // при трёх живых записях и молчащая кнопка «Отправить сейчас».
    expect(mockKv.has(LEN_KEY)).toBe(false);
  });
});

describe('очередь не записалась — отказ не выдают за успех', () => {
  test('итоги рассылки не легли — на диске прежние записи', async () => {
    const seeded = seedQueue(['p1', 'p2']);
    mockFailQueueWrite = true;
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual(seeded);
  });

  test('проход не падает наружу — следующий повторит рассылку', async () => {
    seedQueue(['p1']);
    mockFailQueueWrite = true;
    await expect(flushFeedPublishQueue(pair)).resolves.toBeUndefined();
    mockFailQueueWrite = false;
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual([]);
  });
});

describe('форма источника: отказ очереди виден всем её путям', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  /** Строки кода без комментариев — иначе объяснение сойдёт за сам код. */
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('очередь читают через kvTryGet, а не через kvGet', () => {
    expect(CODE).not.toContain('await kvGet(FEED_QUEUE_KEY)');
    expect(CODE).toContain('const read = await kvTryGet(FEED_QUEUE_KEY);');
    expect(CODE).toContain('async function loadPublishQueue(): Promise<QueuedFeedItem[] | null> {');
  });

  test('очередь пишут проверенной записью', () => {
    expect(CODE).not.toContain('await kvSet(FEED_QUEUE_KEY');
    expect(CODE).toContain('async function savePublishQueue(q: QueuedFeedItem[]): Promise<boolean> {');
    expect(CODE).toContain('if (!(await kvSetChecked(FEED_QUEUE_KEY, JSON.stringify(q))))');
  });

  test('updateQueue не применяет изменение при любом из двух отказов', () => {
    expect(CODE).toContain('if (current === null) throw new Error(QUEUE_UNAVAILABLE);');
    expect(CODE).toContain('if (!(await savePublishQueue(next))) throw new Error(QUEUE_UNAVAILABLE);');
  });

  test('таймер повтора не гаснет от непрочитанной очереди', () => {
    expect(CODE).toContain('async function myQueueItems(pair: KeyPairBytes): Promise<QueuedFeedItem[] | null> {');
    expect(CODE).toContain('if (mine === null || mine.length > 0) {');
    expect(CODE).toContain('if (q === null || q.length > 0 || pendingLinkDeletes > 0) {');
  });

  test('репост, не попавший в очередь, не называется поставленным в очередь', () => {
    const at = CODE.indexOf("log.warn('feed_repost_enqueue_failed'");
    expect(at).toBeGreaterThan(-1);
    expect(CODE.slice(at, at + 220)).toContain('return { ok: true, cid: newPostId };');
  });
});
