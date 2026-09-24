/**
 * Непрочитанный блок-лист больше не выдаёт заблокированному пропуск
 * (v4.32.795).
 *
 * Дефект. У `isBlocked` нет ответа «не знаю»: не подняв список с диска, он
 * отвечает `blocked.has(...)` по пустому множеству — то есть «не
 * заблокирован» на кого угодно. Отличать одно от другого научились ещё в
 * v4.32.635 (`blockedListReadable`), но спрашивал об этом только экран
 * «Заблокированные»; приём конвертов спрашивал по-прежнему `isBlocked`.
 * Заход `whenReady` даёт чтению второй шанс — а не удался и он, дальше шла
 * беззащитная дорога.
 *
 * Цена. Запрет — единственное, чем человек может закрыться от того, кто ему
 * досаждает; окно, в котором он не действует, — это ровно окно, в котором
 * досаждать снова можно. И оно не мгновение: пока ключ шифрования данных не
 * поднят (переключение профиля, холодный старт, занятая база), список не
 * читается, а конверты уже разбираются. В личке за этим окном стоит вся
 * диспетчеризация служебных конвертов (v4.32.491), в группах — заведение
 * новой группы по приглашению (v4.32.617).
 *
 * Правка. Спрашиваем отдельно, прочитан ли список, и при «нет» не разбираем
 * конверт: `'deferred'`. Relay держит накопленное тридцать суток, координатор
 * интернета перезапрашивает кадр ещё раз, и к тому разу база, скорее всего,
 * откроется. Цена отказа названа честно: если чтение сорвётся и в повторе,
 * координатор кадр отпустит. Но три подряд неудачных чтения означают, что не
 * работает хранилище целиком, — а молча пускать заблокированного всё это
 * время нельзя.
 *
 * Звонки к правке не отнесены намеренно: отложить входящий звонок нечем,
 * «сейчас не смогли» там означает пропущенный, и отказ был бы не отсрочкой,
 * а глухотой на всё время недоступности базы.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Поднялся ли блок-лист с диска на этом прогоне. */
let mockReadable = true;
/** Кого список запрещает, если он прочитан. */
const mockBlocked = new Set<string>();
/** Кого мы уже знаем: пустой справочник делает отправителя незнакомцем. */
let mockContacts: Array<{ peerPublicKey: string }> = [];

/** Строки, дошедшие до записи. */
const mockSaved: Record<string, unknown>[] = [];
/** Заведённые неявные контакты. */
let mockImplicit = 0;
const mockEnvelope: { current: unknown } = { current: null };

jest.mock('../../storage/local', () => ({
  chatMessageExists: async () => false,
  deleteChatMessage: async () => true,
  deleteChatMessageChecked: async () => 'deleted',
  getChatMessageAuthor: async () => null,
  getChatMessageTexts: async () => new Map(),
  listChatMessages: async () => [],
  upsertChatMessage: async () => {},
  saveChatMessage: async (r: Record<string, unknown>) => { mockSaved.push(r); },
  saveChatMessageChecked: async (r: Record<string, unknown>) => { mockSaved.push(r); return 'inserted'; },
  saveChatMessageWithTouch: async (r: Record<string, unknown>) => { mockSaved.push(r); return 'inserted'; },
  updateChatMessageStatus: async () => {},
  updateChatMessageText: async () => true,
  updateChatMessageTextChecked: async () => 'updated',
  touchConversation: async () => {},
}));

jest.mock('../messageStore', () => ({
  IPFSMessageStore: class {
    getMessage(): Promise<unknown> { return Promise.resolve(null); }
    publishToSelfInbox(): Promise<null> { return Promise.resolve(null); }
    subscribeToSelfInbox(): Promise<null> { return Promise.resolve(null); }
    subscribeToContact(): Promise<null> { return Promise.resolve(null); }
  },
  parseEnvelopeFromWire: () => mockEnvelope.current,
  serializeEnvelopeToBytes: () => new Uint8Array(),
}));

// Шифрование здесь не предмет: проверяется судьба уже расшифрованного конверта.
const mockSym = new Uint8Array(32).fill(7);
jest.mock('../contacts', () => ({
  getSymmetricKeyForPeer: async () => mockSym,
  listContactsFor: async () => mockContacts,
  listContactsReadFor: async () => mockContacts,
  listContacts: async () => mockContacts,
  ensureImplicitContact: async () => { mockImplicit += 1; return true; },
  deriveSymmetricKeyForStranger: () => mockSym,
  clearSymKeyCache: () => {},
}));

jest.mock('../../crypto/encrypt', () => ({
  encryptSymmetric: (_k: Uint8Array, pt: Uint8Array) => pt,
  decryptSymmetric: (_k: Uint8Array, ct: Uint8Array) => ct,
}));

jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: async () => ({ ok: false }) },
}));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../groupMessaging', () => ({
  handleIncomingGroupEnvelope: async () => 'consumed',
  handleIncomingGroupReadReceipt: async () => 'consumed',
  handleIncomingGroupJoinRequest: async () => 'consumed',
  handleIncomingGroupControl: async () => 'consumed',
  GROUP_READ_RECEIPT_PREFIX: '\x0egrr:',
  GROUP_JOIN_REQUEST_PREFIX: '\x0egrj:',
  GROUP_CTL_PREFIX: '\x0egctl:',
}));
jest.mock('../messageSync', () => ({
  dmPairKey: (a: string, b: string) => [a, b].sort().join('|'),
  syncDmHistoryFromProfile: async () => {},
}));
jest.mock('../../identity/profile', () => ({
  getLocalConversationTips: async () => ({}),
  republishProfileFromKv: async () => {},
  setLocalConversationTip: async () => {},
}));
jest.mock('../../identity/ownerProfile', () => ({ ownerPidByDid: async () => 1 }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный' }) },
}));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async () => {},
    // Настоящая пара: «прочитан ли список» и «есть ли в нём этот человек».
    // Второе без первого ничего не значит — в том и была дыра.
    blockedListReadable: () => mockReadable,
    isBlocked: (p: string) => (mockReadable ? mockBlocked.has(p) : false),
  },
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async () => null,
  readReceiptsAllowedFor: async () => false,
}));
jest.mock('../presenceService', () => ({ recordPeerActivityFor: () => {} }));
jest.mock('../../storage/localEncryption', () => ({ clearDekMemory: () => {} }));
jest.mock('../../sync/cachePolicy', () => ({
  checkOnlineWrite: async () => ({ ok: true }),
  requireOnlineWrite: async () => {},
}));
let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `u${++mockUuid}` }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { publicKeyToB64 } from '../../crypto/pubKeyFormat';
import { publicKeyToDidKey } from '../../identity/did';
import { MessagingService, subscribeInAppNotifications } from '../messaging';

const mockLog = (jest.requireMock('../../logger') as {
  log: { warn: jest.Mock; info: jest.Mock };
}).log;

const ME = new Uint8Array(32).fill(1);
const PEER = new Uint8Array(32).fill(2);
const myPair = { publicKey: ME, secretKey: new Uint8Array(64).fill(1) };
const MY_DID = publicKeyToDidKey(ME);
const PEER_DID = publicKeyToDidKey(PEER);
const PEER_B64 = publicKeyToB64(PEER);

/** Всплывающие плашки внутри приложения за один прогон теста. */
const banners: unknown[] = [];
let unsubscribe: (() => void) | null = null;

let seq = 0;
/** Положить в приёмник личный конверт от собеседника и отдать его службе. */
async function deliver(text = 'опять я'): Promise<string> {
  const ts = Date.now();
  mockEnvelope.current = {
    messageId: `m${++seq}`,
    senderDid: PEER_DID,
    recipientDid: MY_DID,
    encryptedContent: new TextEncoder().encode(JSON.stringify({ text, _ts: ts })),
    timestamp: ts,
  };
  return new MessagingService(myPair).receiveDirectLanEnvelope(new Uint8Array([1]), PEER_DID);
}

/** Собеседник уже в справочнике: неявную строку заводить не надо. */
function makeKnown(): void {
  mockContacts = [{ peerPublicKey: PEER_B64 }];
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const readSrc = (...p: string[]): string =>
  codeOnly(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));

beforeEach(() => {
  mockReadable = true;
  mockBlocked.clear();
  mockContacts = [];
  mockImplicit = 0;
  mockSaved.length = 0;
  banners.length = 0;
  unsubscribe = subscribeInAppNotifications((n) => { banners.push(n); });
  jest.clearAllMocks();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe('список не прочитан — конверт не разбирается', () => {
  it('знакомый собеседник: кадр откладывается, а не ложится в переписку', async () => {
    makeKnown();
    mockReadable = false;
    expect(await deliver()).toBe('deferred');
    expect(mockSaved).toEqual([]);
    expect(banners).toEqual([]);
  });

  it('незнакомец: строка контакта тоже не заводится', async () => {
    mockReadable = false;
    expect(await deliver()).toBe('deferred');
    expect(mockImplicit).toBe(0);
    expect(mockSaved).toEqual([]);
  });

  it('отказ назван в журнале своим именем, а не молчанием', async () => {
    makeKnown();
    mockReadable = false;
    await deliver();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'dm_block_list_unreadable_defer',
      expect.any(Object),
    );
  });

  it('у незнакомца своя запись: ворота разные, и видно, какие сработали', async () => {
    mockReadable = false;
    await deliver();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'lan_block_list_unreadable_defer',
      expect.any(Object),
    );
  });

  it('база открылась — тот же кадр проходит и сохраняется', async () => {
    makeKnown();
    mockReadable = false;
    expect(await deliver()).toBe('deferred');

    mockReadable = true;
    expect(await deliver()).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
  });

  it('база открылась, а человек в списке — кадр выбрасывается, как и должен', async () => {
    makeKnown();
    mockReadable = false;
    expect(await deliver()).toBe('deferred');

    mockReadable = true;
    mockBlocked.add(PEER_B64);
    expect(await deliver()).toBe('consumed');
    expect(mockSaved).toEqual([]);
  });
});

