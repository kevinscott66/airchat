/**
 * Поток чужих конвертов больше не гоняет моё радио без предела (v4.32.943).
 *
 * Дефект. Лента расходится сплетней: конверт, пришедший от соседа,
 * заворачивается обратно и уходит всем моим контактам. Ограничители на этом
 * пути были, но каждый считал не то: прыжки держали глубину, отметка «уже
 * переслали» — повторы одного конверта, веер — цену одной пересылки. Сколько
 * РАЗНЫХ конвертов в минуту через меня пройдёт, не спрашивал никто, а
 * наделать подписанных конвертов можно сколько угодно: подпись доказывает, что
 * автор их написал, и ничего не говорит о том, сколько их.
 *
 * Цена. Не спам в ленте — спам отсеется у соседей по их же отметке. Цена в
 * том, кто за него платит: одна входящая посылка превращалась в 64 исходящих
 * с моего радио, и соседям источником этого потока выгляжу я. Заблокировать
 * они могут только меня.
 *
 * Правка. Квота пересылки чужого за скользящую минуту: общая (настоящая
 * граница, названная в посылках моего радио) и по автору (чтобы один шумный
 * не съедал общую целиком). Отказ по квоте касается ТОЛЬКО пересылки —
 * конверт разбирается и сохраняется как обычно.
 *
 * Границы. Счёт идёт по автору из подписанного тела, а не по соседу из
 * заголовка кадра: заголовок никем не заверен, а у интернет-ретранслятора его
 * нет вовсе. Своих ключей злоумышленник наделает сколько угодно — потому и
 * нужен общий предел, а не только поавторный.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => mockContacts) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(): Promise<void> { mockSaved += 1; }
  },
}));

import { Buffer } from 'buffer';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { multiTransportRouter } from '../../transport/multiTransport';
import {
  FeedRelayBudget,
  FEED_RELAY_MAX_PER_AUTHOR,
  FEED_RELAY_MAX_PER_MINUTE,
  FEED_RELAY_WINDOW_MS,
} from '../feedRelayBudget';
import { receiveFeedEnvelope, setFeedProfileContext } from '../feedService';
import { serializeFeedEnvelope, type FeedEnvelopePayload } from '../feedTransport';

let mockContacts: { peerPublicKey: string }[] = [];
let mockSaved = 0;

type Identity = { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string; b64: string };

function newIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    pair: { secretKey, publicKey },
    did: publicKeyToDidKey(publicKey),
    b64: Buffer.from(publicKey).toString('base64'),
  };
}

async function frameFrom(id: Identity, postId: string): Promise<Uint8Array> {
  const payload = {
    type: 'feed_post',
    postId,
    authorDid: id.did,
    ts: Date.now(),
    data: { kind: 'post', text: 'привет' },
  } as unknown as FeedEnvelopePayload;
  const frame = await serializeFeedEnvelope(id.pair, payload);
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  return frame;
}

/** Обёртка ретрансляции со счётчиком прыжков, как её кладёт посредник. */
function wrapper(inner: Uint8Array, h: number): Uint8Array {
  const json = JSON.stringify({ h, f: Buffer.from(inner).toString('base64') });
  const bytes = new TextEncoder().encode(json);
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0xf1;
  out.set(bytes, 1);
  return out;
}

/** Пересылка идёт без await — дать очереди микрозадач опустеть. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((r) => setImmediate(r));
}

const send = multiTransportRouter.send as unknown as jest.Mock;

/**
 * Часы под управлением теста.
 *
 * Квота — окно в реальном времени и состояние модуля, общее для всего файла.
 * Без своих часов второй тест начинался бы с квотой, потраченной первым, а
 * порядок тестов превратился бы в часть условия. Сдвиг между тестами больше
 * окна: каждый начинает с полной квотой.
 */
let mockNow = 1_800_000_000_000;

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SRC = (name: string): string => readFileSync(join(__dirname, '..', name), 'utf8');

beforeAll(async () => {
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
  await setFeedProfileContext(1);
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  mockNow += FEED_RELAY_WINDOW_MS * 2;
  send.mockClear();
  mockContacts = [];
  mockSaved = 0;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная пересылка работает', () => {
  it('одиночный чужой конверт уходит соседям', async () => {
    const author = newIdentity();
    mockContacts = [{ peerPublicKey: newIdentity().b64 }];
    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'budget-ok'), 0), '');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('десяток разных конвертов одного автора проходит целиком', async () => {
    const author = newIdentity();
    mockContacts = [{ peerPublicKey: newIdentity().b64 }];
    for (let i = 0; i < 10; i += 1) {
      await receiveFeedEnvelope(wrapper(await frameFrom(author, `budget-ten-${i}`), 0), '');
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(10);
  });
});

