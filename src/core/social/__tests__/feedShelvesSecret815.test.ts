/**
 * Полки ленты лежат под тем же шифром, что и сама лента (v4.32.815).
 *
 * Дефект. Опубликованный пост хранится зашифрованным столбцом: `savePost`
 * пропускает через ключ данных и текст, и имя автора. А пока пост ждёт
 * отправки, тот же текст лежал в kv открытой строкой — столбец значений kv
 * шифрует только `kvSetSecret`, и ни одна из трёх полок им не пользовалась:
 * очередь публикаций, очередь комментариев и полка чужих конвертов, для
 * которых публикация ещё не пришла.
 *
 * Цена. У попавшего в чужие руки файла базы лента читалась не вся, но самое
 * свежее — то, что человек написал последним, и то, что ему только что
 * написали, — читалось глазами. Ровно от этого случая шифрование столбцов и
 * заводилось. Полки не короткоживущие: у очереди публикаций TTL две недели,
 * и без связи черновик лежит там всё это время.
 *
 * Правка. Все три полки читаются `kvGetSecretCell` и пишутся `kvSetSecret`.
 * Прежний договор из трёх исходов сохранён: `unreadable` покрывает и молчание
 * базы, и не открывшийся столбец, и оба по-прежнему значат «что там лежало —
 * неизвестно», потому что полка кладётся обратно целиком.
 *
 * Подмена шифрует base64: подстановка, а не шифр, — но она отличает
 * зашифрованное от открытого, а больше от неё здесь ничего не нужно.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => false) },
}));
// Справочник контактов отвечает «не прочитался»: запись при таком ответе
// остаётся в очереди — иначе очередь опустела бы, и «в базе нет черновика»
// значило бы «черновика нигде нет», а не «он лежит под шифром».
jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => []),
  listContactsRead: jest.fn(async () => null),
  listContactsFor: jest.fn(async () => []),
  listContactsReadFor: jest.fn(async () => null),
}));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
}));

type Row = { id: string; authorDid: string; text: string; timestamp: number };
const mockPosts = new Map<string, Row>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    // v4.32.973: закрытие базы — часть штатного выключения ленты.
    async close(): Promise<void> { /* закрывать нечего */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(row: Row): Promise<void> { mockPosts.set(row.id, row); }
    async getPost(id: string): Promise<Row | null> { return mockPosts.get(id) ?? null; }
    async addReaction(postId: string): Promise<boolean> { return mockPosts.has(postId); }
    async removeReaction(): Promise<void> { /* снятие проверяется не здесь */ }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
  },
}));

const mockKv = new Map<string, string>();
const mockQueueKey = 'feed_publish_queue_v2';
const mockOutboxKey = 'feed_comment_outbox_v1';
const mockDeferKey = 'feed_deferred_v1:p1';
/** Метка шифртекста — та же, что у настоящего кодека. */
const mockPrefix = 'enc2:';

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  // Настоящая пара: kvSetSecret кладёт шифртекст, kvGetSecretCell открывает
  // его обратно, а строку без метки отдаёт как есть — на этом и держится
  // чтение прежних, ещё открытых полок.
  kvSetSecret: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, `${mockPrefix}${Buffer.from(v, 'utf8').toString('base64')}`);
    return true;
  }),
  kvGetSecretCell: jest.fn(async (k: string) => {
    const raw = mockKv.get(k);
    if (raw === undefined) return { state: 'absent' };
    if (!raw.startsWith(mockPrefix)) return { state: 'plain', text: raw };
    const body = raw.slice(mockPrefix.length);
    return { state: 'plain', text: Buffer.from(body, 'base64').toString('utf8') };
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

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => false,
  isPublicPostId: () => false,
  publicPostCopyExists: jest.fn(async () => false),
  putPublicPostCopy: jest.fn(async () => false),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import {
  closeFeedStorage,
  flushFeedPublishQueue,
  receiveFeedEnvelope,
  resumeCommentOutbox,
  setFeedProfileContext,
} from '../feedService';
import { serializeFeedEnvelope, type FeedEnvelopePayload } from '../feedTransport';

/** Метка шифртекста, та же, что у подмены выше. */
const PREFIX = mockPrefix;

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

/** Слова, которых в базе быть не должно. */
const DRAFT = 'черновикПроБольницу';
const COMMENT = 'комментарийПроДолг';
const EMOJI = '🔥';

function newIdentity(): { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, did: publicKeyToDidKey(publicKey) };
}

/** Обёртка 0xF1 вокруг подписанного кадра: так конверт приходит от соседа. */
function wrapper(inner: Uint8Array): Uint8Array {
  const json = JSON.stringify({ h: 0, f: Buffer.from(inner).toString('base64') });
  const bytes = new TextEncoder().encode(json);
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0xf1;
  out.set(bytes, 1);
  return out;
}

/** Реакция на публикацию, которой у нас ещё нет: она и ложится на полку. */
async function deliverOrphanReaction(postId: string): Promise<string> {
  const id = newIdentity();
  const payload = {
    type: 'feed_reaction',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: { emoji: EMOJI },
  } as unknown as FeedEnvelopePayload;
  const frame = await serializeFeedEnvelope(id.pair, payload);
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  await receiveFeedEnvelope(wrapper(frame), '');
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  return id.did;
}

function seedQueue(): void {
  mockKv.set(mockQueueKey, JSON.stringify([{
    id: 'p1', postId: 'p1', text: DRAFT, authorName: 'Я',
    retries: 0, createdAt: Date.now(), authorDid: myDid,
  }]));
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: DRAFT, timestamp: Date.now() });
}

