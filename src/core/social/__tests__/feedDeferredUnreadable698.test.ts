/**
 * Нечитаемая полка отложенных событий больше не переписывается (v4.32.698).
 *
 * Полка лежит в одной строке kv и кладётся обратно ЦЕЛИКОМ: loadDeferred
 * читает её, addDeferred дописывает одно событие, saveDeferred записывает
 * результат. Читала она через kvGet, а он в local.ts отвечает одинаковым null
 * и когда полки нет, и когда база не ответила. Значит одна заминка базы
 * означала «полка пуста», и следом за ней шла запись карты из одного события —
 * поверх всего, что там лежало.
 *
 * Цена необратима. На полке ждут своих публикаций комментарии, реакции,
 * правки и голоса, приехавшие раньше поста; повторов у них нет — ни у реакции
 * (см. addAndBroadcastReaction), ни у комментария, отвергнутого как сирота.
 * Никто не пришлёт их снова.
 *
 * Проверка поведением: модуль настоящий, отказ подделан на уровне kv — ровно
 * так, как отказывает kvTryGet, и ровно так, как этот отказ выглядел для
 * прежнего kvGet.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => true) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
}));

type Row = { id: string; authorDid: string; text: string; timestamp: number };
const mockPosts = new Map<string, Row>();
/** `postId|emoji|did` каждой реакции, дошедшей до хранилища. */
const mockReactions: string[] = [];

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(row: Row): Promise<void> { mockPosts.set(row.id, row); }
    async getPost(id: string): Promise<Row | null> { return mockPosts.get(id) ?? null; }
    async addReaction(postId: string, emoji: string, did: string): Promise<boolean> {
      // Ровно то же, что делает настоящее хранилище: реакция на неизвестную
      // публикацию не ложится и отвечает false.
      if (!mockPosts.has(postId)) return false;
      mockReactions.push(`${postId}|${emoji}|${did}`);
      return true;
    }
    async removeReaction(): Promise<void> { /* снятие проверяется не здесь */ }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
  },
}));

const mockKv = new Map<string, string>();
const mockDeferKey = 'feed_deferred_v1:p1';
/** Отвечает ли строка полки отказом чтения. */
let mockFailDeferRead = false;

jest.mock('../../storage/local', () => ({
  // Прежнее чтение подделано так же, как оно устроено в local.ts: отказ базы и
  // отсутствие строки сливаются в один null. Без этого встречная проверка
  // (файл до правки) шла бы не по настоящему коду.
  kvGet: jest.fn(async (k: string) => {
    if (k === mockDeferKey && mockFailDeferRead) return null;
    return mockKv.get(k) ?? null;
  }),
  kvTryGet: jest.fn(async (k: string) => {
    if (k === mockDeferKey && mockFailDeferRead) return null;
    return { value: mockKv.get(k) ?? null };
  }),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
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

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => false,
  isPublicPostId: () => false,
  publicPostCopyExists: jest.fn(async () => false),
  putPublicPostCopy: jest.fn(async () => true),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { receiveFeedEnvelope, setFeedProfileContext } from '../feedService';
import { serializeFeedEnvelope, type FeedEnvelopePayload } from '../feedTransport';

type Identity = { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string };

function newIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, did: publicKeyToDidKey(publicKey) };
}

/** Обёртка 0xF1 вокруг подписанного кадра: так конверт приходит от соседа. */
function wrapper(inner: Uint8Array, h: number): Uint8Array {
  const json = JSON.stringify({ h, f: Buffer.from(inner).toString('base64') });
  const bytes = new TextEncoder().encode(json);
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0xf1;
  out.set(bytes, 1);
  return out;
}

async function deliver(id: Identity, payload: FeedEnvelopePayload): Promise<void> {
  const frame = await serializeFeedEnvelope(id.pair, payload);
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  await receiveFeedEnvelope(wrapper(frame, 0), '');
  // Пересылка запускается без await — дать очереди микрозадач провернуться.
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function reaction(id: Identity, postId: string, emoji: string, remove = false): FeedEnvelopePayload {
  return {
    type: 'feed_reaction',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: remove ? { emoji, remove: true } : { emoji },
  } as unknown as FeedEnvelopePayload;
}

function post(id: Identity, postId: string): FeedEnvelopePayload {
  return {
    type: 'feed_post',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: { kind: 'post', text: 'привет' },
  } as unknown as FeedEnvelopePayload;
}

const OTHER_DID = 'did:key:zOtherAuthorOfAnotherPost';

/** Полка, на которой уже что-то ждёт своей публикации. Возвращает строку как есть. */
function seedShelf(): string {
  const raw = JSON.stringify({
    'other-post': {
      at: Date.now(),
      events: [{ type: 'feed_reaction', authorDid: OTHER_DID, ts: Date.now(), data: { emoji: '🔥' } }],
    },
  });
  mockKv.set(mockDeferKey, raw);
  return raw;
}

/** Ключи публикаций, лежащие сейчас на полке. */
function shelfKeys(): string[] {
  const raw = mockKv.get(mockDeferKey);
  return raw === undefined ? [] : Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
}

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockReactions.length = 0;
  mockFailDeferRead = false;
});

