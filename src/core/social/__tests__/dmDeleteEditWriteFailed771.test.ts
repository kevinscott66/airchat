/**
 * Занятая база больше не съедает «удалить у всех» и чужую правку (v4.32.771).
 *
 * v4.32.763 научила обе ветки отличать отказ базы от «строка не его» — но
 * только на ЧТЕНИИ автора строки. Сама запись оставалась молчаливой: ответ
 * `deleteChatMessage` и `updateChatMessageText` не читался вовсе, а `false` у
 * них и так означал сразу две разные вещи — «ни одной строки не подошло» и
 * «база отказала».
 *
 * Дальше как всегда: кадр объявлен разобранным, метка «докуда прочитано» у
 * ретранслятора ушла вперёд, второго такого конверта не будет — собеседник
 * помнит, что прислал. Он у себя стёр (или исправил) и уверен, что сделал это
 * у обоих; у нас остаётся прежнее — навсегда.
 *
 * Правка: обе записи называют исход словом, отказ откладывает кадр. Повтор
 * безвреден: удалять уже удалённое и писать тот же текст нечего.
 *
 * `'missing'` не откладывается: строку успели убрать между чтением автора и
 * записью, и повтор кадра её не вернёт.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Что ответит удаление строки: как настоящая ...Checked. */
let mockDeleteWrite: 'deleted' | 'missing' | 'failed' = 'deleted';
/** Что ответит правка текста строки. */
let mockEditWrite: 'updated' | 'missing' | 'failed' = 'updated';
/** Что ответит чтение автора строки. */
let mockAuthor: { state: string; value?: { contactPubB64: string; direction: string } } = {
  state: 'found',
  value: { contactPubB64: '', direction: 'in' },
};
/** Что стёрли из базы — по порядку. */
const mockDeleted: string[] = [];
/** Что переписали — по порядку. */
const mockEdited: { id: string; text: string }[] = [];
/** Что сохранили новой строкой (для удаления это надгробие). */
const mockSaved: Record<string, unknown>[] = [];
const mockEnvelope: { current: unknown } = { current: null };

jest.mock('../../storage/local', () => ({
  chatMessageExists: async () => false,
  deleteChatMessage: async () => true,
  deleteChatMessageChecked: async (id: string) => {
    if (mockDeleteWrite === 'deleted') mockDeleted.push(id);
    return mockDeleteWrite;
  },
  getChatMessageAuthorRead: async () => mockAuthor,
  getChatMessageTexts: async () => new Map(),
  listChatMessages: async () => [],
  upsertChatMessage: async () => {},
  saveChatMessage: async (r: Record<string, unknown>) => {
    mockSaved.push(r);
  },
  saveChatMessageChecked: async (r: Record<string, unknown>) => {
    mockSaved.push(r);
    return 'inserted';
  },
  updateChatMessageStatus: async () => {},
  updateChatMessageStatusChecked: async () => 'updated',
  updateChatMessageText: async () => true,
  updateChatMessageTextChecked: async (id: string, text: string) => {
    if (mockEditWrite === 'updated') mockEdited.push({ id, text });
    return mockEditWrite;
  },
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
/** Положить в приёмник служебный конверт от собеседника. */
async function deliver(payload: Record<string, unknown>): Promise<string> {
  const ts = Date.now();
  mockEnvelope.current = {
    messageId: `env${++seq}`,
    senderDid: PEER_DID,
    recipientDid: MY_DID,
    encryptedContent: new TextEncoder().encode(JSON.stringify({ ...payload, _ts: ts })),
    timestamp: ts,
  };
  return new MessagingService(myPair).receiveDirectLanEnvelope(new Uint8Array([1]), PEER_DID);
}

const deliverDelete = (id = 'm1'): Promise<string> =>
  deliver({ kind: 'delete', targetMessageId: id });
const deliverEdit = (text = 'исправлено', id = 'm1'): Promise<string> =>
  deliver({ kind: 'edit', targetMessageId: id, newText: text });

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
  mockEditWrite = 'updated';
  mockAuthor = { state: 'found', value: { contactPubB64: PEER_B64, direction: 'in' } };
  mockDeleted.length = 0;
  mockEdited.length = 0;
  mockSaved.length = 0;
  jest.clearAllMocks();
});

describe('«удалить у всех»: отказ записи откладывает кадр', () => {
  it('база отказала — «отложено», а не «разобрано»', async () => {
    mockDeleteWrite = 'failed';
    expect(await deliverDelete()).toBe('deferred');
  });

  it('надгробие не кладётся поверх неудалённой строки', async () => {
    // Иначе в переписке оказались бы обе: и само сообщение, и пустая отметка
    // о его удалении.
    mockDeleteWrite = 'failed';
    await deliverDelete();
    expect(mockSaved).toEqual([]);
  });

  it('отказ записан в журнал отдельно от нечитаемого автора', async () => {
    mockDeleteWrite = 'failed';
    await deliverDelete();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'delete_payload_write_failed',
      expect.anything()
    );
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      'delete_payload_author_unreadable',
      expect.anything()
    );
  });

  it('база освободилась — тот же кадр доходит целиком', async () => {
    mockDeleteWrite = 'failed';
    expect(await deliverDelete()).toBe('deferred');
    mockDeleteWrite = 'deleted';
    expect(await deliverDelete()).toBe('consumed');
    expect(mockDeleted).toEqual(['m1']);
    expect(mockSaved).toHaveLength(1);
  });
});