function seedOutbox(): void {
  mockKv.set(mockOutboxKey, JSON.stringify([{
    key: 'c1', authorDid: myDid, kind: 'comment', commentId: 'c1', postId: 'p1',
    text: COMMENT, authorName: 'Я', ts: Date.now(), retries: 0, createdAt: Date.now(),
  }]));
}

/** Всё, что сейчас лежит в базе, одной строкой — как её увидит посторонний. */
function diskDump(): string {
  return [...mockKv.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
}

/** Полка, прочитанная так же, как её читает сама программа. */
function shelf(key: string): unknown {
  const raw = mockKv.get(key);
  if (raw === undefined) return null;
  const text = raw.startsWith(PREFIX)
    ? Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8')
    : raw;
  return JSON.parse(text) as unknown;
}

/** Тексты записей очереди публикаций. */
function queueTexts(): string[] {
  return ((shelf(mockQueueKey) as Array<{ text?: string }> | null) ?? []).map((i) => i.text ?? '');
}

/** Тексты записей очереди комментариев. */
function outboxTexts(): string[] {
  return ((shelf(mockOutboxKey) as Array<{ text?: string }> | null) ?? []).map((i) => i.text ?? '');
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

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
  mockKv.clear();
  mockPosts.clear();
});

describe('написанное не ложится в базу открытым текстом', () => {
  it('очередь публикаций уходит шифртекстом', async () => {
    seedQueue();
    await flushFeedPublishQueue(pair);
    await settle();
    const raw = mockKv.get(mockQueueKey);
    expect(raw).toBeDefined();
    expect(raw?.startsWith(PREFIX)).toBe(true);
    // Черновик на полке остался — значит его нет в открытом виде именно
    // потому, что он зашифрован, а не потому, что очередь опустела.
    expect(queueTexts()).toEqual([DRAFT]);
    expect(diskDump()).not.toContain(DRAFT);
  });

  it('очередь комментариев — тоже', async () => {
    seedOutbox();
    resumeCommentOutbox(pair);
    await settle();
    expect(mockKv.get(mockOutboxKey)?.startsWith(PREFIX)).toBe(true);
    expect(outboxTexts()).toEqual([COMMENT]);
    expect(diskDump()).not.toContain(COMMENT);
  });

  it('полка чужих конвертов — тоже', async () => {
    const who = await deliverOrphanReaction('нетТакогоПоста');
    const raw = mockKv.get(mockDeferKey);
    expect(raw).toBeDefined();
    expect(raw?.startsWith(PREFIX)).toBe(true);
    // На полке лежат и ключ соседа, и то, чем он ответил.
    expect(JSON.stringify(shelf(mockDeferKey))).toContain(who);
    expect(diskDump()).not.toContain(who);
    expect(diskDump()).not.toContain(EMOJI);
  });
});