describe('квота пересылки чужого', () => {
  it('один автор не уносит больше своей доли', async () => {
    const author = newIdentity();
    mockContacts = [{ peerPublicKey: newIdentity().b64 }];
    const flood = FEED_RELAY_MAX_PER_AUTHOR + 5;
    for (let i = 0; i < flood; i += 1) {
      await receiveFeedEnvelope(wrapper(await frameFrom(author, `budget-flood-${i}`), 0), '');
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(FEED_RELAY_MAX_PER_AUTHOR);
  });

  it('толпа разных авторов не уносит больше общей квоты', async () => {
    mockContacts = [{ peerPublicKey: newIdentity().b64 }];
    const flood = FEED_RELAY_MAX_PER_MINUTE + 5;
    for (let i = 0; i < flood; i += 1) {
      const author = newIdentity();
      await receiveFeedEnvelope(wrapper(await frameFrom(author, `budget-crowd-${i}`), 0), '');
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(FEED_RELAY_MAX_PER_MINUTE);
  });

  it('отказ по квоте отнимает пересылку, а не саму запись', async () => {
    const author = newIdentity();
    mockContacts = [{ peerPublicKey: newIdentity().b64 }];
    const flood = FEED_RELAY_MAX_PER_AUTHOR + 3;
    for (let i = 0; i < flood; i += 1) {
      const intake = await receiveFeedEnvelope(
        wrapper(await frameFrom(author, `budget-keep-${i}`), 0),
        '',
      );
      expect(intake).toBe('consumed');
      await settle();
    }
    // Пересылок — по квоте, а записей — все: отказ здесь означает «дальше не
    // понесу», а не «не видел».
    expect(send).toHaveBeenCalledTimes(FEED_RELAY_MAX_PER_AUTHOR);
    expect(mockSaved).toBe(flood);
  });
});

describe('учёт квоты сам по себе', () => {
  it('минута прошла — квота снова полная', () => {
    const b = new FeedRelayBudget();
    const t0 = 1_000_000;
    for (let i = 0; i < FEED_RELAY_MAX_PER_AUTHOR; i += 1) {
      expect(b.admit('did:key:z6Mk-один', t0)).toBe(true);
    }
    expect(b.admit('did:key:z6Mk-один', t0)).toBe(false);
    expect(b.admit('did:key:z6Mk-один', t0 + FEED_RELAY_WINDOW_MS + 1)).toBe(true);
  });

  it('шумный автор не закрывает дорогу остальным', () => {
    const b = new FeedRelayBudget();
    const t0 = 2_000_000;
    for (let i = 0; i < FEED_RELAY_MAX_PER_AUTHOR + 5; i += 1) b.admit('did:key:z6Mk-шумный', t0);
    expect(b.spent(t0)).toBe(FEED_RELAY_MAX_PER_AUTHOR);
    expect(b.admit('did:key:z6Mk-тихий', t0)).toBe(true);
  });

  it('общий предел выше поавторного и он последний', () => {
    const b = new FeedRelayBudget();
    const t0 = 3_000_000;
    let ok = 0;
    for (let i = 0; i < FEED_RELAY_MAX_PER_MINUTE + 20; i += 1) {
      if (b.admit(`did:key:z6Mk-${i}`, t0)) ok += 1;
    }
    expect(ok).toBe(FEED_RELAY_MAX_PER_MINUTE);
    expect(FEED_RELAY_MAX_PER_AUTHOR).toBeLessThan(FEED_RELAY_MAX_PER_MINUTE);
  });

  it('память не растёт: опустевшие авторы вычищаются', () => {
    const b = new FeedRelayBudget();
    const t0 = 4_000_000;
    for (let i = 0; i < FEED_RELAY_MAX_PER_MINUTE; i += 1) b.admit(`did:key:z6Mk-${i}`, t0);
    expect(b.spent(t0 + FEED_RELAY_WINDOW_MS + 1)).toBe(0);
    // Квота освободилась целиком — значит окно вычищено, а не просто не считано.
    expect(b.admit('did:key:z6Mk-новый', t0 + FEED_RELAY_WINDOW_MS + 1)).toBe(true);
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('квота спрашивается в самом условии пересылки', () => {
    const body = codeOnly(SRC('feedService.ts'));
    expect(body).toContain('if (!feedRelayBudget.admit(payload.authorDid, Date.now())) {');
    // И раньше отметки «уже переслали»: отказ по квоте — не «уже понёс».
    const budget = body.indexOf('feedRelayBudget.admit(payload.authorDid');
    const mark = body.indexOf('!feedRelayMarkOrHas(dedupKey)');
    expect(budget).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(budget);
  });

  it('счёт идёт по автору из подписанного тела, а не по соседу из заголовка', () => {
    const body = codeOnly(SRC('feedService.ts'));
    expect(body).not.toContain('feedRelayBudget.admit(senderDid');
  });

  it('пределы названы числами в одном месте', () => {
    const body = codeOnly(SRC('feedRelayBudget.ts'));
    expect(body).toContain('export const FEED_RELAY_WINDOW_MS = 60_000;');
    expect(body).toContain('export const FEED_RELAY_MAX_PER_MINUTE = 60;');
    expect(body).toContain('export const FEED_RELAY_MAX_PER_AUTHOR = 20;');
  });
});
