/**
 * Обёртка ретрансляции ленты: счётчик прыжков и то, что его ограничивает.
 *
 * Кадр 0xF0 подписан автором, а обёртка 0xF1 вокруг него — нет, и подписать её
 * нечем: автор не знает пути, по которому пойдёт запись. Значит счётчик прыжков
 * `h` — единственное поле, которое посредник может переписать, и переписать его
 * он может в ноль. Само по себе это не чинится; на этом держится любая
 * mesh-раздача. Держат её три вещи, и здесь проверяются все три:
 *
 *  1) `h` зажимается в [0, FEED_RELAY_MAX_HOPS] и при упаковке, и при разборе —
 *     чужое число за пределы диапазона не выводит;
 *  2) при `h >= FEED_RELAY_MAX_HOPS` пересылки не происходит вовсе;
 *  3) повтор того же подписанного конверта отсекается до пересылки — так что
 *     обнулённый счётчик даёт посреднику ровно одну лишнюю рассылку, а не
 *     вечный круг.
 *
 * До v4.32.614 у слоя 0xF1 не было ни одного теста: разбор конверта проверялся
 * (feedEnvelopeRelaySender), а всё, что вокруг счётчика, — нет.
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
    async savePost(): Promise<void> { /* запись принята */ }
  },
}));

import { Buffer } from 'buffer';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { multiTransportRouter } from '../../transport/multiTransport';
import { receiveFeedEnvelope, setFeedProfileContext } from '../feedService';
import {
  serializeFeedEnvelope,
  wrapFeedRelay,
  unwrapFeedRelay,
  isFeedRelayWrapper,
  FEED_RELAY_MAX_HOPS,
  type FeedEnvelopePayload,
} from '../feedTransport';

/** Контакты, которых вернёт listContacts текущему тесту. */
let mockContacts: { peerPublicKey: string }[] = [];

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

/** Обёртка, собранная вручную: посредник кладёт в `h` что угодно. */
function forgeWrapper(inner: Uint8Array, h: unknown): Uint8Array {
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

describe('обёртка ретрансляции: счётчик прыжков', () => {
  it('оборачивается только подписанный кадр ленты', async () => {
    const me = newIdentity();
    const inner = await frameFrom(me, 'wrap-ok');
    expect(wrapFeedRelay(inner, 1)).not.toBeNull();
    expect(wrapFeedRelay(new Uint8Array([0x01, 0x02]), 1)).toBeNull();
    expect(wrapFeedRelay(new Uint8Array(0), 1)).toBeNull();
  });

  it('кадр внутри обёртки доходит побайтово', async () => {
    const me = newIdentity();
    const inner = await frameFrom(me, 'wrap-roundtrip');
    const wrapped = wrapFeedRelay(inner, 2);
    expect(wrapped).not.toBeNull();
    expect(isFeedRelayWrapper(wrapped as Uint8Array)).toBe(true);
    const out = unwrapFeedRelay(wrapped as Uint8Array);
    expect(out?.hops).toBe(2);
    expect(Array.from(out?.inner ?? [])).toEqual(Array.from(inner));
  });

  it('счётчик зажимается при упаковке', async () => {
    const me = newIdentity();
    const inner = await frameFrom(me, 'wrap-clamp');
    expect(unwrapFeedRelay(wrapFeedRelay(inner, 999) as Uint8Array)?.hops).toBe(FEED_RELAY_MAX_HOPS);
    expect(unwrapFeedRelay(wrapFeedRelay(inner, -7) as Uint8Array)?.hops).toBe(0);
  });

  it('счётчик зажимается и при разборе — обёртку писал не мы', async () => {
    // Единственное, что посредник может подставить: обёртка не подписана.
    const me = newIdentity();
    const inner = await frameFrom(me, 'wrap-forge');
    expect(unwrapFeedRelay(forgeWrapper(inner, 999))?.hops).toBe(FEED_RELAY_MAX_HOPS);
    expect(unwrapFeedRelay(forgeWrapper(inner, -5))?.hops).toBe(0);
    expect(unwrapFeedRelay(forgeWrapper(inner, 'нет'))?.hops).toBe(0);
    expect(unwrapFeedRelay(forgeWrapper(inner, Number.NaN))?.hops).toBe(0);
    expect(unwrapFeedRelay(forgeWrapper(inner, Number.POSITIVE_INFINITY))?.hops).toBe(0);
    expect(unwrapFeedRelay(forgeWrapper(inner, null))?.hops).toBe(0);
  });

  it('внутри обёртки обязан лежать кадр ленты, а не что угодно', () => {
    expect(unwrapFeedRelay(forgeWrapper(new Uint8Array([0x01, 0x02, 0x03]), 1))).toBeNull();
    expect(unwrapFeedRelay(new Uint8Array([0xf1]))).toBeNull();
    expect(unwrapFeedRelay(new Uint8Array([0xf0, 0x7b, 0x7d]))).toBeNull();
  });
});

describe('обёртка ретрансляции: кому и когда пересылается', () => {
  // Профиль нужен по-настоящему: без хранилища разбор конверта падает, а на
  // осечке отметка «видели» снимается намеренно (см. feedSeenForget) — тогда
  // проверить подавление круга было бы нечем.
  beforeAll(async () => { await setFeedProfileContext(1); });
  beforeEach(() => {
    send.mockClear();
    mockContacts = [];
  });

  it('пересылается соседям, кроме автора и того, от кого пришло', async () => {
    const author = newIdentity();
    const neighbour = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: author.b64 }, { peerPublicKey: neighbour.b64 }, { peerPublicKey: stranger.b64 }];

    const inner = await frameFrom(author, 'relay-fanout');
    await receiveFeedEnvelope(forgeWrapper(inner, 0), neighbour.did);
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(stranger.did);
  });

  it('пересылаемая обёртка несёт счётчик на единицу больше', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    const inner = await frameFrom(author, 'relay-increment');
    await receiveFeedEnvelope(forgeWrapper(inner, 1), '');
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(unwrapFeedRelay(send.mock.calls[0][0] as Uint8Array)?.hops).toBe(2);
  });

  it('на пределе прыжков пересылки нет', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    const inner = await frameFrom(author, 'relay-limit');
    await receiveFeedEnvelope(forgeWrapper(inner, FEED_RELAY_MAX_HOPS), '');
    await settle();

    expect(send).not.toHaveBeenCalled();
  });

  it('обнулённый счётчик даёт одну лишнюю рассылку, а не круг', async () => {
    // Тот же подписанный конверт приходит второй раз с h=0. Подпись верна —
    // отбраковать по ней нечего; останавливает его список уже виденного.
    const author = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    const inner = await frameFrom(author, 'relay-loop');
    await receiveFeedEnvelope(forgeWrapper(inner, 2), '');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);

    await receiveFeedEnvelope(forgeWrapper(inner, 0), '');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('испорченная обёртка не пересылается вовсе', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    const inner = await frameFrom(author, 'relay-broken');
    const wrapper = forgeWrapper(inner, 0);
    wrapper[wrapper.length - 4] ^= 0xff;
    await receiveFeedEnvelope(wrapper, '');
    await settle();

    expect(send).not.toHaveBeenCalled();
  });
});
