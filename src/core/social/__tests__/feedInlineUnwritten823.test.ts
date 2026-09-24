/**
 * Не легшее вложение больше не оставляет в ленте пустое место навсегда (v4.32.823).
 *
 * Дефект. Байты снимков и документов входящей публикации приезжают внутри
 * самого конверта и кладутся в kv по ключам, собранным из номера публикации.
 * Строка поста при этом записывается ПЕРВОЙ и уже несёт ссылки `inline:…` на
 * эти ключи. Отказ `kvSetInlineAttachment` только записывался в журнал: разбор
 * доходил до конца и отвечал `'consumed'`, а `'consumed'` двигает метку
 * «докуда прочитано» у ретранслятора необратимо.
 *
 * Цена. Публикацию второй раз не присылают — очереди повторов у неё нет, — а
 * уборка сирот трогает только свои посты (v4.32.735). Значит ссылка без байтов
 * оставалась навечно: у контакта в ленте висело пустое место, и объяснить его
 * было нечем. Отказ же здесь проходящий: `kvSetInlineAttachment` отвечает
 * `false` на занятую базу и на недоступный ключ шифрования, а негодные байты
 * отсеяла `sanitizeInlineMedia` раньше и молча.
 *
 * Правка. Неудачи считаются, и хоть одна из них откладывает кадр. Строка поста
 * при этом остаётся записанной нарочно: текст и уцелевшие снимки человек видит
 * сразу, а повтор перезапишет и строку, и байты по тем же ключам.
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

type Row = { id: string; authorDid: string; text: string; mediaCids: string[] | null };
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
/** Какие вложения база отказывается принимать. */
let mockInlineFail: 'none' | 'media' | 'doc' | 'all' = 'none';

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
  kvGetInlineAttachment: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGetInlineAttachment: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  // Настоящая отвечает отказом ОТВЕТОМ, а не исключением: и на занятую базу,
  // и на недоступный ключ шифрования. Подмена повторяет это в точности.
  kvSetInlineAttachment: jest.fn(async (k: string, v: string) => {
    const isDoc = k.startsWith('feed_inline_doc:');
    if (mockInlineFail === 'all') return false;
    if (mockInlineFail === 'doc' && isDoc) return false;
    if (mockInlineFail === 'media' && !isDoc) return false;
    mockKv.set(k, v);
    return true;
  }),
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

/** Восемь символов, кратно четырём: настоящий base64, как у сжатого снимка. */
const B64 = 'QUJDRA==';

function post(
  id: Identity,
  postId: string,
  over: Record<string, unknown> = {},
): FeedEnvelopePayload {
  return {
    type: 'feed_post',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: {
      kind: 'post',
      text: 'смотрите, что нашёл',
      media: [B64],
      mediaMime: ['image/jpeg'],
      ...over,
    },
  } as unknown as FeedEnvelopePayload;
}

const DOC = { name: 'смета.pdf', mime: 'application/pdf', size: 4, data: B64 };

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockInlineFail = 'none';
});

