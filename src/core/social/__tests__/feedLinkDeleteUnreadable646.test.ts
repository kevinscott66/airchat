/**
 * Непрочитанная очередь удалений копий — не пустая очередь (v4.32.646).
 *
 * Копия публикации по ссылке лежит на сервере отдельно от контактов: её
 * открывает кто угодно, а рассылка `feed_delete` её не касается. Неудавшееся
 * удаление копии ложится в одну kv-строку и повторяется на каждом прогоне
 * очереди публикации.
 *
 * Строку читали через `kvGet`, который отвечает `null` и когда её нет, и когда
 * её не удалось прочитать. Один сбой чтения означал «удалять нечего», и
 * следующая же запись клала поверх файла очередь, собранную из ничего:
 * `queueLinkCopyDelete` оставлял в ней одну свою запись, остальные копии
 * оставались на сервере навсегда. Писали через `kvSet`, который гасит свой
 * отказ и возвращает `void`, — запись повтора, которой не случилось, выглядела
 * ровно так же, как удавшаяся.
 *
 * Отдельно от этого `flushLinkDeleteOutbox` читал очередь, шёл в сеть и писал
 * обратно снимок, прочитанный ДО похода: удаление, поставленное в очередь пока
 * шла сеть, затиралось хвостом прохода — и его копия оставалась на сервере
 * навсегда.
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
const mockLinkKey = 'feed_link_delete_outbox_v1';
/** Сколько раз строку очереди удалений уже читали за тест. */
let mockLinkReads = 0;
/** С какого по счёту чтения строка «не читается». 0 — читается всегда. */
let mockFailLinkReadFrom = 0;
/** Отвечает ли запись строки отказом. */
let mockFailLinkWrite = false;

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => {
    if (k !== mockLinkKey) return { value: mockKv.get(k) ?? null };
    mockLinkReads += 1;
    if (mockFailLinkReadFrom > 0 && mockLinkReads >= mockFailLinkReadFrom) return null;
    return { value: mockKv.get(k) ?? null };
  }),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (k === mockLinkKey && mockFailLinkWrite) return false;
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

/** Что сейчас лежит на сервере под ссылкой. */
const mockCopyOnServer = new Set<string>();
/** Публикации, удаление копий которых сервер отклоняет. */
const mockRefuse = new Set<string>();
/** Что произойдёт «пока идёт сеть» — ровно один раз, на первом же удалении. */
const mockDuringDelete: { fn: (() => void) | null } = { fn: null };

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  isPublicPostId: (id: string) => /^[A-Za-z0-9_\-.:]{1,128}$/.test(id),
  publicPostCopyExists: jest.fn(async (postId: string) => mockCopyOnServer.has(postId)),
  putPublicPostCopy: jest.fn(async () => true),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async (_pair: unknown, payload: { postId: string }) => {
    if (mockDuringDelete.fn) {
      const f = mockDuringDelete.fn;
      mockDuringDelete.fn = null;
      f();
    }
    if (mockRefuse.has(payload.postId)) return false;
    mockCopyOnServer.delete(payload.postId);
    return true;
  }),
}));

import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { deleteFeedPost, flushFeedPublishQueue, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);
const alienDid = publicKeyToDidKey(ed25519.keygen().publicKey);

type LinkItem = { postId: string; authorDid: string; createdAt: number };

/** Что сейчас лежит в строке очереди на «диске». `null` — строки нет вовсе. */
function stored(): LinkItem[] | null {
  const raw = mockKv.get(mockLinkKey);
  return raw === undefined ? null : (JSON.parse(raw) as LinkItem[]);
}

function seedOutbox(items: LinkItem[]): void {
  mockKv.set(mockLinkKey, JSON.stringify(items));
}

