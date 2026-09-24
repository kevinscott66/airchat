/**
 * Снятое с полки зря возвращается обратно (v4.32.784).
 *
 * Дефект. `drainDeferred` снимает с полки всё, что ждало пришедшей публикации,
 * очищает полку и только потом применяет снятое. Очистка первой — решение
 * намеренное: событие, которое роняет применение, иначе падало бы снова при
 * каждой следующей публикации. Но исход применения выбрасывался целиком.
 *
 * С v4.32.783 у применения есть исход, который приговором не является:
 * `'deferred'` означает «не применено и не отложено» — база отказала в записи
 * полки. Событие в этот миг уже снято с полки, а обратно не легло: реакция,
 * комментарий, правка или голос пропадали навсегда из-за одной заминки базы.
 * Своей очереди повторов нет ни у одного из четырёх родов.
 *
 * Правка. `'deferred'` в цикле собирается отдельно и после цикла кладётся на
 * полку заново. Полка при этом ПЕРЕЧИТЫВАЕТСЯ: пока шло применение, на неё
 * могли лечь события по другим публикациям, и запись старой карты поверх
 * стёрла бы их — та самая беда, ради которой в v4.32.698 чтение полки стало
 * двойственным. Брошенное исключение по-прежнему приговор: отличить негодное
 * событие от занятой базы по нему нельзя.
 *
 * Проверка поведением: модуль настоящий, отказы подделаны на уровне kv и
 * хранилища ленты — ровно там, где отказывает база.
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
/** Принимает ли хранилище реакции: `false` — отказ записи при живой публикации. */
let mockReactionsWritable = true;

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(row: Row): Promise<void> { mockPosts.set(row.id, row); }
    async getPost(id: string): Promise<Row | null> { return mockPosts.get(id) ?? null; }
    async addReaction(postId: string, emoji: string, did: string): Promise<boolean> {
      if (!mockReactionsWritable) return false;
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
/** Сколько раз полку уже пробовали записать через проверяемую форму. */
let mockSetCalls = 0;
/** Номера этих попыток (с единицы), на которых база отвечает отказом. */
let mockFailSetOn: number[] = [];

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (k !== mockDeferKey) { mockKv.set(k, v); return true; }
    mockSetCalls += 1;
    if (mockFailSetOn.includes(mockSetCalls)) return false;
    mockKv.set(k, v);
    return true;
  }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  // v4.32.815: три полки ленты легли под шифр. Подмена повторяет настоящую
  // пару в точности: kvGetSecretCell — это kvTryGet плюс расшифровка,
  // kvSetSecret — kvSetChecked плюс шифрование, так что здешние отказы
  // базы остаются ровно там, где были.
  kvGetSecretCell: jest.fn(async (k: string) => {
    const raw = mockKv.get(k);
    return raw === undefined ? { state: 'absent' } : { state: 'plain', text: raw };
  }),
  kvSetSecret: jest.fn(async (k: string, v: string) => {
    if (k !== mockDeferKey) { mockKv.set(k, v); return true; }
    mockSetCalls += 1;
    if (mockFailSetOn.includes(mockSetCalls)) return false;
    mockKv.set(k, v);
    return true;
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

async function deliver(id: Identity, payload: FeedEnvelopePayload): Promise<string> {
  const frame = await serializeFeedEnvelope(id.pair, payload);
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  const intake = await receiveFeedEnvelope(wrapper(frame, 0), '');
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  return intake;
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

const WAITER_DID = 'did:key:zWaitingReactionAuthor';
const OTHER_DID = 'did:key:zAuthorOfAnotherWaitingEvent';

/**
 * Положить на полку реакцию, ждущую публикацию `postId`, а заодно — событие по
 * другой публикации: оно не должно пострадать ни при разборе, ни при возврате.
 */
function seedShelf(postId: string): void {
  const at = Date.now();
  mockKv.set(
    mockDeferKey,
    JSON.stringify({
      [postId]: { at, events: [{ type: 'feed_reaction', authorDid: WAITER_DID, ts: at, data: { emoji: '👍' } }] },
      'other-post': { at, events: [{ type: 'feed_reaction', authorDid: OTHER_DID, ts: at, data: { emoji: '🔥' } }] },
    })
  );
}

/** Что лежит на полке сейчас: ключ публикации → список авторов событий. */
function shelf(): Record<string, string[]> {
  const raw = mockKv.get(mockDeferKey);
  if (raw === undefined) return {};
  const parsed = JSON.parse(raw) as Record<string, { events: { authorDid: string }[] }>;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v.events.map((e) => e.authorDid);
  return out;
}

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockReactions.length = 0;
  mockReactionsWritable = true;
  mockSetCalls = 0;
  mockFailSetOn = [];
});

describe('применение отказало в записи — событие возвращается на полку', () => {
  test('реакция, снятая с полки, не пропадает из-за заминки базы', async () => {
    seedShelf('drain-1');
    // Публикация придёт, но запись реакции не пройдёт, а попытка отложить её
    // обратно упрётся в отказ базы. Первая запись полки — очистка, она
    // проходит; вторая — то самое откладывание, и отказ подставлен ей.
    mockReactionsWritable = false;
    mockFailSetOn = [2];
    const author = newIdentity();

    expect(await deliver(author, post(author, 'drain-1'))).toBe('consumed');

    // До правки полка оставалась только с «other-post»: ждавшая реакция была
    // снята, применена вхолостую и потеряна навсегда.
    expect(mockReactions).toEqual([]);
    expect(shelf()).toEqual({ 'other-post': [OTHER_DID], 'drain-1': [WAITER_DID] });
  });

  test('соседние события полки возвратом не затираются', async () => {
    seedShelf('drain-2');
    mockReactionsWritable = false;
    mockFailSetOn = [2];
    const author = newIdentity();
    await deliver(author, post(author, 'drain-2'));
    // Полка перечитывается перед возвратом — иначе «other-post» лёг бы под
    // старой картой и пропал.
    expect(shelf()['other-post']).toEqual([OTHER_DID]);
  });

  test('вернувшееся применяется, когда база отвечает', async () => {
    seedShelf('drain-3');
    mockReactionsWritable = false;
    mockFailSetOn = [2];
    const author = newIdentity();
    await deliver(author, post(author, 'drain-3'));

    // Публикация приходит второй раз (пересылка по цепочке) — теперь всё пишется.
    mockReactionsWritable = true;
    await deliver(author, post(author, 'drain-3'));
    expect(mockReactions).toEqual([`drain-3|👍|${WAITER_DID}`]);
    expect(shelf()).toEqual({ 'other-post': [OTHER_DID] });
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный разбор полки не изменился', () => {
  test('ждавшая реакция применяется и с полки уходит', async () => {
    seedShelf('ok-1');
    const author = newIdentity();
    expect(await deliver(author, post(author, 'ok-1'))).toBe('consumed');
    expect(mockReactions).toEqual([`ok-1|👍|${WAITER_DID}`]);
    expect(shelf()).toEqual({ 'other-post': [OTHER_DID] });
  });

  test('применение прошло — назад ничего не кладётся', async () => {
    seedShelf('ok-2');
    const author = newIdentity();
    await deliver(author, post(author, 'ok-2'));
    // Записей полки ровно одна: очистка. Возврата не было.
    expect(mockSetCalls).toBe(1);
  });
});

describe('исходник: очистка и возврат названы', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const drain = (): string =>
    CODE.slice(
      CODE.indexOf('async function drainDeferred('),
      CODE.indexOf('async function reshelveDeferred(')
    );

  test('полка по-прежнему очищается ДО применения', () => {
    const fn = drain();
    const save = fn.indexOf('await saveDeferred(pid, taken.store)');
    const apply = fn.indexOf('await applyFeedEnvelope(');
    expect(save).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(save);
  });

  test('неудавшаяся очистка названа вслух, а применение всё равно идёт', () => {
    const fn = drain();
    expect(fn).toContain("if ((await saveDeferred(pid, taken.store)) === 'failed') {");
    expect(fn).toContain("log.warn('feed_deferred_clear_failed'");
    // Отказ очистки не обрывает разбор: события живут сутки, и не применить их
    // сейчас хуже, чем применить дважды.
    expect(fn).not.toMatch(/feed_deferred_clear_failed[\s\S]{0,200}\breturn;/);
  });

  test("возврат берёт только 'deferred' и перечитывает полку", () => {
    const fn = drain();
    expect(fn).toContain("if (applied === 'deferred') unshelved.push(event);");
    expect(fn).toContain('if (unshelved.length > 0) await reshelveDeferred(postId, pid, unshelved);');
    const re = CODE.slice(CODE.indexOf('async function reshelveDeferred('));
    expect(re.indexOf('const fresh = await loadDeferred(pid);')).toBeGreaterThan(-1);
    expect(re.indexOf('log.warn(\'feed_deferred_reshelve_unreadable\'')).toBeGreaterThan(-1);
  });

  test('брошенное исключение приговором и осталось', () => {
    const fn = drain();
    const caught = fn.indexOf("log.warn('feed_deferred_apply_failed'");
    expect(caught).toBeGreaterThan(-1);
    // В ловушке возврата нет: отличить негодное событие от занятой базы по
    // исключению нельзя, а вечно возвращать падающее — ронять каждую
    // следующую публикацию.
    expect(fn.slice(caught, fn.indexOf('}', caught))).not.toContain('unshelved.push');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

  test("'deferred' у применения значит «не применено и не отложено»", () => {
    expect(SRC).toContain("type FeedApply = 'applied' | 'unknown' | 'deferred';");
    expect(SRC).toContain("if (!stored && (await deferFeedEvent(payload, envelopePid)) === 'failed') return 'deferred';");
  });

  test('своей очереди повторов у откладываемых родов нет', () => {
    const DEF = fs.readFileSync(path.join(__dirname, '..', 'feedDeferred.ts'), 'utf8');
    // v4.32.825: родов стало шесть, и словарь записан в столбик.
    expect(DEF).toContain(
      "  | 'feed_poll_vote'\n  | 'feed_comment'\n  | 'feed_comment_reaction'\n  | 'feed_comment_delete';"
    );
    // Полка не бессрочна: сутки, и потерянное за это время уже не вернуть.
    expect(DEF).toContain('export const DEFERRED_TTL_MS = 24 * 60 * 60 * 1000;');
  });
});
