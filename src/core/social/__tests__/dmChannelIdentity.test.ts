/**
 * Конверт принадлежит той переписке, чьим ключом расшифровался (v4.32.615).
 *
 * Личный конверт шифруется общим ключом пары. Значит расшифровка доказывает
 * ровно одно: его собрал тот, с кем этот ключ общий, — то есть собеседник или
 * мы сами. Поле senderDid внутри конверта доказательством не является: его
 * пишет отправитель, и ничто не мешает ему написать туда чужой DID.
 *
 * До этой правки два входа из трёх отбрасывали конверт «от самого себя»
 * (receiveDirectLanEnvelope и subscribeToSelfInbox), а третий — receiveCid,
 * тот самый, что кормится из общей темы airchat-dm и из push, — не
 * отбрасывал. Последствия расходились по двум веткам:
 *
 * 1. senderDid = наш собственный DID. Тогда inbound ложно и строка ложится
 *    как «отправлено мной», с датой из конверта (то есть в любое место
 *    истории) и мимо блок-листа: тот спрашивается под inbound.
 * 2. senderDid = DID третьего лица. Строка ложится в правильную переписку,
 *    а во всплывающую плашку и дальше в уведомление уходит чужой DID.
 *
 * Отдельно проверяется, что законный случай не сломан: восстановление истории
 * из DAG профиля (syncHistoryFromPeer) обходит переписку целиком и обязано
 * принимать наши собственные исходящие.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockSaved: Record<string, unknown>[] = [];
const mockGetMessage = jest.fn<Promise<unknown>, [string]>();

jest.mock('../../storage/local', () => ({
  chatMessageExists: async () => false,
  deleteChatMessage: async () => true,
  getChatMessageAuthor: async () => null,
  getChatMessageTexts: async () => new Map(),
  listChatMessages: async () => [],
  upsertChatMessage: async () => {},
  saveChatMessage: async (r: Record<string, unknown>) => { mockSaved.push(r); },
  updateChatMessageStatus: async () => {},
  updateChatMessageText: async () => true,
  touchConversation: async () => {},
}));

jest.mock('../messageStore', () => ({
  IPFSMessageStore: class {
    getMessage(cid: string): Promise<unknown> { return mockGetMessage(cid); }
    publishToSelfInbox(): Promise<null> { return Promise.resolve(null); }
    subscribeToSelfInbox(): Promise<null> { return Promise.resolve(null); }
    subscribeToContact(): Promise<null> { return Promise.resolve(null); }
  },
  parseEnvelopeFromWire: () => null,
  serializeEnvelopeToBytes: () => new Uint8Array(),
}));

// Ключ переписки один на всех: тест проверяет не криптографию, а то, кому
// приписывается уже расшифрованный конверт.
const mockSym = new Uint8Array(32).fill(7);
jest.mock('../contacts', () => ({
  getSymmetricKeyForPeer: async () => mockSym,
  listContacts: async () => [],
  ensureImplicitContact: async () => {},
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
  handleIncomingGroupEnvelope: async () => false,
  handleIncomingGroupReadReceipt: async () => false,
  handleIncomingGroupJoinRequest: async () => false,
  handleIncomingGroupControl: async () => false,
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
// uuid — чистый ESM, jest его не разбирает; здесь он не участвует в проверке.
let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `u${++mockUuid}` }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { publicKeyToDidKey } from '../../identity/did';
import { publicKeyToB64 } from '../../crypto/pubKeyFormat';
import { MessagingService } from '../messaging';

// Ключи здесь не подписывают и не шифруют (шифрование замокано выше) —
// нужны только различимые 32 байта, из которых выводится did:key.
const pub = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const ME = pub(1);
const PEER = pub(2);
const THIRD = pub(3);
const myPair = { publicKey: ME, secretKey: new Uint8Array(64).fill(1) };
const MY_DID = publicKeyToDidKey(ME);
const PEER_DID = publicKeyToDidKey(PEER);
const THIRD_DID = publicKeyToDidKey(THIRD);
const PEER_PUB = publicKeyToB64(PEER);

let seq = 0;
function envelope(senderDid: string, recipientDid: string, text: string): unknown {
  const ts = Date.now();
  return {
    messageId: `m${++seq}`,
    senderDid,
    recipientDid,
    encryptedContent: new TextEncoder().encode(JSON.stringify({ text, _ts: ts })),
    timestamp: ts,
  };
}

function service(): MessagingService {
  return new MessagingService(myPair);
}

beforeEach(() => {
  mockSaved.length = 0;
  mockGetMessage.mockReset();
});

describe('receiveCid: чей это конверт', () => {
  it('обычное входящее от собеседника сохраняется', async () => {
    mockGetMessage.mockResolvedValue(envelope(PEER_DID, MY_DID, 'привет'));
    await service().receiveCid('QmOk', PEER_PUB);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ direction: 'in', contactPubB64: PEER_PUB });
  });

  it('конверт «от меня самого» из общей темы не сохраняется', async () => {
    mockGetMessage.mockResolvedValue(envelope(MY_DID, MY_DID, 'я такого не писал'));
    await service().receiveCid('QmForged', PEER_PUB);
    expect(mockSaved).toHaveLength(0);
  });

  it('конверт «от меня собеседнику» из общей темы тоже не сохраняется', async () => {
    // Именно эта форма ложилась строкой direction:'out' в мою переписку.
    mockGetMessage.mockResolvedValue(envelope(MY_DID, PEER_DID, 'подделка исходящего'));
    await service().receiveCid('QmForgedOut', PEER_PUB);
    expect(mockSaved).toHaveLength(0);
  });

  it('конверт, подписанный чужим DID, не приписывается третьему лицу', async () => {
    mockGetMessage.mockResolvedValue(envelope(THIRD_DID, MY_DID, 'как будто от Кэрол'));
    await service().receiveCid('QmThird', PEER_PUB);
    expect(mockSaved).toHaveLength(0);
  });

  it('своё исходящее к другому собеседнику не попадает в эту переписку', async () => {
    mockGetMessage.mockResolvedValue(envelope(MY_DID, THIRD_DID, 'чужая переписка'));
    await service().receiveCid('QmWrongChat', PEER_PUB, true);
    expect(mockSaved).toHaveLength(0);
  });
});

describe('восстановление истории', () => {
  it('своё исходящее принимается, когда обход DAG попросил об этом явно', async () => {
    mockGetMessage.mockResolvedValue(envelope(MY_DID, PEER_DID, 'моё старое сообщение'));
    await service().receiveCid('QmHistory', PEER_PUB, true);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ direction: 'out', status: 'sent', contactPubB64: PEER_PUB });
  });

  it('входящее по этому же пути тоже принимается', async () => {
    mockGetMessage.mockResolvedValue(envelope(PEER_DID, MY_DID, 'его старое сообщение'));
    await service().receiveCid('QmHistoryIn', PEER_PUB, true);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ direction: 'in' });
  });
});

describe('кто просит послабление', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('послабление просит ровно один вызов — обход DAG профиля', () => {
    expect((CODE.match(/this\.receiveCid\([^)]*true\)/g) ?? []).length).toBe(1);
    expect(CODE).toMatch(/importCid: \(cid\) => this\.receiveCid\(cid, peerPublicKeyB64, true\)/);
  });

  it('push и общая тема зовут receiveCid без послабления', () => {
    expect(CODE).toMatch(/await this\.receiveCid\(cid, peerPubKeyB64\);/);
    expect(CODE).toMatch(/await this\.receiveCid\(cid\.trim\(\), c\.peerPublicKey\);/);
  });
});
