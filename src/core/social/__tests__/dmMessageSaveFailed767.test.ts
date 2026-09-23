/**
 * Занятая база больше не съедает входящее личное сообщение (v4.32.767).
 *
 * `saveChatMessage` отвечала `void`: и удачная запись, и любой отказ SQLite —
 * секунда занятой базы, неподнявшаяся блокировка `beginImmediate`, кончившееся
 * место, неоткрывшийся ключ шифрования данных — выходили из неё одинаково
 * молча. Приёмник личного конверта после такой записи отвечал `'consumed'`.
 *
 * Это слово двигает у ретранслятора метку «докуда прочитано», а накопленное он
 * отдаёт только по ней. Второго конверта не будет, строки не появилось нигде —
 * сообщение пропадало навсегда. Причём не тихо: `alreadyStored` считался
 * отдельным чтением ДО записи, оно отвечало «строки нет», и дальше шли превью
 * в списке чатов, единица непрочитанного и всплывающая плашка — от сообщения,
 * которого в переписке нет.
 *
 * Групповой брат этой записи получил три исхода в v4.32.765
 * (`insertGroupMessageChecked` → `'deferred'` на отказе). Здесь то же самое,
 * и заодно отпадает чтение-до-записи: `INSERT OR IGNORE` сам говорит, изменил
 * он строку или нет, — ответ точный и на одно чтение дешевле.
 *
 * Настоящий повтор обязан остаться `'consumed'`: одно и то же сообщение штатно
 * доезжает и по локальной сети, и через ретранслятор, и следом за push;
 * откладывать его значило бы запереть метку чтения навсегда.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Что ответит запись строки: как настоящая saveChatMessageChecked. */
let mockWrite: 'inserted' | 'duplicate' | 'failed' = 'inserted';
/** Строки, дошедшие до записи. */
const mockSaved: Record<string, unknown>[] = [];
/** Что легло в список чатов: превью и счётчик непрочитанного. */
const mockTouched: unknown[][] = [];
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
  saveChatMessageChecked: async (r: Record<string, unknown>) => {
    if (mockWrite === 'inserted') mockSaved.push(r);
    return mockWrite;
  },
  // v4.32.776: входящее пишется вместе со следом в списке чатов, одной
  // операцией: отказ следа больше не терялся между двумя записями.
  saveChatMessageWithTouch: async (r: Record<string, unknown>, touch: unknown) => {
    if (mockWrite === 'inserted') { mockSaved.push(r); mockTouched.push([touch]); }
    return mockWrite;
  },
  updateChatMessageStatus: async () => {},
  updateChatMessageText: async () => true,
  updateChatMessageTextChecked: async () => 'updated',
  touchConversation: async (...a: unknown[]) => { mockTouched.push(a); },
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

