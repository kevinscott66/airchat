/**
 * Снятие реакции в нечитаемый столбец больше не выдаётся за снятое (v4.32.966).
 *
 * Дефект. `removeReaction` в хранилище ленты имел пять разных исходов и один
 * ответ на все — `void`. Среди них был «столбец реакций не открылся ключом»
 * (`mayOverwrite` не пустил) и «открылся, но не разобрался»: что в столбце
 * лежит, в этих случаях неизвестно, и снятие не применяется. Разбор конверта
 * ответа не спрашивал, писал в журнал `feed_unreaction_received` и возвращал
 * «разобрано» — то есть двигал метку «докуда прочитано» у ретранслятора.
 *
 * Цена. Повторов у реакции нет вовсе (см. `addAndBroadcastReaction`): второй
 * раз её не пришлют никогда. Значит снятие терялось насовсем, и получатель
 * видел под публикацией реакцию, которую автор снял, — без срока и без
 * способа это заметить. Постановку от той же беды прикрыли ещё в v4.32.544:
 * `addReaction` отвечает `false`, и кадр ложится на полку отложенных. Снятие
 * той же защиты не получило, хотя столбец у них общий.
 *
 * Правка. У снятия появилось слово: `removed` / `absent` / `no_post` /
 * `unreadable`. На `unreadable` разбор отвечает `'deferred'` — метка стоит,
 * кадр приедет снова, и когда столбец откроется, снятие доедет. Остальные три
 * исхода разобраны так же, как и были: применено или применять было нечего.
 *
 * Границы. Хранилище здесь подменено — проверяется разбор конверта, а не
 * SQLite. Само отображение исходов в хранилище закреплено по форме исходника,
 * как это уже сделано для нечитаемых столбцов в atRestCell.test.
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
/** Чем отвечает снятие реакции — подменяется в каждой проверке. */
let mockRemoval: 'removed' | 'absent' | 'no_post' | 'unreadable' = 'removed';
/** Сколько раз снятие спросили. */
let mockRemovals = 0;

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(row: Row): Promise<void> { mockPosts.set(row.id, row); }
    async getPost(id: string): Promise<Row | null> { return mockPosts.get(id) ?? null; }
    async addReaction(postId: string): Promise<boolean> { return mockPosts.has(postId); }
    async removeReaction(): Promise<string> { mockRemovals += 1; return mockRemoval; }
    async addComment(): Promise<boolean> { return true; }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
  },
}));

const mockKv = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetSecretCell: jest.fn(async (k: string) => {
    const raw = mockKv.get(k);
    return raw === undefined ? { state: 'absent' } : { state: 'plain', text: raw };
  }),
  kvSetSecret: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
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
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  return intake;
}

function unreaction(id: Identity, postId: string, emoji = '👍'): FeedEnvelopePayload {
  return {
    type: 'feed_reaction',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: { emoji, remove: true },
  } as unknown as FeedEnvelopePayload;
}

function reaction(id: Identity, postId: string, emoji = '👍'): FeedEnvelopePayload {
  return {
    type: 'feed_reaction',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: { emoji },
  } as unknown as FeedEnvelopePayload;
}

