/**
 * Очередь публикации считает адресатов по владельцу записи (v4.32.712).
 *
 * Повтор рассылки заканчивается подсчётом: сколько контактов ещё не получили
 * запись. Владельца записи проверяют при входе в `republishQueuedItem`
 * (v4.32.458), но между той проверкой и подсчётом стоит вся рассылка: сборка
 * конверта, разбор вложений, отправка каждому адресату по сети. Это секунды, и
 * человек за это время успевает переключить аккаунт.
 *
 * Подсчёт спрашивал `listContacts()` — список профиля, открытого на экране.
 * После переключения он отвечал про чужой аккаунт. Если у того контактов нет
 * вовсе, срабатывала ветка «контактов нет → пост локальный, доставлять нечего»
 * и повтор возвращал «доставлено всем»: вызывающий проход снимал запись с
 * очереди навсегда, не отдав её ни одному настоящему адресату. Если контакты у
 * нового аккаунта были, счёт шёл по чужим did — «остаток» получался выдуманным
 * в обе стороны.
 *
 * Это ровно та потеря, против которой в v4.32.615 переписывали `catch` вокруг
 * этого же подсчёта, только приходящая с другой стороны: там справочник не
 * отвечал, здесь — отвечал не про того.
 *
 * Теперь номер профиля берётся из пары ключей, которой запись подписана
 * (`ownerPidForPublicKey` — единственная проводка этого правила, v4.32.482), и
 * список запрашивается у него.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

/** Номера профилей, у которых спрашивали список контактов. */
const mockScopePids: number[] = [];
/** Сколько раз спросили список «активного» профиля, без номера. */
const mockBareCalls: number[] = [];
/** Контакты владельца записи; ключ — номер профиля. */
const mockContactsByPid = new Map<number, Array<{ peerPublicKey: string }>>();

jest.mock('../contacts', () => ({
  listContactsFor: async (pid: number) => {
    mockScopePids.push(pid);
    return mockContactsByPid.get(pid) ?? [];
  },
  listContacts: async () => {
    mockBareCalls.push(1);
    return mockContactsByPid.get(mockActivePid) ?? [];
  },
}));

/** Профиль, открытый на экране. Меняется прямо в тесте. */
let mockActivePid = 1;
let mockActiveDid = 'did:key:посторонний';
let mockAllProfiles: Array<{ id: number; did: string }> = [];

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: mockActivePid, did: mockActiveDid }),
    getAllProfiles: () => mockAllProfiles,
    getProfileIdsComplete: () => ({ ids: mockAllProfiles.map((p) => p.id), complete: true }),
  },
}));

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

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
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

