/**
 * Заблокированный незнакомец не заводит строку контакта (v4.32.615).
 *
 * Удаление контакта и блокировка — разные вещи, но вместе они обязаны давать
 * то, чего человек и хотел: от собеседника не остаётся ни следа, и он не
 * возвращается. До этой правки возвращался. Ключ шифрования в строке контакта
 * не хранится — он считается из двух открытых ключей, — поэтому следующее
 * сообщение удалённого расшифровывалось как прежде, и `ensureImplicitContact`
 * заводил строку заново. Проверка блок-листа стояла одна и ниже по коду, в
 * `persistIncomingFromEnvelope`: сообщение она отбрасывала верно, но строка к
 * тому времени уже была создана, а `refreshSubscriptions` успевал подписать
 * меня на топик того, кого просили не пускать.
 *
 * Теперь блок-лист спрашивается там же, где и `privacy_only_contacts_msg`, —
 * до создания строки. Групповые конверты по-прежнему проходят: состав и права
 * группы задаются ролями в ней, а не моим личным списком (см. blockPolicy).
 */
import * as fs from 'fs';
import * as path from 'path';

const mockSaved: Record<string, unknown>[] = [];
const mockEnsure = jest.fn(async () => true);
const mockRefresh = jest.fn();
const mockGroup = jest.fn(async () => true);
const mockBlocked = { current: false };
/** Номера профилей, у которых служба спрашивала контакты (v4.32.710). */
const mockScopePids: number[] = [];
const mockEnvelope: { current: unknown } = { current: null };

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
    getMessage(): Promise<unknown> { return Promise.resolve(null); }
    publishToSelfInbox(): Promise<null> { return Promise.resolve(null); }
    // Переподписка начинается с собственного входящего ящика и только с него,
    // поэтому её видно здесь; в этом тесте `startListening` больше некому
    // позвать, кроме `refreshSubscriptions`.
    subscribeToSelfInbox(): Promise<null> { mockRefresh(); return Promise.resolve(null); }
    subscribeToContact(): Promise<null> { return Promise.resolve(null); }
  },
  parseEnvelopeFromWire: () => mockEnvelope.current,
  serializeEnvelopeToBytes: () => new Uint8Array(),
}));

// Шифрование здесь не проверяется: конверт от незнакомца расшифровывается
// выведенным ключом, и именно это делает его строку контакта возможной.
const mockSym = new Uint8Array(32).fill(7);
jest.mock('../contacts', () => ({
  getSymmetricKeyForPeer: async () => mockSym,
  // v4.32.710: служба берёт контакты у своего владельца, а не у активного
  // профиля, и номер, с которым её спрашивают, здесь записывается.
  listContactsFor: async (pid: number) => { mockScopePids.push(pid); return []; },
  listContacts: async () => [],
  ensureImplicitContact: (...a: unknown[]) => mockEnsure(...(a as [])),
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
  handleIncomingGroupEnvelope: () => mockGroup(),
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
  rateLimiter: { whenReady: async () => {}, isBlocked: () => mockBlocked.current },
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
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { publicKeyToDidKey } from '../../identity/did';
import { MessagingService } from '../messaging';

// Ключи здесь не подписывают и не шифруют — нужны лишь различимые 32 байта,
// из которых выводится did:key.
const ME = new Uint8Array(32).fill(1);
const STRANGER = new Uint8Array(32).fill(2);
const myPair = { publicKey: ME, secretKey: new Uint8Array(64).fill(1) };
const MY_DID = publicKeyToDidKey(ME);
const STRANGER_DID = publicKeyToDidKey(STRANGER);

let seq = 0;
/** Положить в приёмник конверт от незнакомца и отдать его сервису. */
async function deliver(text: string): Promise<void> {
  const ts = Date.now();
  mockEnvelope.current = {
    messageId: `m${++seq}`,
    senderDid: STRANGER_DID,
    recipientDid: MY_DID,
    encryptedContent: new TextEncoder().encode(JSON.stringify({ text, _ts: ts })),
    timestamp: ts,
  };
  await new MessagingService(myPair).receiveDirectLanEnvelope(new Uint8Array([1]), STRANGER_DID);
}

beforeEach(() => {
  mockSaved.length = 0;
  mockEnsure.mockClear();
  mockRefresh.mockClear();
  mockGroup.mockClear();
  mockBlocked.current = false;
  mockScopePids.length = 0;
});

describe('строка контакта для незнакомца', () => {
  it('незаблокированный незнакомец заводит контакт и его сообщение сохраняется', async () => {
    await deliver('привет, это я');
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockSaved).toHaveLength(1);
    // Счётчик переподписки живой: без него проверка ниже ничего не значила бы.
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('контакты спрашиваются у владельца службы, а не у активного профиля', async () => {
    await deliver('привет, это я');
    // Спрашивали хотя бы раз (приём конверта + переподписка) и каждый раз —
    // про профиль, которому принадлежит пара ключей службы.
    expect(mockScopePids.length).toBeGreaterThan(0);
    expect(mockScopePids.every((p) => p === 1)).toBe(true);
  });

  it('заблокированный незнакомец контакт не заводит', async () => {
    mockBlocked.current = true;
    await deliver('я вернулся');
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockSaved).toHaveLength(0);
  });

  it('заблокированный незнакомец не заставляет переподписаться на свой топик', async () => {
    mockBlocked.current = true;
    await deliver('я вернулся');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('групповой конверт от заблокированного разбирается: у группы своё правило', async () => {
    mockBlocked.current = true;
    await deliver('\x02grp:g1:привет всем');
    expect(mockGroup).toHaveBeenCalledTimes(1);
  });

  it('но строку контакта групповой конверт от заблокированного не заводит', async () => {
    // v4.32.617: исключение для групп касалось и создания строки — а не должно
    // было. Заблокированному хватало одного `\x0egctl:`, чтобы вернуться в мой
    // список; следом эта же строка сходила за доверие при разборе приглашения.
    mockBlocked.current = true;
    await deliver('\x02grp:g1:привет всем');
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('проверка не пустая: незаблокированный групповой конверт строку заводит', async () => {
    await deliver('\x02grp:g1:привет всем');
    expect(mockGroup).toHaveBeenCalledTimes(1);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  it('нечитаемое тело от заблокированного проходит за обычное и отбрасывается', async () => {
    mockBlocked.current = true;
    await deliver('\x02grp');
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

describe('форма исходников', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('проверка блок-листа стоит раньше создания строки контакта', () => {
    const gate = CODE.indexOf('dm_blocked_no_implicit_contact');
    const create = CODE.indexOf('await ensureImplicitContact(');
    expect(gate).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(gate);
  });

  it('обещание deleteContact про исчезнувший ключ убрано', () => {
    const contacts = fs.readFileSync(path.join(__dirname, '..', 'contacts.ts'), 'utf8');
    expect(contacts).not.toContain('The sym key is gone');
  });
});