describe('вложение не легло — кадр ждёт, а не объявляется разобранным', () => {
  test('снимок не записался: не разобрано', async () => {
    mockInlineFail = 'media';
    const author = newIdentity();
    // До правки здесь было 'consumed': метка уходила вперёд, публикацию второй
    // раз никто не присылает, и пустая плитка оставалась навсегда.
    expect(await deliver(author, post(author, 'inl-1'))).toBe('deferred');
  });

  test('документ не записался — так же', async () => {
    mockInlineFail = 'doc';
    const author = newIdentity();
    expect(await deliver(author, post(author, 'inl-2', { documents: [DOC] }))).toBe('deferred');
  });

  test('база отпустила — тот же кадр приносит публикацию со снимком', async () => {
    const author = newIdentity();
    const p = post(author, 'inl-3');
    mockInlineFail = 'media';
    expect(await deliver(author, p)).toBe('deferred');
    expect(mockKv.has('feed_inline_media:inl-3:0')).toBe(false);

    // Ключ повтора забыт — иначе кадр, пришедший снова, отсеялся бы как «этот
    // уже видели», и второй заход был бы только на словах.
    mockInlineFail = 'none';
    expect(await deliver(author, p)).toBe('consumed');
    expect(mockKv.get('feed_inline_media:inl-3:0')).toBe(B64);
  });

  test('один снимок из двух не лёг — кадра это тоже касается', async () => {
    const author = newIdentity();
    mockInlineFail = 'media';
    expect(
      await deliver(author, post(author, 'inl-4', { media: [B64, B64], mediaMime: ['image/jpeg', 'image/png'] }))
    ).toBe('deferred');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отсрочка стоит второго разбора всего конверта вместе с байтами вложений,
 * поэтому откладываться обязано ровно то, что отказало. Обычная публикация —
 * и с вложениями, и без них — проходит с первого раза, как и проходила.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: удачная запись ничего не откладывает', () => {
  test('публикация со снимком и документом разбирается с первого раза', async () => {
    const author = newIdentity();
    expect(await deliver(author, post(author, 'ok-1', { documents: [DOC] }))).toBe('consumed');
    expect(mockKv.get('feed_inline_media:ok-1:0')).toBe(B64);
    expect(mockKv.get('feed_inline_doc:ok-1:0')).toBe(B64);
  });

  test('публикация без вложений вовсе — тоже', async () => {
    const author = newIdentity();
    expect(await deliver(author, post(author, 'ok-2', { media: [], mediaMime: [] }))).toBe('consumed');
  });

  test('строка поста при отказе вложения остаётся записанной', async () => {
    // Нарочно: текст и уцелевшие снимки видны сразу, а повтор перезапишет и
    // строку, и байты по тем же ключам — postWriteGuard пропустит его как
    // своего, автор тот же.
    mockInlineFail = 'all';
    const author = newIdentity();
    await deliver(author, post(author, 'ok-3'));
    expect(mockPosts.get('ok-3')?.text).toBe('смотрите, что нашёл');
    expect(mockPosts.get('ok-3')?.mediaCids).toEqual(['inline:image/jpeg;0:ok-3']);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отсрочка чего-то стоит лишь при двух условиях: запись вложения сообщает о
 * беде ОТВЕТОМ (иначе её ловил бы общий catch и всё это было бы про другое), и
 * отложенный кадр приёмник действительно приносит снова — ровно один раз, а
 * потом отпускает метку сам.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: отказ назван ответом, а отсрочка ограничена', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
  const COORD = fs.readFileSync(
    path.join(__dirname, '..', '..', 'transport', 'internet', 'internetCoordinator.ts'),
    'utf8'
  );

  test('запись вложения отвечает словом, а не бросает', () => {
    expect(LOCAL).toContain(
      'export async function kvSetInlineAttachment(key: string, base64: string): Promise<boolean> {'
    );
  });

  test("'deferred' даёт кадру ещё один заход, и только один", () => {
    expect(COORD).toContain("if (intake === 'consumed') {");
    expect(COORD).toContain("giveUp('internet_frame_deferred_again')");
  });
});

describe('форма исходников: неудачи вложений считаются', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
  /** Только код: пояснения не должны сами удовлетворять проверку. */
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  test('счёт ведётся по обоим родам вложений и кончается отсрочкой', () => {
    const at = CODE.indexOf('let unwritten = 0;');
    expect(at).toBeGreaterThan(-1);
    const tail = CODE.slice(at, CODE.indexOf('await drainDeferred(payload.postId, s, envelopePid);', at));
    // Обе петли — и снимки, и документы — прибавляют к одному счёту.
    expect(tail.match(/unwritten \+= 1;/g)).toHaveLength(2);
    expect(tail).toContain("log.warn('feed_post_inline_unwritten'");
    const refuse = tail.indexOf('if (unwritten > 0) {');
    expect(refuse).toBeGreaterThan(-1);
    expect(tail.slice(refuse)).toContain("return 'deferred';");
  });

  test('строка поста пишется до вложений — её отсрочка не отменяет', () => {
    const save = CODE.indexOf('await s.savePost({');
    const count = CODE.indexOf('let unwritten = 0;');
    expect(save).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(save);
  });
});