import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { flushFeedPublishQueue, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

const peerKeys = ed25519.keygen();
const PEER_PUB_B64 = Buffer.from(peerKeys.publicKey).toString('base64');
const PEER_DID = publicKeyToDidKey(peerKeys.publicKey);

/** Номер профиля, которому принадлежит наш ключ. */
const OWNER = 2;
/** Номер профиля, на который человек переключился посреди рассылки. */
const OTHER = 1;

type Queued = {
  id: string; postId: string; text: string; authorName: string;
  retries: number; createdAt: number; authorDid: string; deliveredTo?: string[];
};

function seedQueue(ids: string[], deliveredTo?: string[]): Queued[] {
  const now = Date.now();
  const items: Queued[] = ids.map((id) => ({
    id, postId: id, text: `текст ${id}`, authorName: 'Я',
    retries: 0, createdAt: now, authorDid: myDid,
    ...(deliveredTo ? { deliveredTo } : {}),
  }));
  mockKv.set(mockQueueKey, JSON.stringify(items));
  for (const id of ids) mockPosts.set(id, { id, authorDid: myDid, text: `текст ${id}`, timestamp: now });
  return items;
}

function storedQueue(): Queued[] | null {
  const raw = mockKv.get(mockQueueKey);
  return raw === undefined ? null : (JSON.parse(raw) as Queued[]);
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело функции: от её заголовка до строки `\n}` на нулевом отступе. */
function bodyOf(head: string): string {
  const start = SRC.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** Строки кода без комментариев — иначе объяснение сойдёт за сам код. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

beforeAll(async () => {
  jest.useFakeTimers();
  mockAllProfiles = [{ id: OTHER, did: 'did:key:посторонний' }, { id: OWNER, did: myDid }];
  await setFeedProfileContext(OWNER);
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockScopePids.length = 0;
  mockBareCalls.length = 0;
  mockContactsByPid.clear();
  // Контакт есть у владельца записи; у профиля, открытого на экране, — нет.
  mockContactsByPid.set(OWNER, [{ peerPublicKey: PEER_PUB_B64 }]);
  mockContactsByPid.set(OTHER, []);
  mockActivePid = OTHER;
  mockActiveDid = 'did:key:посторонний';
});

describe('подсчёт адресатов идёт по владельцу записи', () => {
  test('переключение экрана посреди рассылки не выбрасывает запись', async () => {
    seedQueue(['p1']);
    await flushFeedPublishQueue(pair);
    // Контакт владельца записи не получил её — значит она остаётся в очереди.
    expect((storedQueue() ?? []).map((i) => i.id)).toEqual(['p1']);
  });

  test('список спрашивают у владельца, а не у открытого профиля', async () => {
    seedQueue(['p1']);
    await flushFeedPublishQueue(pair);
    expect(mockScopePids).toContain(OWNER);
    expect(mockScopePids).not.toContain(OTHER);
  });

  test('попытка потрачена — счётчик повторов вырос', async () => {
    seedQueue(['p1']);
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? [])[0]?.retries).toBe(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  test('доставлено всем контактам владельца — запись снимают с очереди', async () => {
    seedQueue(['p1'], [PEER_DID]);
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual([]);
  });

  test('у владельца контактов нет — запись местная, её тоже снимают', async () => {
    mockContactsByPid.set(OWNER, []);
    seedQueue(['p1']);
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual([]);
  });

  test('чужая запись не отправляется и попытку не тратит', async () => {
    const now = Date.now();
    const foreign: Queued = {
      id: 'f1', postId: 'f1', text: 'чужое', authorName: 'Кто-то',
      retries: 0, createdAt: now, authorDid: 'did:key:чужой',
    };
    mockKv.set(mockQueueKey, JSON.stringify([foreign]));
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? [])[0]).toMatchObject({ id: 'f1', retries: 0 });
    expect(mockScopePids).toHaveLength(0);
  });

  test('поста нет в ленте владельца — запись снимают как удалённую автором', async () => {
    const now = Date.now();
    const gone: Queued = {
      id: 'g1', postId: 'g1', text: 'удалён', authorName: 'Я',
      retries: 0, createdAt: now, authorDid: myDid,
    };
    mockKv.set(mockQueueKey, JSON.stringify([gone]));
    // mockPosts пуст: getPost вернёт null.
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual([]);
  });
});

describe('форма исходников', () => {
  const BODY = codeOnly(bodyOf('async function republishQueuedItem('));

  test('в теле повтора не осталось голого listContacts()', () => {
    expect(BODY).not.toMatch(/\blistContacts\(\)/);
  });

  test('номер владельца считается из пары ключей и идёт в запрос списка', () => {
    const owner = BODY.indexOf('const ownerPid = ownerPidForPublicKey(pair.publicKey);');
    const list = BODY.indexOf('const contacts = await listContactsFor(ownerPid);');
    expect(owner).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(owner);
  });

  test('оба имени справочника ввезены явно', () => {
    expect(SRC).toContain("import { listContacts, listContactsFor } from './contacts';");
    expect(SRC).toContain("import { ownerPidForPublicKey } from '../identity/ownerPidLookup';");
  });

  test('пересылка чужого по-прежнему берёт список экрана — и это намеренно', () => {
    // v4.32.214: там список нужен как граф связей текущей сетевой сессии, а не
    // как круг адресатов записи, и снимок поколения профиля гасит проход, если
    // переключение случилось. Правило про владельца туда не переносится.
    const relay = codeOnly(bodyOf('async function feedGossipRelay('));
    expect(relay).toContain('const genAtEntry = feedProfileGen;');
    expect(relay).toContain('await listContacts()');
    expect(relay).toContain('if (feedRebinding || feedProfileGen !== genAtEntry) {');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const CONTACTS = fs.readFileSync(path.join(__dirname, '..', 'contacts.ts'), 'utf8');
  const LOOKUP = fs.readFileSync(
    path.join(__dirname, '..', '..', 'identity', 'ownerPidLookup.ts'), 'utf8',
  );
  const TRANSPORT = fs.readFileSync(path.join(__dirname, '..', 'feedTransport.ts'), 'utf8');

  test('listContacts() по-прежнему отвечает про открытый профиль', () => {
    expect(CONTACTS).toContain('return listContactsFor(activeProfileId());');
    expect(CONTACTS).toContain('export async function listContactsFor(ownerProfileId: number)');
  });

  test('проводка «профиль по ключу» одна и живёт в ownerPidLookup', () => {
    expect(LOOKUP).toContain('export function ownerPidForPublicKey(publicKey: Uint8Array): number {');
    expect(LOOKUP).toContain('return ownerPidForDid(publicKeyToDidKey(publicKey));');
  });

  test('владельца проверяют при входе, а подсчёт стоит после рассылки', () => {
    expect(SRC).toContain('if (!feedStorageBelongsTo(pair)) {');
    expect(SRC).toContain('const res = await signAndBroadcastFeedEnvelope(pair, payload, broadcastOpts);');
    expect(SRC).toContain('if (allContactDids.size === 0) return { fullyDelivered: true };');
    expect(SRC).toContain('return { fullyDelivered: remaining === 0 };');
  });

  test('круг адресатов самой рассылки остаётся за feedTransport', () => {
    // Он помечен как неизменяемый без отдельной просьбы, поэтому правка тут и
    // остановилась на подсчёте: он решает судьбу записи в очереди.
    expect(TRANSPORT).toContain('const contacts = (await listContacts()).filter((c) => !rateLimiter.isBlocked(c.peerPublicKey));');
  });
});
