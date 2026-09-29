/**
 * Непрочитанные списки заглушения и запрета на входе ленты (v4.32.1043).
 *
 * ДЕФЕКТ. Приём чужого конверта спрашивал оба списка двузначно. `isAuthorMuted`
 * сводится к `(await currentMuted()) ?? new Set()`, а `rateLimiter.isBlocked`
 * отвечает по множеству в памяти, которое при сорвавшемся чтении остаётся
 * пустым навсегда (`loadFailed`, см. докблок там же). То есть отказ SQLite —
 * занятая соседним запросом база, ещё не поднятый ключ при переключении
 * профиля — выглядел как «никого не заглушали и никого не запрещали».
 *
 * ЦЕНА. Показ чужой публикации обратим: списки поднимутся, лента перечитается.
 * Необратима вторая половина приёма — `feedGossipRelay` уносит тот же конверт
 * до 64 контактам от моего имени. Отозвать разосланное нечем. Получалось, что
 * заминка базы заставляла мою ноду усиливать того, кого я сам и запретил.
 *
 * ПРАВКА. Оба чтения стали исходом: `isAuthorMutedTry` возвращает `null`, а
 * `authorBlockState` — `'unknown'`. Непрочитанный список сохранение и показ не
 * трогает (терять публикацию на таком основании нечем: молча потерянная
 * неотличима от неприсланной), но снимает пересылку и пишет предупреждение.
 *
 * ГРАНИЦЫ. Читаемые и чистые списки пересылку не трогают; заглушённый и
 * запрещённый автор по-прежнему отбраковываются целиком, а не только в
 * пересылке.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => true) },
}));
jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => mockContacts),
  listContactsRead: jest.fn(async () => mockContacts),
  listContactsReadDetailed: jest.fn(async () => ({ contacts: mockContacts, missing: 0 })),
}));
jest.mock('../mutedAuthors', () => ({
  // Двузначная форма тут ради старого кода: до правки приём звал именно её.
  isAuthorMuted: jest.fn(async (did: string) => mockMuted.has(did)),
  isAuthorMutedTry: jest.fn(async (did: string) =>
    mockMuteUnreadable ? null : { muted: mockMuted.has(did) }),
}));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async () => {},
    blockedListReadable: () => mockBlockReadable,
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
import { readFileSync } from 'fs';
import { join } from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { multiTransportRouter } from '../../transport/multiTransport';
import { receiveFeedEnvelope, setFeedProfileContext } from '../feedService';
import { serializeFeedEnvelope, type FeedEnvelopePayload } from '../feedTransport';

let mockContacts: { peerPublicKey: string }[] | null = [];
const mockBlocked = new Set<string>();
const mockMuted = new Set<string>();
let mockBlockReadable = true;
let mockMuteUnreadable = false;

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
  mockMuted.clear();
  mockBlockReadable = true;
  mockMuteUnreadable = false;
  mockSaved.length = 0;
});

describe('непрочитанный список запретов', () => {
  it('публикация сохраняется, но дальше моих контактов не уходит', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockBlockReadable = false;
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'gate-blk-unread'), 0), '');
    await settle();

    expect(mockSaved).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: тот же автор при читаемом списке и сохраняется, и расходится', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'gate-blk-read'), 0), '');
    await settle();

    expect(mockSaved).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('непрочитанный список заглушённых', () => {
  it('публикация сохраняется, но дальше моих контактов не уходит', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockMuteUnreadable = true;
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'gate-mute-unread'), 0), '');
    await settle();

    expect(mockSaved).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: при читаемом списке тот же автор расходится', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'gate-mute-read'), 0), '');
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('ГРАНИЦА: прочитанный список решает по-прежнему', () => {
  it('заглушённый автор отбракован целиком, а не только в пересылке', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockMuted.add(author.did);
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'gate-muted'), 0), '');
    await settle();

    expect(mockSaved).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('запрещённый автор отбракован целиком', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockBlocked.add(author.b64);
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'gate-blocked'), 0), '');
    await settle();

    expect(mockSaved).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('запрет сильнее непрочитанного заглушения: конверт не сохраняется', async () => {
    const author = newIdentity();
    const stranger = newIdentity();
    mockMuteUnreadable = true;
    mockBlocked.add(author.b64);
    mockContacts = [{ peerPublicKey: stranger.b64 }];

    await receiveFeedEnvelope(wrapper(await frameFrom(author, 'gate-both'), 0), '');
    await settle();

    expect(mockSaved).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SERVICE = codeOnly(
  readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8'),
);
const MUTED = codeOnly(
  readFileSync(join(__dirname, '..', 'mutedAuthors.ts'), 'utf8'),
);

describe('форма исходников', () => {
  it('ЗАКРЕПКА: приём спрашивает заглушение исходом чтения', () => {
    expect(SERVICE).toContain('await isAuthorMutedTry(payload.authorDid)');
  });

  it('ЗАКРЕПКА: состояние запрета трёхзначное и спрашивает читаемость списка', () => {
    expect(SERVICE).toContain("type AuthorGateState = 'blocked' | 'allowed' | 'unknown'");
    expect(SERVICE).toContain('rateLimiter.blockedListReadable()');
  });

  it('ЗАКРЕПКА: пересылка снимается при непрочитанном списке', () => {
    expect(SERVICE).toContain('!gateUnknown &&');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: короткая форма в mutedAuthors осталась и по-прежнему плоская', () => {
    // Её зовут показ и меню — им разницы не нужно. Если она исчезнет,
    // проверять станет нечего, но и повод у этого теста отпадёт.
    expect(MUTED).toContain('export async function isAuthorMuted');
    expect(MUTED).toContain('export async function isAuthorMutedTry');
  });

  it('ГРАНИЦА: непрочитанный список сохранение не отменяет', () => {
    // Отбраковка стоит выше и только по прочитанному ответу: у `gateUnknown`
    // своего `return` нет — он влияет ровно на условие пересылки.
    const at = SERVICE.indexOf('const gateUnknown =');
    expect(at).toBeGreaterThan(0);
    const branch = SERVICE.slice(at, SERVICE.indexOf('opts?.gossip !== false', at));
    expect(branch).not.toContain("return 'consumed'");
  });
});
