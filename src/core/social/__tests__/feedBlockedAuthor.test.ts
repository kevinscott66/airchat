/**
 * Лента и блокировка (v4.32.617).
 *
 * До этой версии лента про блокировку не знала вовсе: во всём feedService не
 * встречалось ни `isBlocked`, ни `blockPolicy`. Единственной заглушкой был
 * отдельный список `feed_muted_authors` — его человек заводит из самой ленты, и
 * к блокировке собеседника в переписке он отношения не имеет. Получалось:
 * заблокированный оставался автором в моей ленте, его публикации сохранялись,
 * показывались и вдобавок расходились дальше через мою ноду.
 *
 * Обратная сторона того же: заблокированный оставался и в списке контактов
 * (блок — это запрет, а не уборка списка), поэтому каждая моя публикация
 * по-прежнему адресовалась ему поимённо. Запрет обязан быть двухсторонним.
 *
 * Проверяются оба направления и обе точки в приёме — сохранение и пересылка.
 * Порядок здесь существенный: отбраковка стоит выше пересылки, иначе моя нода
 * усиливает того, кого я запретил.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  // Возвращает true: broadcastFeedEnvelope считает успехом только правдивый ответ.
  multiTransportRouter: { send: jest.fn(async () => true) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => mockContacts) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async () => {},
    isBlocked: (pub: string) => mockBlocked.has(pub),
  },
}));

const mockSaved: string[] = [];
jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async postWriteGuard(): Promise<string> { return 'ok'; }
    async savePost(row: { id?: string }): Promise<void> { mockSaved.push(row?.id ?? '?'); }
  },
}));

import { Buffer } from 'buffer';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { multiTransportRouter } from '../../transport/multiTransport';
import { receiveFeedEnvelope, setFeedProfileContext } from '../feedService';
import {
  serializeFeedEnvelope,
  broadcastFeedEnvelope,
  type FeedEnvelopePayload,
} from '../feedTransport';

/** Контакты, которых вернёт listContacts текущему тесту. */
let mockContacts: { peerPublicKey: string }[] = [];
/** base64 открытых ключей, которые числятся заблокированными. */
const mockBlocked = new Set<string>();

type Identity = { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string; b64: string };

function newIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    pair: { secretKey, publicKey },
    did: publicKeyToDidKey(publicKey),
    b64: Buffer.from(publicKey).toString('base64'),
  };
}

function post(authorDid: string, postId: string): FeedEnvelopePayload {
  return {
    type: 'feed_post',
    postId,
    authorDid,
    ts: Date.now(),
    data: { kind: 'post', text: 'привет' },
  } as unknown as FeedEnvelopePayload;
}

async function frameFrom(id: Identity, postId: string): Promise<Uint8Array> {
  const frame = await serializeFeedEnvelope(id.pair, post(id.did, postId));
  if (!frame) throw new Error('serializeFeedEnvelope вернул null');
  return frame;
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

/** Пересылка запускается без await — дать очереди микрозадач провернуться. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

const send = multiTransportRouter.send as unknown as jest.Mock;

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => {
  send.mockClear();
  mockContacts = [];
  mockBlocked.clear();
  mockSaved.length = 0;
});

describe('входящее: конверт заблокированного автора', () => {
  it('не сохраняется и дальше не идёт', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockBlocked.add(author.b64);
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'blk-drop'), 0), '');
    await settle();

    expect(mockSaved).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('проверка не пустая: незаблокированный автор и сохраняется, и расходится', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'blk-ok'), 0), '');
    await settle();

    expect(mockSaved).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('пересылка чужого: заблокированный сосед не адресат', () => {
  it('его пропускают, остальных — нет', async () => {
    const author = newIdentity();
    const banned = newIdentity();
    const stranger = newIdentity();
    mockBlocked.add(banned.b64);
    mockContacts = [{ peerPublicKey: banned.b64 }, { peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'blk-relay'), 0), '');
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(stranger.did);
  });
});

describe('исходящее: своя публикация заблокированному не адресуется', () => {
  it('рассылка обходит его стороной', async () => {
    const me = newIdentity();
    const banned = newIdentity();
    const stranger = newIdentity();
    mockBlocked.add(banned.b64);
    mockContacts = [{ peerPublicKey: banned.b64 }, { peerPublicKey: stranger.b64 }];

    const res = await broadcastFeedEnvelope(await frameFrom(me, 'blk-out'));

    expect(res.total).toBe(1);
    expect(res.successDids).toEqual([stranger.did]);
  });

  it('заблокированы все — рассылать некому', async () => {
    const me = newIdentity();
    const banned = newIdentity();
    mockBlocked.add(banned.b64);
    mockContacts = [{ peerPublicKey: banned.b64 }];

    const res = await broadcastFeedEnvelope(await frameFrom(me, 'blk-out-all'));

    expect(res).toEqual({ total: 0, success: 0, successDids: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('проверка не пустая: без блокировки адресуется каждому', async () => {
    const me = newIdentity();
    const a = newIdentity();
    const b = newIdentity();
    mockContacts = [{ peerPublicKey: a.b64 }, { peerPublicKey: b.b64 }];

    const res = await broadcastFeedEnvelope(await frameFrom(me, 'blk-out-none'));

    expect(res.total).toBe(2);
    expect(res.successDids.sort()).toEqual([a.did, b.did].sort());
  });
});