/** Своя публикация, копия которой лежит на сервере и удаляться не хочет. */
function stuckPost(id: string): void {
  mockPosts.set(id, { id, authorDid: myDid, text: `текст ${id}`, timestamp: Date.now() });
  mockCopyOnServer.add(id);
  mockRefuse.add(id);
}

beforeAll(async () => {
  // Таймер повтора заводится сразу после неудачи; будить его в тесте незачем.
  jest.useFakeTimers();
  await setFeedProfileContext(1);
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockCopyOnServer.clear();
  mockRefuse.clear();
  mockDuringDelete.fn = null;
  mockLinkReads = 0;
  mockFailLinkReadFrom = 0;
  mockFailLinkWrite = false;
});

describe('повод для правки жив', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  test('kvGet по-прежнему не различает «нет строки» и «не прочиталось»', () => {
    expect(LOCAL).toContain('export async function kvGet(key: string): Promise<string | null> {\n  return (await kvTryGet(key))?.value ?? null;\n}');
    expect(LOCAL).toContain('export async function kvTryGet(key: string): Promise<{ value: string | null } | null> {');
  });

  test('kvSet по-прежнему молчит об отказе, kvSetChecked — нет', () => {
    expect(LOCAL).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(LOCAL).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
  });
});

describe('проверка не пустая: очередь читается — всё как было', () => {
  test('второе неудавшееся удаление добавляется к первому, а не вместо него', async () => {
    stuckPost('p1');
    stuckPost('p2');
    await deleteFeedPost(pair, 'p1');
    await deleteFeedPost(pair, 'p2');
    expect((stored() ?? []).map((it) => it.postId)).toEqual(['p1', 'p2']);
  });

  test('проход снимает свою запись и не трогает чужую', async () => {
    const now = Date.now();
    seedOutbox([
      { postId: 'p1', authorDid: myDid, createdAt: now },
      { postId: 'p8', authorDid: alienDid, createdAt: now },
    ]);
    mockCopyOnServer.add('p1');
    mockCopyOnServer.add('p8');
    await flushFeedPublishQueue(pair);
    expect(mockCopyOnServer.has('p1')).toBe(false);
    expect((stored() ?? []).map((it) => it.postId)).toEqual(['p8']);
  });

  test('копия удалилась сразу — в очередь ничего не ложится', async () => {
    mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'моё', timestamp: Date.now() });
    mockCopyOnServer.add('p1');
    const reach = await deleteFeedPost(pair, 'p1');
    expect(reach.linkCopyLeft).toBe(false);
    expect(stored()).toBeNull();
  });
});

describe('очередь не прочиталась — её не переписывают', () => {
  test('запись повтора не кладётся поверх остальных', async () => {
    const now = Date.now();
    seedOutbox([
      { postId: 'p1', authorDid: myDid, createdAt: now },
      { postId: 'p2', authorDid: myDid, createdAt: now },
    ]);
    const before = mockKv.get(mockLinkKey);
    stuckPost('p3');
    mockFailLinkReadFrom = 1;
    await deleteFeedPost(pair, 'p3');
    // До правки здесь оставалась одна запись p3, а p1 и p2 исчезали навсегда
    // вместе со своими копиями на сервере.
    expect(mockKv.get(mockLinkKey)).toBe(before);
  });

  test('охват всё равно говорит правду про оставшуюся копию', async () => {
    stuckPost('p3');
    mockFailLinkReadFrom = 1;
    const reach = await deleteFeedPost(pair, 'p3');
    expect(reach.linkCopyLeft).toBe(true);
  });

  test('проход по непрочитанной очереди ничего не пишет и не ходит в сеть', async () => {
    seedOutbox([{ postId: 'p1', authorDid: myDid, createdAt: Date.now() }]);
    mockCopyOnServer.add('p1');
    const before = mockKv.get(mockLinkKey);
    mockFailLinkReadFrom = 1;
    await flushFeedPublishQueue(pair);
    expect(mockKv.get(mockLinkKey)).toBe(before);
    expect(mockCopyOnServer.has('p1')).toBe(true);
  });
});

