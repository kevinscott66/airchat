/**
 * Занятая база больше не съедает галочку «прочитано» в личке (v4.32.770).
 *
 * v4.32.763 научила приёмник отметок отличать отказ базы от «это не моё
 * исходящее» — но только на ЧТЕНИИ автора строки. Сама запись состояния
 * (`updateChatMessageStatus`) по-прежнему отвечала `void` и гасила свой отказ
 * в собственном `catch`: прочитали автора, не записали состояние, засчитали
 * отметку, объявили кадр разобранным.
 *
 * Дальше как всегда: метка «докуда прочитано» у ретранслятора уходит вперёд,
 * второго конверта по этой отметке нет. Галочка у отправителя не появлялась до
 * тех пор, пока собеседник заново не откроет переписку (ChatScreen шлёт
 * отметки по всем входящим при каждом открытии), — то есть могла не появиться
 * вовсе.
 *
 * Правка: запись называет исход словом, и отказ считается вровень с
 * нечитаемым автором — кадр откладывается. Применить отметку дважды безвредно:
 * `status` пишется в то же самое значение.
 *
 * `'missing'` откладывать нечего: строку успели удалить между чтением автора и
 * записью, и повтор кадра её не вернёт.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Что ответит запись состояния строки: как настоящая ...Checked. */
let mockStatusWrite: 'updated' | 'missing' | 'failed' = 'updated';
/** Что ответит чтение автора строки. */
let mockAuthor: { state: string; value?: { contactPubB64: string; direction: string } } = {
  state: 'found',
  value: { contactPubB64: '', direction: 'out' },
};
/** Строки, чьё состояние успели записать. */
const mockStatuses: { id: string; status: string }[] = [];
const mockEnvelope: { current: unknown } = { current: null };