/** Только код: докблок пересказывает дефект и закрепку удовлетворять не должен. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SERVICE = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8'));
const STORAGE = codeOnly(
  fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'feedStorage.ts'), 'utf8')
);

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockRemoval = 'removed';
  mockRemovals = 0;
});

describe('нечитаемый столбец — снятие реакции не разобрано', () => {
  test('столбец не открылся: метка ретранслятора стоит', async () => {
    mockRemoval = 'unreadable';
    const author = newIdentity();
    mockPosts.set('rm-1', { id: 'rm-1', authorDid: author.did, text: 'т', timestamp: 1 });
    // До правки здесь было 'consumed': снятие молча не применилось, метка
    // ушла вперёд — и второй раз реакцию не снимет уже никто.
    expect(await deliver(author, unreaction(author, 'rm-1'))).toBe('deferred');
  });

  test('столбец открылся, но не разобрался — ответ тот же', async () => {
    // Оба этих исхода хранилище называет одним словом: что в столбце лежит,
    // неизвестно, а писать поверх неизвестного нельзя.
    mockRemoval = 'unreadable';
    const author = newIdentity();
    mockPosts.set('rm-2', { id: 'rm-2', authorDid: author.did, text: 'т', timestamp: 1 });
    expect(await deliver(author, unreaction(author, 'rm-2'))).toBe('deferred');
  });

  test('кадр приходит снова, и снятие доезжает', async () => {
    mockRemoval = 'unreadable';
    const author = newIdentity();
    mockPosts.set('rm-3', { id: 'rm-3', authorDid: author.did, text: 'т', timestamp: 1 });
    const frame = unreaction(author, 'rm-3');
    expect(await deliver(author, frame)).toBe('deferred');

    // Ключ повтора забыт вместе с отказом — иначе тот же кадр отсеялся бы как
    // «этот уже видели», и второй заход был бы только на словах.
    mockRemoval = 'removed';
    expect(await deliver(author, frame)).toBe('consumed');
    expect(mockRemovals).toBe(2);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Откладывать можно ровно неизвестность. Применённое снятие и снятие, которому
 * нечего снимать, обязаны разбираться с первого раза: иначе каждый такой кадр
 * ходил бы по кругу, пока ретранслятор его не выбросит.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: три остальных исхода разбираются с первого раза', () => {
  test('снятие применилось — конверт разобран', async () => {
    mockRemoval = 'removed';
    const author = newIdentity();
    mockPosts.set('ok-1', { id: 'ok-1', authorDid: author.did, text: 'т', timestamp: 1 });
    expect(await deliver(author, unreaction(author, 'ok-1'))).toBe('consumed');
  });

  test('ГРАНИЦА: снимать было нечего — тоже разобран', async () => {
    mockRemoval = 'absent';
    const author = newIdentity();
    mockPosts.set('ok-2', { id: 'ok-2', authorDid: author.did, text: 'т', timestamp: 1 });
    expect(await deliver(author, unreaction(author, 'ok-2'))).toBe('consumed');
  });

  test('ГРАНИЦА: публикации нет, полка пуста — откладывать нечего', async () => {
    mockRemoval = 'no_post';
    const author = newIdentity();
    expect(await deliver(author, unreaction(author, 'ok-3'))).toBe('consumed');
  });

  test('ГРАНИЦА: постановка реакции ведёт себя как прежде', async () => {
    const author = newIdentity();
    // Публикации нет — реакция ложится на полку и ждёт её. Снятия тут не
    // спрашивают вовсе.
    expect(await deliver(author, reaction(author, 'ok-4'))).toBe('consumed');
    expect(mockRemovals).toBe(0);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Постановка тот же самый нечитаемый столбец различала уже давно — и именно
 * поэтому молчание снятия было перекосом, а не общим правилом дома.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: у постановки этот ответ был всегда', () => {
  test('постановка отвечает отказом и кладёт кадр на полку', () => {
    expect(STORAGE).toContain('async addReaction(postId: string, emoji: string, authorDid: string): Promise<boolean> {');
    expect(SERVICE).toContain("if (!stored && (await deferFeedEvent(payload, envelopePid)) === 'failed') return 'deferred';");
  });

  test('повторов у реакции нет — потерянное снятие теряется насовсем', () => {
    // Реакция уходит одним заходом: очереди повторов у неё нет ни на отправке,
    // ни на приёме, и второго кадра ждать неоткуда.
    expect(SERVICE).toContain('async function addAndBroadcastReaction(');
    expect(SERVICE).not.toContain('retryReaction(');
  });
});

describe('форма исходников: у снятия есть слово, и его спрашивают', () => {
  test('хранилище называет все четыре исхода', () => {
    expect(STORAGE).toContain("export type ReactionRemoval = 'removed' | 'absent' | 'no_post' | 'unreadable';");
    expect(STORAGE).toContain('async removeReaction(postId: string, emoji: string, authorDid: string): Promise<ReactionRemoval> {');
    const body = STORAGE.slice(
      STORAGE.indexOf('  async removeReaction('),
      STORAGE.indexOf('  async setBookmarked(')
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("if (!row) return 'no_post';");
    expect(body).toContain("if (!row.reactions) return 'absent';");
    expect(body).toContain("return 'removed';");
    // Оба неизвестных исхода — нераскрытый столбец и неразобранный — названы
    // одним словом, потому что решение по ним одно.
    expect(body.split("return 'unreadable';").length - 1).toBe(2);
  });

  test('разбор конверта это слово спрашивает и на нём останавливается', () => {
    expect(SERVICE).toContain('const removal = await s.removeReaction(payload.postId, d.emoji, payload.authorDid);');
    const at = SERVICE.indexOf('const removal = await s.removeReaction(');
    expect(at).toBeGreaterThan(0);
    const after = SERVICE.slice(at, at + 400);
    const guard = after.indexOf("if (removal === 'unreadable') {");
    const ret = after.indexOf("return 'deferred';");
    expect(guard).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(guard);
    // И раньше, чем «разобрано» попадёт в журнал.
    expect(after.indexOf("log.info('feed_unreaction_received'")).toBeGreaterThan(ret);
  });

  test('свой переключатель не рассылает снятие, которого у себя не случилось', () => {
    expect(SERVICE).toContain("if ((await s.removeReaction(postId, emoji, myDid)) === 'unreadable') {");
  });
});