describe('исключение для групп непрочитанным списком не отменяется', () => {
  it('конверт, адресованный группе, идёт дальше: его судьбу решают роли в ней', async () => {
    makeKnown();
    mockReadable = false;
    // Тот же префикс, что и в blockPolicy: `survivesBlock` про него знает.
    expect(await deliver('\x02grp:{"a":1}')).toBe('consumed');
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      'dm_block_list_unreadable_defer',
      expect.anything(),
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная работа не задета', () => {
  it('прочитанный список и чистый собеседник — сообщение на месте', async () => {
    makeKnown();
    expect(await deliver('привет')).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ direction: 'in', text: 'привет' });
    expect(banners).toHaveLength(1);
  });

  it('незнакомец при прочитанном списке заводит строку контакта, как прежде', async () => {
    expect(await deliver('здравствуйте')).toBe('consumed');
    expect(mockImplicit).toBe(1);
    expect(mockSaved).toHaveLength(1);
  });

  it('заблокированный при прочитанном списке выбрасывается молча', async () => {
    makeKnown();
    mockBlocked.add(PEER_B64);
    expect(await deliver()).toBe('consumed');
    expect(mockSaved).toEqual([]);
    expect(mockLog.info).toHaveBeenCalledWith('dm_blocked_drop', expect.any(Object));
  });

  it('три состояния списка дают три разных исхода, а не два', async () => {
    makeKnown();
    const verdicts: Array<[string, number]> = [];
    // прочитан и чист
    verdicts.push([await deliver(), mockSaved.length]);
    // прочитан и запрещает
    mockSaved.length = 0;
    mockBlocked.add(PEER_B64);
    verdicts.push([await deliver(), mockSaved.length]);
    // не прочитан
    mockSaved.length = 0;
    mockReadable = false;
    verdicts.push([await deliver(), mockSaved.length]);
    expect(verdicts).toEqual([['consumed', 1], ['consumed', 0], ['deferred', 0]]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('у isBlocked нет ответа «не знаю»: пустое множество и есть «не заблокирован»', () => {
    const body = codeOnly(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'security', 'rateLimiter.ts'),
        'utf8',
      ),
    );
    expect(body).toContain('return this.blocked.has(peerPubKeyB64);');
    // Ответ про сам список существует отдельно — им и пользуемся.
    expect(body).toContain('return !this.loadFailed;');
  });

});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('вопрос про прочитанность стоит ПЕРЕД вопросом про человека', () => {
    const body = readSrc('messaging.ts');
    const readable = body.lastIndexOf('rateLimiter.blockedListReadable()');
    const blocked = body.lastIndexOf('rateLimiter.isBlocked(peerPubKeyB64)');
    expect(readable).toBeGreaterThanOrEqual(0);
    expect(blocked).toBeGreaterThan(readable);
  });

  it('оба входа в личку закрыты: и заведение контакта, и разбор конверта', () => {
    const body = readSrc('messaging.ts');
    expect(body.split('rateLimiter.blockedListReadable()').length - 1).toBe(2);
    expect(body).toContain("return 'deferred';");
  });

  it('приглашение в группу закрыто той же парой вопросов', () => {
    const body = readSrc('groupMessaging.ts');
    const readable = body.indexOf('rateLimiter.blockedListReadable()');
    const blocked = body.indexOf('rateLimiter.isBlocked(senderPubB64)');
    expect(readable).toBeGreaterThanOrEqual(0);
    expect(blocked).toBeGreaterThan(readable);
    expect(body.slice(readable, blocked)).toContain("return 'deferred';");
  });

});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ, продолжение', () => {
  it('отложенный кадр перезапрашивается: relay держит его тридцать суток', () => {
    expect(readSrc('messaging.ts')).toContain('const ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;');
    expect(readSrc('..', 'transport', 'retentionWindow.ts')).toContain(
      'export const RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;',
    );
  });
});
