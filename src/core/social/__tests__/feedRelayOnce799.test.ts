/**
 * Осечка разбора больше не рассылает конверт ленты соседям второй раз (v4.32.799).
 *
 * Дефект. Ретрансляция стоит ВЫШЕ разбора — и правильно: моя нода передаёт
 * чужую запись дальше независимо от того, сумела ли положить её себе. Но
 * отметка «видели» снимается на каждой осечке (v4.32.614, иначе повтор
 * выбрасывался бы как дубль и запись терялась навсегда), а повтор идёт с
 * самого начала — то есть снова доходит до ретрансляции.
 *
 * Цена. Одно занятое мгновение у базы — и весь список контактов получает ту же
 * запись второй раз. Соседи её отбросят по своей отметке «видели»: уходит
 * чистый холостой трафик, и уходит ровно тогда, когда устройству и так плохо
 * (база занята). На каждом узле, до которого дошёл сбой, это умножается на
 * размер списка контактов — до 64 отправок за повтор.
 *
 * Правка. Отметок две. «Уже переслали» осечкой разбора не снимается:
 * пересылать второй раз незачем в любом случае — у соседей конверт уже есть.
 * Чистятся обе вместе при смене профиля.
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
    async savePost(): Promise<void> {
      // Занятая база: ровно та осечка, из-за которой снимается отметка
      // «видели» и разбор отвечает `deferred`.
      if (mockSaveFails) throw new Error('база занята');
    }
  },
}));

import { Buffer } from 'buffer';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { multiTransportRouter } from '../../transport/multiTransport';
import { receiveFeedEnvelope, rebindFeedToProfile, setFeedProfileContext } from '../feedService';
import { serializeFeedEnvelope, type FeedEnvelopePayload } from '../feedTransport';

/** Контакты, которых вернёт listContacts текущему тесту. */
let mockContacts: { peerPublicKey: string }[] = [];
/** Отвечает ли хранилище отказом на записи публикации. */
let mockSaveFails = false;

type Identity = { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string; b64: string };

function newIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    pair: { secretKey, publicKey },
    did: publicKeyToDidKey(publicKey),
    b64: Buffer.from(publicKey).toString('base64'),
  };
}

/** Подписанный автором кадр публикации. */
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

/** Пересылка идёт без await — дать очереди микрозадач опустеть (см. feedRelayHops). */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((r) => setImmediate(r));
}

const send = multiTransportRouter.send as unknown as jest.Mock;

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SRC = (): string => readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8');

beforeAll(async () => {
  await setFeedProfileContext(1);
});

beforeEach(() => {
  send.mockClear();
  mockContacts = [];
  mockSaveFails = false;
});

describe('осечка разбора не рассылает конверт заново', () => {
  it('занятая база: конверт отложен, но соседям он ушёл ровно один раз', async () => {
    const author = newIdentity();
    const a = newIdentity();
    const b = newIdentity();
    mockContacts = [{ peerPublicKey: a.b64 }, { peerPublicKey: b.b64 }];

    const inner = await frameFrom(author, 'relay-once-busy');
    mockSaveFails = true;
    expect(await receiveFeedEnvelope(wrapper(inner, 0), '')).toBe('deferred');
    await settle();
    expect(send).toHaveBeenCalledTimes(2); // по одному каждому соседу

    // Повтор того же кадра: запись наконец проходит, а вот пересылки второй
    // раз быть не должно — у соседей он уже есть.
    mockSaveFails = false;
    expect(await receiveFeedEnvelope(wrapper(inner, 0), '')).toBe('consumed');
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('осечка подряд не множит рассылку', async () => {
    const author = newIdentity();
    const a = newIdentity();
    mockContacts = [{ peerPublicKey: a.b64 }];

    const inner = await frameFrom(author, 'relay-once-twice');
    mockSaveFails = true;
    for (let i = 0; i < 4; i += 1) {
      expect(await receiveFeedEnvelope(wrapper(inner, 0), '')).toBe('deferred');
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: пересылка не выключена вообще', () => {
  it('удачный разбор пересылает конверт как и раньше', async () => {
    const author = newIdentity();
    const a = newIdentity();
    mockContacts = [{ peerPublicKey: a.b64 }];

    const inner = await frameFrom(author, 'relay-ok');
    expect(await receiveFeedEnvelope(wrapper(inner, 0), '')).toBe('consumed');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('другой конверт пересылается своим чередом', async () => {
    const author = newIdentity();
    const a = newIdentity();
    mockContacts = [{ peerPublicKey: a.b64 }];

    mockSaveFails = true;
    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'relay-first'), 0), '');
    await settle();
    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'relay-second'), 0), '');
    await settle();

    // Отметка «уже переслали» — на конверт, а не на автора и не на всё подряд.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('смена профиля отметку «уже переслали» забывает', async () => {
    const author = newIdentity();
    const a = newIdentity();
    mockContacts = [{ peerPublicKey: a.b64 }];

    const inner = await frameFrom(author, 'relay-rebind');
    await receiveFeedEnvelope(wrapper(inner, 0), '');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);

    // Чужая отметка иначе молча запретила бы пересылку в новом аккаунте: у его
    // контактов этого конверта нет.
    await rebindFeedToProfile(2);
    await receiveFeedEnvelope(wrapper(inner, 0), '');
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    await rebindFeedToProfile(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отметка «видели» на осечке снимается — и разбор начинается сначала', () => {
    const body = codeOnly(SRC());
    expect(body).toContain('function feedSeenForget(key: string): void {');
    expect(body).toContain('  feedSeenKeys.delete(key);');
    // Все четыре осечки разбора снимают её, то есть повтор доходит до
    // ретрансляции заново.
    expect(body.split('feedSeenForget(dedupKey);').length - 1).toBe(4);
  });

  it('ретрансляция стоит выше разбора — и остаётся выше', () => {
    const body = codeOnly(SRC());
    const relay = body.indexOf('void feedGossipRelay(innerFrame, incomingHops + 1');
    const apply = body.indexOf('const applied = await applyFeedEnvelope(payload, s, envelopePid);');
    expect(relay).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(relay);
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('отметка «уже переслали» отдельная и осечкой не снимается', () => {
    const body = codeOnly(SRC());
    expect(body).toContain('const feedRelayedKeys = new Set<string>();');
    expect(body).toContain('function feedRelayMarkOrHas(key: string): boolean {');
    // Снимать её негде: удаление одного ключа в модуле не встречается вовсе.
    expect(body).not.toContain('feedRelayedKeys.delete(dedupKey)');
  });

  it('проверка стоит последней в условии пересылки', () => {
    const body = codeOnly(SRC());
    const at = body.indexOf("payload.type !== 'feed_view' &&");
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 120)).toContain('!feedRelayMarkOrHas(dedupKey)');
  });

  it('обе отметки чистятся вместе при смене профиля', () => {
    const body = codeOnly(SRC());
    expect(body.split('feedRelayedKeys.clear();').length - 1).toBe(2);
    expect(body.split('feedSeenKeys.clear();').length - 1).toBe(2);
  });
});
