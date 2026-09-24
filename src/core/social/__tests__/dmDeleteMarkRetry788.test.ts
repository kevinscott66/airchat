/**
 * Надгробие «сообщение удалено» переживает занятую секунду (v4.32.788).
 *
 * Дефект. Собеседник нажал «удалить у всех». v4.32.771 научила сам снос
 * называть исход словом и откладывать кадр при отказе базы. А пометку, которая
 * встаёт на место снесённого сообщения, по-прежнему клала гасящая
 * `saveChatMessage` — та зовёт проверяемую форму и выбрасывает её ответ, так
 * что отказ было нечем заметить. Секунда занятой базы — и строка исчезала, а
 * пометки не появлялось: на экране оставалась дыра без объяснения. Обиднее
 * всего, что собеседник уверен: пометку у нас видно.
 *
 * Правка. Пишем проверяемой формой и повторяем теми же паузами, что чтения и
 * журнал звонков (v4.32.749): причина отказа тут почти всегда одна — SQLite
 * занят на доли секунды.
 *
 * Порядок при этом остаётся прежним: сначала снос, потом пометка. Поменять их
 * местами нельзя — при отказе сноса в переписке оказались бы обе строки сразу,
 * и сообщение, и пустая отметка о его удалении (инвариант v4.32.771). А
 * откладывать кадр после удавшегося сноса бесполезно: цели уже нет, второй
 * заход упрётся в проверку авторства и объявит чужим наше же удаление.
 * Поэтому исчерпанный повтор кадр не откладывает, а говорит вслух: теряется
 * пометка, не содержимое.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Что ответит снос строки: как настоящая ...Checked. */
let mockDeleteWrite: 'deleted' | 'missing' | 'failed' = 'deleted';
/** Сколько первых попыток записи надгробия отказывают. Infinity — все. */
let mockMarkFailures = 0;
/** Что ответит запись, когда отказывать уже нечему. */
let mockMarkWrite: 'inserted' | 'duplicate' = 'inserted';
/** Сколько раз проверяемую запись вообще позвали. */
let mockMarkCalls = 0;
/** Что стёрли из базы — по порядку. */
const mockDeleted: string[] = [];
/** Что легло новой строкой (для удаления это надгробие). */
const mockSaved: Record<string, unknown>[] = [];
const mockEnvelope: { current: unknown } = { current: null };

