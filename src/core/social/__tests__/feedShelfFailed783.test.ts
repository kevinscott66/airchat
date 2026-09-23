/**
 * Не легло на полку — конверт ленты больше не считается разобранным (v4.32.783).
 *
 * Дефект. Событие, приехавшее раньше своей публикации — реакция, комментарий,
 * правка, голос в опросе, — применить некуда, и его кладут на полку
 * отложенных. Полка эта у него единственный второй шанс: очереди повторов у
 * реакции нет вовсе, а комментарий-сироту отвергает уже дошедший конверт.
 *
 * `saveDeferred` звала `kvSet`/`kvDelete`, а обе гасят отказ базы внутри себя
 * и отвечают `void` — значит собственная ловушка вокруг них не срабатывала
 * никогда, бросать было нечему. Полка молча не записывалась, `deferFeedEvent`
 * отвечал `void`, разбор доходил до конца и возвращал `'consumed'`, а
 * `'consumed'` двигает метку «докуда прочитано» у ретранслятора необратимо.
 * Ретранслятор держит кадр ещё тридцать суток, но забрать его уже нельзя.
 *
 * Правка. У откладывания появился исход (`DeferWrite`), у разбора конверта —
 * третий ответ (`FeedApply = 'applied' | 'unknown' | 'deferred'`). Не легло на
 * полку — `receiveFeedEnvelope` отвечает `'deferred'`, забывает ключ повтора и
 * называет отказ вслух. Метка стоит на месте, и кадр приедет снова.
 *
 * Проверка поведением: модуль настоящий, отказ подделан на уровне kv — ровно
 * там, где отказывает база.
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

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(row: Row): Promise<void> { mockPosts.set(row.id, row); }
    async getPost(id: string): Promise<Row | null> { return mockPosts.get(id) ?? null; }
    async addReaction(postId: string): Promise<boolean> { return mockPosts.has(postId); }
    async removeReaction(): Promise<void> { /* снятие проверяется не здесь */ }
    async addComment(): Promise<boolean> { return true; }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
  },
}));

const mockKv = new Map<string, string>();
const mockDeferKey = 'feed_deferred_v1:p1';
/** Отвечает ли `kvSetChecked` отказом на записи полки. */
let mockFailDeferWrite = false;

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    // Ровно так отказывает настоящая kvSetChecked: строка не легла, и об этом
    // сказано ответом, а не исключением.
    if (k === mockDeferKey && mockFailDeferWrite) return false;
    mockKv.set(k, v);
    return true;
  }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
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

/** Доставить конверт и вернуть исход разбора — то, чем двигается метка. */
async function deliver(id: Identity, payload: FeedEnvelopePayload): Promise<string> {
  const frame = await serializeFeedEnvelope(id.pair, payload);
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  const intake = await receiveFeedEnvelope(wrapper(frame, 0), '');
  // Пересылка запускается без await — дать очереди микрозадач провернуться.
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  return intake;
}

function reaction(id: Identity, postId: string, emoji: string): FeedEnvelopePayload {
  return {
    type: 'feed_reaction',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: { emoji },
  } as unknown as FeedEnvelopePayload;
}

function edit(id: Identity, postId: string): FeedEnvelopePayload {
  return {
    type: 'feed_edit',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: { newText: 'поправленное' },
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

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockFailDeferWrite = false;
});