describe('чужая правка: отказ записи откладывает кадр', () => {
  it('база отказала — «отложено»', async () => {
    mockEditWrite = 'failed';
    expect(await deliverEdit()).toBe('deferred');
  });

  it('отказ записан в журнал отдельно от нечитаемого автора', async () => {
    mockEditWrite = 'failed';
    await deliverEdit();
    expect(mockLog.warn).toHaveBeenCalledWith('edit_payload_write_failed', expect.anything());
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      'edit_payload_author_unreadable',
      expect.anything()
    );
  });

  it('база освободилась — текст встаёт на место', async () => {
    mockEditWrite = 'failed';
    expect(await deliverEdit()).toBe('deferred');
    mockEditWrite = 'updated';
    expect(await deliverEdit()).toBe('consumed');
    expect(mockEdited).toEqual([{ id: 'm1', text: 'исправлено' }]);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отсрочка не бесплатна: кадр разбирается заново. Откладываем ровно то, что
 * пройдёт со второго раза; окончательное окончательным и остаётся.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: окончательные исходы остаются разобранными', () => {
  it('обычное удаление — «разобрано», строка ушла, надгробие легло', async () => {
    expect(await deliverDelete()).toBe('consumed');
    expect(mockDeleted).toEqual(['m1']);
    expect(mockSaved).toHaveLength(1);
  });

  it('обычная правка — «разобрано»', async () => {
    expect(await deliverEdit()).toBe('consumed');
    expect(mockEdited).toEqual([{ id: 'm1', text: 'исправлено' }]);
  });

  it('удалять нечего — «разобрано»: повтор кадра строку не вернёт', async () => {
    mockDeleteWrite = 'missing';
    expect(await deliverDelete()).toBe('consumed');
  });

  it('править нечего — «разобрано»', async () => {
    mockEditWrite = 'missing';
    expect(await deliverEdit()).toBe('consumed');
  });

  it('строка не его — «разобрано», и записи не было', async () => {
    mockAuthor = { state: 'found', value: { contactPubB64: PEER_B64, direction: 'out' } };
    expect(await deliverDelete()).toBe('consumed');
    expect(await deliverEdit()).toBe('consumed');
    expect(mockDeleted).toEqual([]);
    expect(mockEdited).toEqual([]);
  });

  it('нечитаемый автор по-прежнему откладывает кадр (v4.32.763)', async () => {
    mockAuthor = { state: 'failed' };
    expect(await deliverDelete()).toBe('deferred');
    expect(await deliverEdit()).toBe('deferred');
  });

  it('три исхода записи дают два разных ответа, и ровно там, где надо', async () => {
    const verdicts: string[] = [];
    for (const w of ['deleted', 'missing', 'failed'] as const) {
      mockDeleteWrite = w;
      verdicts.push(await deliverDelete());
    }
    for (const w of ['updated', 'missing', 'failed'] as const) {
      mockEditWrite = w;
      verdicts.push(await deliverEdit());
    }
    expect(verdicts).toEqual([
      'consumed',
      'consumed',
      'deferred',
      'consumed',
      'consumed',
      'deferred',
    ]);
  });

  it('подмена системной строки правкой по-прежнему не проходит (v4.32.239)', async () => {
    await deliverEdit('sys:Исчезающие сообщения включены');
    expect(mockEdited).toHaveLength(1);
    expect(mockEdited[0].text).not.toContain('sys:');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('различающие формы записи отвечают словом, а не булевым', () => {
    expect(LOCAL).toContain('export type ChatDeleteWrite =');
    expect(LOCAL).toContain('export type ChatTextWrite =');
    const at = LOCAL.indexOf('export async function deleteChatMessageChecked(');
    expect(at).toBeGreaterThan(0);
    expect(LOCAL.slice(at, at + 200)).toContain('): Promise<ChatDeleteWrite> {');
    const et = LOCAL.indexOf('export async function updateChatMessageTextChecked(');
    expect(et).toBeGreaterThan(0);
    expect(LOCAL.slice(et, et + 200)).toContain('): Promise<ChatTextWrite> {');
  });

  it('сплющивающие формы остались — и остались ровно обёртками', () => {
    // Их читает отправляющая сторона: ей хватает «получилось или нет».
    const a = LOCAL.indexOf('export async function deleteChatMessage(');
    const b = LOCAL.indexOf('export async function deleteChatMessageChecked(');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(LOCAL.slice(a, b)).toContain(
      "return (await deleteChatMessageChecked(id, ownerProfileId)) === 'deleted';"
    );
    // Своей записи у обёртки быть не должно: две копии разъедутся.
    expect(LOCAL.slice(a, b)).not.toContain('DELETE FROM chat_messages');

    const c = LOCAL.indexOf('export async function updateChatMessageText(');
    const d = LOCAL.indexOf('export async function updateChatMessageTextChecked(');
    expect(c).toBeGreaterThan(0);
    expect(d).toBeGreaterThan(c);
    expect(LOCAL.slice(c, d)).toContain(
      "return (await updateChatMessageTextChecked(id, newText, ownerProfileId)) === 'updated';"
    );
    expect(LOCAL.slice(c, d)).not.toContain('UPDATE chat_messages SET text');
  });

  it('приёмник читает исход обеих записей и откладывает отказ', () => {
    expect(MESSAGING).toContain(
      'const removed = await deleteChatMessageChecked(payload.targetMessageId, ownerPid);'
    );
    expect(MESSAGING).toContain("if (removed === 'failed') {");
    expect(MESSAGING).toContain("const edited = await updateChatMessageTextChecked(");
    expect(MESSAGING).toContain("if (edited === 'failed') {");
    // Молчаливых записей на входящих путях не осталось.
    expect(MESSAGING).not.toContain('await deleteChatMessage(payload.targetMessageId');
    expect(MESSAGING).not.toContain('await updateChatMessageText(payload.targetMessageId');
    expect(MESSAGING).not.toContain('await updateChatMessageText(rowId, rawText, ownerPid);');
  });

  it('живая геолокация тоже читает исход записи', () => {
    // Сама по себе посылка чинится следующей, но последняя посылки за собой
    // не тянет: на ней метка и замрёт.
    expect(MESSAGING).toContain(
      'const moved = await updateChatMessageTextChecked(rowId, rawText, ownerPid);'
    );
    const at = MESSAGING.indexOf("if (moved === 'failed') {");
    expect(at).toBeGreaterThan(0);
    expect(MESSAGING.slice(at, at + 200)).toContain("return 'deferred';");
  });

  it('отправляющая сторона по-прежнему читает булев ответ обёрток', () => {
    // Иначе обёртки стали бы мёртвым кодом, и их незачем было бы держать.
    expect(MESSAGING).toContain('const localDone = await deleteChatMessage(targetMessageId, ownerPid);');
    expect(MESSAGING).toContain('const localDone = await updateChatMessageText(messageId, newText, ownerPid);');
  });
});