describe('очередь не записалась — отказ не выдают за успех', () => {
  test('на диске остаётся прежнее', async () => {
    const now = Date.now();
    seedOutbox([{ postId: 'p1', authorDid: myDid, createdAt: now }]);
    const before = mockKv.get(mockLinkKey);
    stuckPost('p3');
    mockFailLinkWrite = true;
    await deleteFeedPost(pair, 'p3');
    expect(mockKv.get(mockLinkKey)).toBe(before);
  });

  test('удаление публикации не падает наружу и остаётся честным', async () => {
    stuckPost('p3');
    mockFailLinkWrite = true;
    await expect(deleteFeedPost(pair, 'p3')).resolves.toEqual(
      expect.objectContaining({ linkCopyLeft: true }),
    );
  });
});

describe('хвост прохода не затирает то, что легло, пока шла сеть', () => {
  test('удаление, поставленное в очередь во время сети, переживает проход', async () => {
    const now = Date.now();
    seedOutbox([{ postId: 'p1', authorDid: myDid, createdAt: now }]);
    mockCopyOnServer.add('p1');
    // Пока сеть отвечает про p1, в ту же строку ложится удаление p2.
    mockDuringDelete.fn = () => {
      seedOutbox([
        { postId: 'p1', authorDid: myDid, createdAt: now },
        { postId: 'p2', authorDid: myDid, createdAt: now },
      ]);
    };
    await flushFeedPublishQueue(pair);
    // До правки проход писал снимок, прочитанный ДО сети: p2 исчезал, а его
    // копия оставалась на сервере открытой по ссылке навсегда.
    expect((stored() ?? []).map((it) => it.postId)).toEqual(['p2']);
  });
});

describe('форма источника: отказ очереди удалений виден всем её путям', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  /** Строки кода без комментариев — иначе объяснение сойдёт за сам код. */
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('очередь читают через kvTryGet, а не через kvGet', () => {
    expect(CODE).not.toContain('await kvGet(LINK_DELETE_OUTBOX_KEY)');
    expect(CODE).toContain('const read = await kvTryGet(LINK_DELETE_OUTBOX_KEY);');
    expect(CODE).toContain('async function loadLinkDeleteOutbox(): Promise<LinkDeleteItem[] | null> {');
  });

  test('очередь пишут проверенной записью', () => {
    expect(CODE).not.toContain('await kvSet(LINK_DELETE_OUTBOX_KEY');
    expect(CODE).toContain('async function saveLinkDeleteOutbox(q: LinkDeleteItem[]): Promise<boolean> {');
    expect(CODE).toContain('if (await kvSetChecked(LINK_DELETE_OUTBOX_KEY,');
  });

  test('изменение либо ложится целиком, либо не происходит', () => {
    expect(CODE).toContain('if (current === null) throw new Error(LINK_DELETE_UNAVAILABLE);');
    expect(CODE).toContain('if (!(await saveLinkDeleteOutbox(next))) throw new Error(LINK_DELETE_UNAVAILABLE);');
  });

  test('у файла очереди один владелец, и он не ждёт сеть', () => {
    // Единственные две записи — внутри транзакции.
    expect((CODE.match(/await saveLinkDeleteOutbox\(/g) ?? []).length).toBe(1);
    expect(CODE).toContain('const started = linkDeleteTx.then(run, run);');
    // `apply` синхронная: в неё нельзя вписать поход в сеть, а значит нельзя и
    // снова завести «прочитал старое, записал поверх нового».
    expect(CODE).toContain('apply: (q: LinkDeleteItem[]) => { next: LinkDeleteItem[]; value: T }');
  });

  test('проход накладывает итог на текущую очередь, а не на свой снимок', () => {
    expect(CODE).toContain('next: cur.filter((it) => !settled.has(linkDeleteKey(it))),');
  });
});