jest.mock('../../storage/local', () => ({
  chatMessageExists: async () => false,
  deleteChatMessage: async () => true,
  deleteChatMessageChecked: async () => 'deleted',
  getChatMessageAuthorRead: async () => mockAuthor,
  getChatMessageTexts: async () => new Map(),
  listChatMessages: async () => [],
  upsertChatMessage: async () => {},
  saveChatMessage: async () => {},
  saveChatMessageChecked: async () => 'inserted',
  updateChatMessageStatus: async () => {},
  updateChatMessageStatusChecked: async (id: string, status: string) => {
    if (mockStatusWrite === 'updated') mockStatuses.push({ id, status });
    return mockStatusWrite;
  },
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

// Шифрование здесь не проверяется: проверяется судьба уже расшифрованного
// служебного конверта, чью запись не удалось положить в базу.
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
  rateLimiter: {
    whenReady: async () => {},
    // v4.32.795: «список прочитан» — предмет отдельного вопроса, а не
    // молчаливого «не заблокирован». Здесь база открыта.
    blockedListReadable: () => true,
    isBlocked: () => false,
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
// uuid — чистый ESM, jest его не разбирает; в проверке он не участвует.
let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `u${++mockUuid}` }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { publicKeyToDidKey } from '../../identity/did';
import { MessagingService } from '../messaging';

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
const PEER_B64 = Buffer.from(PEER).toString('base64');

let seq = 0;
/** Положить в приёмник отметку о прочтении от собеседника. */
async function deliverReceipt(messageIds = ['m1']): Promise<string> {
  const ts = Date.now();
  mockEnvelope.current = {
    messageId: `env${++seq}`,
    senderDid: PEER_DID,
    recipientDid: MY_DID,
    encryptedContent: new TextEncoder().encode(
      JSON.stringify({ kind: 'read_receipt', messageIds, _ts: ts })
    ),
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
  mockStatusWrite = 'updated';
  mockAuthor = { state: 'found', value: { contactPubB64: PEER_B64, direction: 'out' } };
  mockStatuses.length = 0;
  jest.clearAllMocks();
});

describe('запись состояния не удалась', () => {
  it('кадр откладывается, а не съедается', async () => {
    mockStatusWrite = 'failed';
    expect(await deliverReceipt()).toBe('deferred');
  });

  it('отказ записан в журнал отдельно от нечитаемого автора', async () => {
    mockStatusWrite = 'failed';
    await deliverReceipt();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'read_receipts_write_failed',
      expect.objectContaining({ unwritten: 1 })
    );
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      'read_receipts_author_unreadable',
      expect.anything()
    );
  });

  it('одна отметка из двух не легла — откладывается весь кадр', async () => {
    // Повтор безвреден: уже записанные строки получат то же самое значение.
    let calls = 0;
    mockStatusWrite = 'updated';
    const local = jest.requireMock('../../storage/local') as {
      updateChatMessageStatusChecked: (id: string, s: string) => Promise<string>;
    };
    const real = local.updateChatMessageStatusChecked;
    local.updateChatMessageStatusChecked = async (id: string, s: string) =>
      ++calls === 2 ? 'failed' : real(id, s);
    try {
      expect(await deliverReceipt(['m1', 'm2'])).toBe('deferred');
      expect(mockStatuses).toEqual([{ id: 'm1', status: 'read' }]);
    } finally {
      local.updateChatMessageStatusChecked = real;
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: окончательные исходы остаются разобранными', () => {
  it('обычная отметка ложится и кадр разобран', async () => {
    expect(await deliverReceipt()).toBe('consumed');
    expect(mockStatuses).toEqual([{ id: 'm1', status: 'read' }]);
    expect(mockLog.info).toHaveBeenCalledWith(
      'read_receipts_applied',
      expect.objectContaining({ count: 1 })
    );
  });

  it('строки уже нет — «разобрано»: повтор кадра её не вернёт', async () => {
    mockStatusWrite = 'missing';
    expect(await deliverReceipt()).toBe('consumed');
  });

  it('отметка не по нашему исходящему — «разобрано»', async () => {
    mockAuthor = { state: 'found', value: { contactPubB64: PEER_B64, direction: 'in' } };
    expect(await deliverReceipt()).toBe('consumed');
    expect(mockStatuses).toEqual([]);
  });

  it('строки такой нет вовсе — «разобрано»', async () => {
    mockAuthor = { state: 'missing' };
    expect(await deliverReceipt()).toBe('consumed');
    expect(mockStatuses).toEqual([]);
  });

  it('нечитаемый автор по-прежнему откладывает кадр (v4.32.763)', async () => {
    mockAuthor = { state: 'failed' };
    expect(await deliverReceipt()).toBe('deferred');
  });

  it('четыре исхода дают два разных ответа, и ровно там, где надо', async () => {
    const verdicts: string[] = [];
    for (const w of ['updated', 'missing', 'failed'] as const) {
      mockStatusWrite = w;
      verdicts.push(await deliverReceipt());
    }
    mockStatusWrite = 'updated';
    mockAuthor = { state: 'failed' };
    verdicts.push(await deliverReceipt());
    expect(verdicts).toEqual(['consumed', 'consumed', 'deferred', 'deferred']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('различающая форма записи отвечает словом, а не молчанием', () => {
    expect(LOCAL).toContain('export type ChatStatusWrite =');
    expect(LOCAL).toContain("return (res.changes ?? 0) > 0 ? 'updated' : 'missing';");
  });

  it('сплющивающая форма осталась — и осталась ровно обёрткой', () => {
    const a = LOCAL.indexOf('export async function updateChatMessageStatus(');
    const b = LOCAL.indexOf('export async function updateChatMessageStatusChecked(');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    // Своей записи у обёртки быть не должно: две копии разъедутся.
    expect(LOCAL.slice(a, b)).not.toContain('UPDATE chat_messages SET status');
    expect(LOCAL.slice(a, b)).toContain(
      'await updateChatMessageStatusChecked(id, status, ownerProfileId);'
    );
  });

  it('приёмник считает отказ записи и откладывает кадр', () => {
    expect(MESSAGING).toContain(
      "const marked = await updateChatMessageStatusChecked(msgId, 'read', ownerPid);"
    );
    expect(MESSAGING).toContain("if (marked === 'failed') {");
    expect(MESSAGING).toContain("if (unreadable > 0 || unwritten > 0) return 'deferred';");
    // Молчаливой записи на этом пути не осталось.
    expect(MESSAGING).not.toContain("await updateChatMessageStatus(msgId, 'read'");
  });
});