describe('полка не приняла событие — метка ретранслятора стоит', () => {
  test('реакция без публикации: отказ записи отвечает «не разобрано»', async () => {
    mockFailDeferWrite = true;
    const author = newIdentity();
    // До правки здесь было 'consumed': полка молча не записалась, а метка
    // ушла вперёд — и реакцию не прислал бы уже никто.
    expect(await deliver(author, reaction(author, 'shelf-1', '👍'))).toBe('deferred');
    expect(mockKv.has(mockDeferKey)).toBe(false);
  });

  test('правка неизвестной публикации — так же', async () => {
    mockFailDeferWrite = true;
    const author = newIdentity();
    expect(await deliver(author, edit(author, 'shelf-2'))).toBe('deferred');
  });

  test('второй приход того же кадра снова доходит до разбора', async () => {
    mockFailDeferWrite = true;
    const author = newIdentity();
    const r = reaction(author, 'shelf-3', '🔥');
    expect(await deliver(author, r)).toBe('deferred');
    // Ключ повтора забыт — иначе кадр, пришедший снова, отсеялся бы как
    // «этот уже видели», и второй шанс был бы только на словах.
    mockFailDeferWrite = false;
    expect(await deliver(author, r)).toBe('consumed');
    expect(Object.keys(JSON.parse(mockKv.get(mockDeferKey) ?? '{}') as object)).toEqual(['shelf-3']);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: когда полка пишется, всё как было', () => {
  test('удачное откладывание отвечает «разобрано»', async () => {
    const author = newIdentity();
    expect(await deliver(author, reaction(author, 'ok-1', '👍'))).toBe('consumed');
    expect(mockKv.has(mockDeferKey)).toBe(true);
  });

  test('публикация применяется и полку по себе очищает', async () => {
    const author = newIdentity();
    await deliver(author, reaction(author, 'ok-2', '👍'));
    expect(await deliver(author, post(author, 'ok-2'))).toBe('consumed');
    expect(mockKv.has(mockDeferKey)).toBe(false);
  });

  test('конверт неизвестного рода не считается отложенным', async () => {
    mockFailDeferWrite = true;
    const author = newIdentity();
    const odd = {
      type: 'feed_unknown_kind',
      postId: 'ok-3',
      authorDid: author.did,
      ts: Date.now(),
      data: {},
    } as unknown as FeedEnvelopePayload;
    // Разбирать нечего, но и возвращаться к нему незачем: это `'unknown'`,
    // а не `'deferred'`.
    expect(await deliver(author, odd)).toBe('consumed');
  });
});

describe('исходник: исходы объявлены и читаются', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  /** Только код: докблок здесь пересказывает сам дефект. */
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('у откладывания и у разбора конверта появился исход', () => {
    expect(CODE).toContain("type DeferWrite = 'shelved' | 'failed';");
    expect(CODE).toContain("type FeedApply = 'applied' | 'unknown' | 'deferred';");
    expect(CODE).toContain('async function saveDeferred(pid: number, store: DeferredStore): Promise<DeferWrite> {');
    expect(CODE).toContain('): Promise<FeedApply> {');
  });

  test('полка пишется проверяемыми формами, а не гасящими', () => {
    const body = CODE.slice(
      CODE.indexOf('async function saveDeferred('),
      CODE.indexOf('async function deferFeedEvent(')
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('await kvDeleteChecked(key);');
    expect(body).toContain('if (await kvSetChecked(key, JSON.stringify(store))) return \'shelved\';');
    expect(body).not.toContain('await kvSet(');
    expect(body).not.toContain('await kvDelete(');
  });

  test('отказ полки снимает ключ повтора и назван вслух', () => {
    const recv = CODE.slice(CODE.indexOf('const applied = await applyFeedEnvelope(payload, s, envelopePid);'));
    const forget = recv.indexOf('feedSeenForget(dedupKey);');
    const warn = recv.indexOf("log.warn('feed_envelope_shelf_failed'");
    const ret = recv.indexOf("return 'deferred';");
    expect(forget).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(forget);
    expect(ret).toBeGreaterThan(warn);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
  const COORD = fs.readFileSync(
    path.join(__dirname, '..', '..', 'transport', 'internet', 'internetCoordinator.ts'),
    'utf8'
  );

  test('гасящие kvSet/kvDelete по-прежнему глотают отказ внутри себя', () => {
    expect(LOCAL).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(LOCAL).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
    expect(LOCAL).toContain('export async function kvDeleteChecked(key: string): Promise<void> {');
  });

  test("'consumed' двигает метку, а 'deferred' даёт кадру ещё один заход", () => {
    expect(COORD).toContain("if (intake === 'consumed') {");
    expect(COORD).toContain("log.warn('internet_frame_deferred'");
    // Ответ 'deferred' не вечен: второй отказ по тому же кадру сдвигает метку
    // сам, так что застрять на нём нельзя.
    expect(COORD).toContain("giveUp('internet_frame_deferred_again')");
  });
});