describe('повод для правки жив', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  test('kvGet по-прежнему не различает «нет строки» и «не прочиталось»', () => {
    expect(LOCAL).toContain('export async function kvGet(key: string): Promise<string | null> {\n  return (await kvTryGet(key))?.value ?? null;\n}');
    expect(LOCAL).toContain('export async function kvTryGet(key: string): Promise<{ value: string | null } | null> {');
    expect(LOCAL).toMatch(/catch \(e\) \{\n\s*log\.warn\('kv_get_failed'[\s\S]{0,120}\n\s*return null;/);
  });
});

describe('проверка не пустая: полка читается — всё как было', () => {
  test('реакция без публикации ложится на полку рядом с прежними', async () => {
    const before = seedShelf();
    const author = newIdentity();
    await deliver(author, reaction(author, 'wait-1', '👍'));
    expect(shelfKeys()).toEqual(['other-post', 'wait-1']);
    expect(mockKv.get(mockDeferKey)).not.toBe(before);
  });

  test('и применяется, когда публикация приходит', async () => {
    const author = newIdentity();
    await deliver(author, reaction(author, 'wait-2', '👍'));
    expect(mockReactions).toEqual([]);
    await deliver(author, post(author, 'wait-2'));
    expect(mockReactions).toEqual([`wait-2|👍|${author.did}`]);
    expect(shelfKeys()).toEqual([]);
  });
});

describe('полка не прочиталась — её не переписывают', () => {
  test('прежние ожидающие события остаются на месте байт в байт', async () => {
    const before = seedShelf();
    mockFailDeferRead = true;
    const author = newIdentity();
    await deliver(author, reaction(author, 'lost-1', '👍'));
    // До правки здесь оставалась карта из одного события: полка, собранная из
    // несостоявшегося чтения, ложилась поверх всех остальных публикаций.
    expect(mockKv.get(mockDeferKey)).toBe(before);
  });

  test('и пустая полка не заводится заново', async () => {
    mockFailDeferRead = true;
    const author = newIdentity();
    await deliver(author, reaction(author, 'lost-2', '👍'));
    expect(mockKv.has(mockDeferKey)).toBe(false);
  });

  test('снятие реакции полку не трогает и при отказе чтения', async () => {
    const before = seedShelf();
    mockFailDeferRead = true;
    const author = newIdentity();
    await deliver(author, reaction(author, 'lost-3', '👍', true));
    expect(mockKv.get(mockDeferKey)).toBe(before);
  });

  test('приход публикации при нечитаемой полке ничего не применяет и не стирает', async () => {
    const before = seedShelf();
    mockFailDeferRead = true;
    const author = newIdentity();
    await deliver(author, post(author, 'other-post'));
    expect(mockReactions).toEqual([]);
    expect(mockKv.get(mockDeferKey)).toBe(before);
  });
});

describe('исходник: чтение полки объявлено двойственным', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

  test('loadDeferred отличает «полки нет» от «не прочиталась»', () => {
    expect(SRC).toContain('async function loadDeferred(pid: number): Promise<DeferredStore | null> {');
    expect(SRC).toContain('  const read = await kvTryGet(`${DEFERRED_KEY_PREFIX}${pid}`);');
    expect(SRC).toContain('  return read === null ? null : parseDeferredStore(read.value);');
    expect(SRC).not.toContain('parseDeferredStore(await kvGet(');
  });

  test('оба откладывающих места отказ чтения признают', () => {
    expect(SRC).toContain("    log.warn('feed_deferred_unreadable', { pid, type: payload.type });");
    expect(SRC).toContain('  if (store === null || !store[payload.postId]) return;');
    // Применение отложенного тоже не считает несостоявшееся чтение пустотой.
    expect(SRC).toContain('  const store = await loadDeferred(pid);\n  if (store === null) return;');
  });
});
