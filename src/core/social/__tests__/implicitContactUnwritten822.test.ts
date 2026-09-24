/**
 * Письмо незнакомца больше не ложится мимо строки контакта (v4.32.822).
 *
 * Дефект. `ensureImplicitContact` отвечал `boolean`, и `false` значил сразу
 * три вещи: «строка уже есть», «это я сам» и «база отказала». Приём читал его
 * одним способом — «заводить не понадобилось» — и шёл писать сообщение
 * дальше. То есть отказ базы давал сохранённое письмо незнакомца, для
 * которого строки контакта так и не появилось, а кадр при этом объявлялся
 * разобранным: relay держит его ещё тридцать суток, но запрашивать его никто
 * больше не станет.
 *
 * Цена. Контакт — это не украшение списка: в нём лежит имя, на нём стоит
 * подписка на топик собеседника, по нему живёт ключ в указателе. Без строки
 * переписка оставалась висеть от неизвестного, ответ ему не уходил, а
 * следующее его сообщение заводило контакт уже без первого письма.
 *
 * Правка. Исход назван словом: `created` / `exists` / `self` / `failed`.
 * Отказ базы проходит сам, поэтому кадр откладывается — придёт снова и ляжет
 * целиком. Остальные три исхода приём проходит как прежде.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockSaved: Record<string, unknown>[] = [];
/** Что ответит заведение неявного контакта. */
let mockEnsureResult: 'created' | 'exists' | 'self' | 'failed' = 'created';
const mockEnsure = jest.fn(async () => mockEnsureResult);
const mockRefresh = jest.fn();
const mockGroup = jest.fn(async () => true);
const mockBlocked = { current: false };
/** Номера профилей, у которых служба спрашивала контакты (v4.32.710). */
const mockScopePids: number[] = [];
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
  // v4.32.776: входящее пишется вместе со следом в списке чатов, одной операцией.
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
  // v4.32.724: различающее чтение — пустой список, а не отказ.
  listContactsReadFor: async (pid: number) => { mockScopePids.push(pid); return []; },
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
    isBlocked: () => mockBlocked.current,
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
async function deliver(text: string): Promise<'consumed' | 'deferred'> {
  const ts = Date.now();
  mockEnvelope.current = {
    messageId: `m${++seq}`,
    senderDid: STRANGER_DID,
    recipientDid: MY_DID,
    encryptedContent: new TextEncoder().encode(JSON.stringify({ text, _ts: ts })),
    timestamp: ts,
  };
  return await new MessagingService(myPair).receiveDirectLanEnvelope(new Uint8Array([1]), STRANGER_DID);
}

beforeEach(() => {
  mockSaved.length = 0;
  mockEnsure.mockClear();
  mockRefresh.mockClear();
  mockGroup.mockClear();
  mockBlocked.current = false;
  mockScopePids.length = 0;
  mockEnsureResult = 'created';
});

describe('строка контакта не завелась — кадр ждёт, а не проглатывается', () => {
  it('база отказала: отложено, письмо не сохранено', async () => {
    mockEnsureResult = 'failed';

    expect(await deliver('привет, это я')).toBe('deferred');
    expect(mockSaved).toHaveLength(0);
  });

  it('база ожила — тот же кадр доносит письмо', async () => {
    mockEnsureResult = 'failed';
    expect(await deliver('привет, это я')).toBe('deferred');

    mockEnsureResult = 'created';
    expect(await deliver('привет, это я')).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
  });

  it('отказ не подписывает меня на топик того, кого в списке нет', async () => {
    mockEnsureResult = 'failed';
    await deliver('привет, это я');

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('групповой конверт от незнакомца — то же правило', async () => {
    mockEnsureResult = 'failed';

    expect(await deliver('\x02grp:g1:привет всем')).toBe('deferred');
    expect(mockGroup).not.toHaveBeenCalled();
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отложить можно было и на любой не-`created` ответ — правка короче и с виду
 * надёжнее. Но «строка уже есть» — обычный ход вещей: так приходит каждое
 * второе письмо от уже знакомого незнакомца, и откладывать его значит
 * разбирать каждый такой кадр дважды и класть в журнал
 * `internet_frame_deferred_again`, по которому ищут настоящие отсрочки.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные исходы кадр не задерживают', () => {
  it('строка уже есть — разобрано, письмо записано', async () => {
    mockEnsureResult = 'exists';

    expect(await deliver('привет, это я')).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
    // Про переподписку здесь нарочно не спрашиваем: прежний код читал ответ
    // как `boolean`, и любое слово было для него «завёл». Что переподписка
    // случается ровно на заведённой строке, стерегут две соседние проверки.
  });

  it('строку завели — разобрано, и на топик подписались', async () => {
    expect(await deliver('привет, это я')).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('заблокированный до заведения строки не доходит — и это не отсрочка', async () => {
    mockBlocked.current = true;
    mockEnsureResult = 'failed';

    expect(await deliver('я вернулся')).toBe('consumed');
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

describe('форма исходников: исход заведения прочитан', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const CONTACTS = fs
    .readFileSync(path.join(__dirname, '..', 'contacts.ts'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('приём различает отказ базы и «заводить нечего»', () => {
    expect(CODE).toContain("if (made === 'failed') {");
    const at = CODE.indexOf("if (made === 'failed') {");
    expect(CODE.slice(at, at + 220)).toContain("return 'deferred';");
    expect(CODE).toContain("if (made === 'created') await this.refreshSubscriptions();");
  });

  it('слово об исходе рождается там же, где строка', () => {
    expect(CONTACTS).toContain('export type ImplicitContactOutcome =');
    expect(CONTACTS).toContain("      return 'failed';");
    expect(CONTACTS).toContain("    return 'created';");
    // Прежний двусмысленный ответ ушёл вместе с типом.
    expect(CONTACTS).not.toContain(
      '  displayName?: string\n): Promise<boolean> {'
    );
  });
});