jest.mock('../../storage/local', () => ({
  chatMessageExists: async () => false,
  deleteChatMessage: async () => true,
  deleteChatMessageChecked: async (id: string) => {
    if (mockDeleteWrite === 'deleted') mockDeleted.push(id);
    return mockDeleteWrite;
  },
  getChatMessageAuthorRead: async () => ({
    state: 'found',
    value: { contactPubB64: mockPeerB64.current, direction: 'in' },
  }),
  getChatMessageTexts: async () => new Map(),
  listChatMessages: async () => [],
  upsertChatMessage: async () => {},
  // Гасящая форма подделана так же, как она устроена в local.ts: зовёт
  // проверяемую и выбрасывает её ответ. Без неё встречная проверка (файлы до
  // правки) шла бы не по настоящему коду, а спотыкалась о невыставленную
  // заглушку.
  saveChatMessage: async (r: Record<string, unknown>) => {
    mockMarkCalls += 1;
    if (mockMarkCalls <= mockMarkFailures) return;
    mockSaved.push(r);
  },
  // Ровно так отказывает настоящая проверяемая запись: строка не легла, и об
  // этом сказано ответом, а не исключением.
  saveChatMessageChecked: async (r: Record<string, unknown>) => {
    mockMarkCalls += 1;
    if (mockMarkCalls <= mockMarkFailures) return 'failed';
    mockSaved.push(r);
    return mockMarkWrite;
  },
  updateChatMessageStatus: async () => {},
  updateChatMessageStatusChecked: async () => 'updated',
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
// служебного конверта, чью пометку не удалось положить в базу.
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
import { READ_RETRY_ATTEMPTS } from '../../storage/readRetry';

const mockLog = (jest.requireMock('../../logger') as {
  log: { warn: jest.Mock; info: jest.Mock };
}).log;

// Ключи здесь не подписывают и не шифруют — нужны лишь различимые 32 байта,
// из которых выводится did:key.
const ME = new Uint8Array(32).fill(1);
const PEER = new Uint8Array(32).fill(2);
const myPair = { publicKey: ME, secretKey: new Uint8Array(64).fill(1) };
const MY_DID = publicKeyToDidKey(ME);
const PEER_DID = publicKeyToDidKey(PEER);
/** Автора строки заглушка отдаёт по ссылке: он нужен ей до импортов. */
const mockPeerB64 = { current: Buffer.from(PEER).toString('base64') };

let seq = 0;
/** Положить в приёмник конверт «удалить у всех» от собеседника. */
async function deliverDelete(id = 'm1'): Promise<string> {
  const ts = Date.now();
  mockEnvelope.current = {
    messageId: `env${++seq}`,
    senderDid: PEER_DID,
    recipientDid: MY_DID,
    encryptedContent: new TextEncoder().encode(
      JSON.stringify({ kind: 'delete', targetMessageId: id, _ts: ts }),
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
  mockDeleteWrite = 'deleted';
  mockMarkFailures = 0;
  mockMarkWrite = 'inserted';
  mockMarkCalls = 0;
  mockDeleted.length = 0;
  mockSaved.length = 0;
  jest.clearAllMocks();
});

describe('база занята — пометка всё равно встаёт', () => {
  it('первая попытка отказала, вторая легла', async () => {
    mockMarkFailures = 1;

    // До правки запись была одна и молчаливая: отказ терялся, и сообщение
    // пропадало с экрана без всякого «удалено».
    expect(await deliverDelete()).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ id: 'env1' });
  });

  it('хватает и последнего разрешённого повтора', async () => {
    mockMarkFailures = READ_RETRY_ATTEMPTS;
    expect(await deliverDelete()).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
    expect(mockMarkCalls).toBe(READ_RETRY_ATTEMPTS + 1);
  });

  it('повторов ровно столько, сколько обещано, — и ни одним больше', async () => {
    // Приёмник разбирает кадры по очереди: бесконечный повтор здесь встал бы
    // поперёк всей входящей почты.
    mockMarkFailures = Infinity;
    await deliverDelete();
    expect(mockMarkCalls).toBe(READ_RETRY_ATTEMPTS + 1);
  });
});

describe('база так и не ответила', () => {
  it('кадр всё равно разобран: повторять его уже нечем', async () => {
    // Строки-цели нет, и второй заход упрётся в проверку авторства, объявив
    // чужим наше же удаление. Отсрочка тут не чинит, а портит.
    mockMarkFailures = Infinity;
    expect(await deliverDelete()).toBe('consumed');
  });

  it('содержимое ушло, даже если пометка не легла', async () => {
    mockMarkFailures = Infinity;
    await deliverDelete();
    expect(mockDeleted).toEqual(['m1']);
    expect(mockSaved).toEqual([]);
  });

  it('об этом сказано вслух и отдельным поводом', async () => {
    mockMarkFailures = Infinity;
    await deliverDelete();
    expect(mockLog.warn).toHaveBeenCalledWith('delete_payload_mark_failed', expect.anything());
    // Снос-то прошёл: путать его отказ с отказом пометки нельзя.
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      'delete_payload_write_failed',
      expect.anything(),
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный путь не изменился', () => {
  it('база свободна — одна попытка, пометка легла, кадр разобран', async () => {
    expect(await deliverDelete()).toBe('consumed');
    expect(mockMarkCalls).toBe(1);
    expect(mockDeleted).toEqual(['m1']);
    expect(mockSaved).toHaveLength(1);
  });

  it('пометка уже была — это не отказ, повторять нечего', async () => {
    // Такое бывает при повторной доставке того же конверта.
    mockMarkWrite = 'duplicate';
    expect(await deliverDelete()).toBe('consumed');
    expect(mockMarkCalls).toBe(1);
  });

  it('отказ сноса по-прежнему откладывает кадр и пометки не пишет', async () => {
    // Инвариант v4.32.771: иначе в переписке оказались бы обе строки — и само
    // сообщение, и пустая отметка о его удалении.
    mockDeleteWrite = 'failed';
    expect(await deliverDelete()).toBe('deferred');
    expect(mockSaved).toEqual([]);
    expect(mockMarkCalls).toBe(0);
  });

  it('сносить нечего — пометка всё равно кладётся', async () => {
    // Своей копии у нас может не быть вовсе: конверт «удалить у всех» обгоняет
    // само сообщение чаще, чем кажется. Пометка тут — единственное, что
    // объяснит человеку, откуда взялся разрыв в переписке.
    mockDeleteWrite = 'missing';
    expect(await deliverDelete()).toBe('consumed');
    expect(mockDeleted).toEqual([]);
    expect(mockSaved).toHaveLength(1);
    expect(mockMarkCalls).toBe(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('гасящая форма записи выбрасывает ответ проверяемой', () => {
    // Вот почему отказ было нечем заметить: возвращать было нечего.
    expect(LOCAL).toContain('export async function saveChatMessage(row: ChatMessageRow): Promise<void> {');
    expect(LOCAL).toContain('  await saveChatMessageChecked(row);');
  });

  it('проверяемая форма называет исход словом', () => {
    expect(LOCAL).toContain("export type ChatMessageWrite = 'inserted' | 'duplicate' | 'failed';");
    expect(LOCAL).toContain(
      'export async function saveChatMessageChecked(row: ChatMessageRow): Promise<ChatMessageWrite> {',
    );
  });

  it('надгробие кладётся через повтор, а не одной попыткой', () => {
    expect(MESSAGING).toContain('async function markMessageDeleted(row: ChatMessageRow): Promise<ChatMessageWrite> {');
    expect(MESSAGING).toContain("if (wrote !== 'failed' || attempt >= READ_RETRY_ATTEMPTS) return wrote;");
    expect(MESSAGING).toContain('const marked = await markMessageDeleted({');
    expect(MESSAGING).toContain("if (marked === 'failed') {");
    // Молчаливой записи на этом пути не осталось.
    expect(MESSAGING).not.toContain('await saveChatMessage({');
  });

  it('порядок сохранён: снос раньше пометки', () => {
    // Обратный порядок нарушил бы инвариант v4.32.771 — обе строки сразу.
    const removed = MESSAGING.indexOf(
      'const removed = await deleteChatMessageChecked(payload.targetMessageId, ownerPid);',
    );
    const marked = MESSAGING.indexOf('const marked = await markMessageDeleted({');
    expect(removed).toBeGreaterThan(0);
    expect(marked).toBeGreaterThan(removed);
  });
});