// Шифрование здесь не проверяется: проверяется судьба уже расшифрованного
// конверта, чью строку не удалось записать.
const mockSym = new Uint8Array(32).fill(7);
jest.mock('../contacts', () => ({
  getSymmetricKeyForPeer: async () => mockSym,
  listContactsFor: async () => [],
  listContactsReadFor: async () => [],
  listContacts: async () => [],
  ensureImplicitContact: async () => true,
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
  GROUP_READ_RECEIPT_PREFIX: 'grr:',
  GROUP_JOIN_REQUEST_PREFIX: 'grj:',
  GROUP_CTL_PREFIX: 'grc:',
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
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
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
// uuid — чистый ESM, jest его не разбирает; в проверке он не участвует.
let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `u${++mockUuid}` }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { publicKeyToDidKey } from '../../identity/did';
import { MessagingService, subscribeInAppNotifications } from '../messaging';

const mockLog = (jest.requireMock('../../logger') as {
  log: { warn: jest.Mock; debug: jest.Mock; info: jest.Mock };
}).log;

// Ключи здесь не подписывают и не шифруют — нужны лишь различимые 32 байта,
// из которых выводится did:key.
const ME = new Uint8Array(32).fill(1);
const PEER = new Uint8Array(32).fill(2);
const myPair = { publicKey: ME, secretKey: new Uint8Array(64).fill(1) };
const MY_DID = publicKeyToDidKey(ME);
const PEER_DID = publicKeyToDidKey(PEER);

/** Всплывающие плашки внутри приложения за один прогон теста. */
const banners: unknown[] = [];
let unsubscribe: (() => void) | null = null;

let seq = 0;
/** Положить в приёмник личный конверт от собеседника и отдать его службе. */
async function deliver(text = 'встречаемся в семь'): Promise<string> {
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

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const MESSAGING = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8'));
const LOCAL = codeOnly(
  fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8'),
);

beforeEach(() => {
  mockWrite = 'inserted';
  mockSaved.length = 0;
  mockTouched.length = 0;
  banners.length = 0;
  unsubscribe = subscribeInAppNotifications((n) => { banners.push(n); });
  jest.clearAllMocks();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe('запись личного сообщения не удалась', () => {
  it('кадр откладывается, а не съедается', async () => {
    mockWrite = 'failed';
    expect(await deliver()).toBe('deferred');
  });

  it('отказ записан в журнал как отказ', async () => {
    mockWrite = 'failed';
    await deliver();
    expect(mockLog.warn).toHaveBeenCalledWith('dm_save_failed_defer', expect.any(Object));
    expect(mockLog.info).not.toHaveBeenCalledWith('dm_incoming_saved', expect.anything());
  });

  it('несостоявшаяся запись не двигает список чатов и не показывает плашку', async () => {
    mockWrite = 'failed';
    await deliver();
    expect(mockTouched).toEqual([]);
    expect(banners).toEqual([]);
  });
});

describe('настоящий повтор конверта', () => {
  it('остаётся разобранным: откладывать его — запереть метку чтения навсегда', async () => {
    mockWrite = 'duplicate';
    expect(await deliver()).toBe('consumed');
  });

  it('и по-прежнему не поднимает счётчик со вчерашним текстом', async () => {
    mockWrite = 'duplicate';
    await deliver();
    expect(mockTouched).toEqual([]);
    expect(banners).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удачная запись идёт прежней дорогой', () => {
  it('сообщение ложится в базу, поднимает список чатов и показывает плашку', async () => {
    expect(await deliver()).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ direction: 'in', text: 'встречаемся в семь' });
    expect(mockTouched).toHaveLength(1);
    expect(banners).toHaveLength(1);
    expect(mockLog.info).toHaveBeenCalledWith('dm_incoming_saved', expect.any(Object));
  });

  it('три разных исхода дают три разных ответа, а не два', async () => {
    const verdicts: string[] = [];
    for (const w of ['inserted', 'duplicate', 'failed'] as const) {
      mockWrite = w;
      verdicts.push(await deliver());
    }
    expect(verdicts).toEqual(['consumed', 'consumed', 'deferred']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('различающая форма записи отвечает словом, а не молчанием', () => {
    expect(LOCAL).toContain('export type ChatMessageWrite =');
    expect(LOCAL).toContain(
      'export async function saveChatMessageChecked(row: ChatMessageRow): Promise<ChatMessageWrite> {',
    );
    // Оба исхода отказа названы своими именами в самой записи.
    expect(LOCAL).toContain("return changed > 0 ? 'inserted' : 'duplicate';");
    expect(LOCAL).toContain("return 'failed';");
  });

  it('сплющивающая форма осталась — и осталась ровно обёрткой', () => {
    const a = LOCAL.indexOf('export async function saveChatMessage(');
    const b = LOCAL.indexOf('export async function saveChatMessageChecked(');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    // Своей записи у обёртки быть не должно: две копии разъедутся.
    expect(LOCAL.slice(a, b)).not.toContain('INSERT OR IGNORE INTO chat_messages');
    expect(LOCAL.slice(a, b)).toContain('await saveChatMessageChecked(row);');
  });

  it('приёмник спрашивает различающей формой и выходит до побочных действий', () => {
    const write = MESSAGING.indexOf('const stored = await saveChatMessageWithTouch(row, {');
    const defer = MESSAGING.indexOf("if (stored === 'failed') {");
    const dup = MESSAGING.indexOf("const alreadyStored = stored === 'duplicate';");
    expect(write).toBeGreaterThan(0);
    expect(defer).toBeGreaterThan(write);
    expect(dup).toBeGreaterThan(defer);
    // Между записью и превью не должно остаться ни maybeSetTip, ни плашки.
    expect(MESSAGING.slice(write, dup)).toContain("return 'deferred';");
  });

  it('чтения-до-записи, сплющивавшего отказ с пустотой, больше нет', () => {
    expect(MESSAGING).not.toContain('await getChatMessageAuthor(');
  });

  it('ориентир на месте: у группы такой же отказ откладывается с v4.32.765', () => {
    expect(LOCAL).toContain('export type GroupMessageWrite =');
  });
});