describe('прежние полки, лежащие открытым текстом', () => {
  it('читаются как есть — ничего не теряется при обновлении', async () => {
    seedQueue();
    await flushFeedPublishQueue(pair);
    await settle();
    expect(queueTexts()).toEqual([DRAFT]);
  });

  it('переписываются шифртекстом при первой же записи', async () => {
    seedOutbox();
    expect(mockKv.get(mockOutboxKey)?.startsWith(PREFIX)).toBe(false);
    resumeCommentOutbox(pair);
    await settle();
    expect(mockKv.get(mockOutboxKey)?.startsWith(PREFIX)).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: полки работают как прежде', () => {
  it('не отправленная публикация остаётся в очереди', async () => {
    seedQueue();
    await flushFeedPublishQueue(pair);
    await settle();
    expect(queueTexts()).toEqual([DRAFT]);
  });

  it('конверт без публикации откладывается, а не пропадает', async () => {
    await deliverOrphanReaction('нетТакогоПоста');
    expect(mockKv.has(mockDeferKey)).toBe(true);
  });

  it('конверт, которому есть куда лечь, на полку не идёт', async () => {
    mockPosts.set('естьТакойПост', {
      id: 'естьТакойПост', authorDid: myDid, text: 'пост', timestamp: Date.now(),
    });
    await deliverOrphanReaction('естьТакойПост');
    expect(mockKv.has(mockDeferKey)).toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: столбец значений kv открыт', () => {
  it('обычная запись kv кладёт значение как есть', async () => {
    const { kvSetChecked } = jest.requireMock('../../storage/local') as {
      kvSetChecked: (k: string, v: string) => Promise<boolean>;
    };
    await kvSetChecked('обычныйКлюч', DRAFT);
    expect(mockKv.get('обычныйКлюч')).toBe(DRAFT);
  });

  it('сама лента при этом шифрует и текст, и имя автора', () => {
    const storage = readFileSync(join(__dirname, '..', '..', 'storage', 'feedStorage.ts'), 'utf8');
    expect(storage).toContain('encryptAtRestString(row.text, dek)');
    expect(storage).toContain('encryptAtRestNullable(row.authorName ?? null, dek)');
  });
});

describe('форма исходников: три полки названы поимённо', () => {
  const SRC = readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8');
  /** Строки кода без комментариев — иначе объяснение сойдёт за сам код. */
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('очередь публикаций читается и пишется секретной парой', () => {
    expect(CODE).toContain('const cell = await kvGetSecretCell(FEED_QUEUE_KEY);');
    expect(CODE).toContain('if (!(await kvSetSecret(FEED_QUEUE_KEY, JSON.stringify(q))))');
    expect(CODE).not.toContain('kvSetChecked(FEED_QUEUE_KEY');
  });

  it('очередь комментариев — тоже', () => {
    expect(CODE).toContain('const cell = await kvGetSecretCell(COMMENT_OUTBOX_KEY);');
    expect(CODE).toContain('if (await kvSetSecret(COMMENT_OUTBOX_KEY,');
    expect(CODE).not.toContain('kvSetChecked(COMMENT_OUTBOX_KEY');
  });

  it('полка отложенных конвертов — тоже', () => {
    expect(CODE).toContain('const cell = await kvGetSecretCell(`${DEFERRED_KEY_PREFIX}${pid}`);');
    expect(CODE).toContain("if (await kvSetSecret(key, JSON.stringify(store))) return 'shelved';");
  });

  it('«не открылось» нигде не сведено к «пусто»', () => {
    // Все три чтения отвечают тем же null, что и прежде на отказ базы: полка
    // кладётся обратно целиком, и писать поверх непрочитанного нельзя.
    expect(CODE).toContain("  if (cell.state === 'unreadable') return null;");
    expect((CODE.match(/if \(cell\.state === 'unreadable'\)/g) ?? []).length).toBe(3);
  });
});
