/**
 * Упавший разбор отравлял память «уже видели», и повтор кадра рапортовал
 * «разобрано» (v4.32.832).
 *
 * Дефект. Отметка `seenMessageIds` ставится ПЕРЕД разбором — иначе один кадр
 * разбирался бы трижды, входов у него три. Снимала её обёртка ровно на одном
 * слове — `'deferred'`. А не разобрать конверт можно двумя способами, и второй
 * — брошенное исключение — обёртка не знала вовсе. Оно тут не редкость:
 * групповой конверт едет этой же дорогой и заканчивается в `upsertGroupMember`
 * и `updateGroupMeta`, где занятая база выходит наружу исключением; а
 * `ownerProfileId` на холодном старте поднимает профили и бросает СОЗНАТЕЛЬНО —
 * чтобы кадр перезапросили.
 *
 * Цена. Координатор в этой связке делал всё правильно: ловил брошенное,
 * удерживал отметку «докуда прочитано», ждал повтора. Повтор приходил — и
 * упирался первой же строкой в метку, поставленную упавшей попыткой. Ответ —
 * `'consumed'`, отметка идёт дальше, назад она не ходит. Смена названия группы,
 * приём и исключение участника, личное сообщение — пропадали навсегда, и в
 * журнале от второго захода не оставалось ни строчки: заход кончался на самой
 * первой. То есть единственная лишняя попытка, ради которой весь механизм и
 * заведён, тратилась впустую при каждом падении.
 *
 * Правка. Помеченным конверт остаётся, только если разбор ДОШЁЛ до конца и
 * сказал «разобрал». Брошенное — это тоже «не смог»: метку снимаем, само
 * исключение отдаём наружу как есть, потому что удержание отметки построено
 * именно на нём. Образец дисциплины рядом — ленты (`feedService`), где вокруг
 * метки стоит `try/catch` с `feedSeenForget`.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Что сделает обработчик группы на очередном заходе. */
let mockGroupOutcome: 'throw' | 'consumed' | 'deferred' = 'consumed';
/** Сколько раз разбор реально дошёл до обработчика. */
let mockGroupCalls = 0;
/** Ворота: придержать разбор посередине и отпустить его по команде прогона. */
const mockGate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };

/** Строки, дошедшие до записи. */
const mockSaved: Record<string, unknown>[] = [];
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

/**
 * Обработчик группы: занятая база, отсрочка или удача — по выбору прогона.
 *
 * Именно он и есть настоящее место падения: разбор группового конверта
 * заканчивается записью состава и названия, и SQLITE_BUSY оттуда выходит
 * исключением, а не ответом.
 */
jest.mock('../groupMessaging', () => ({
  handleIncomingGroupEnvelope: async (): Promise<string> => {
    mockGroupCalls += 1;
    if (mockGate.hold) await new Promise<void>((r) => { mockGate.release = r; });
    if (mockGroupOutcome === 'throw') throw new Error('SQLITE_BUSY: database is locked');
    return mockGroupOutcome;
  },
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
let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `u${++mockUuid}` }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { publicKeyToDidKey } from '../../identity/did';
import { MessagingService } from '../messaging';

const ME = new Uint8Array(32).fill(1);
const PEER = new Uint8Array(32).fill(2);
const myPair = { publicKey: ME, secretKey: new Uint8Array(64).fill(1) };
const MY_DID = publicKeyToDidKey(ME);
const PEER_DID = publicKeyToDidKey(PEER);

/** Один и тот же кадр: relay отдаёт его снова, идентификатор не меняется. */
const SAME = 'm-one-and-the-same';
/** Переименование группы — обычный конверт, едущий личным транспортом. */
const GRP = '\x02grp:{"groupId":"g1","msgId":"x","text":"привет"}';

/**
 * Служба одна на весь прогон: память «уже видели» живёт в экземпляре, и второй
 * заход обязан быть заходом в ТУ ЖЕ службу — иначе проверять нечего.
 */
let svc: MessagingService;

/** Отдать службе конверт — с названным идентификатором и содержимым. */
function deliver(text = GRP, messageId = SAME): Promise<string> {
  const ts = Date.now();
  mockEnvelope.current = {
    messageId,
    senderDid: PEER_DID,
    recipientDid: MY_DID,
    encryptedContent: new TextEncoder().encode(JSON.stringify({ text, _ts: ts })),
    timestamp: ts,
  };
  return svc.receiveDirectLanEnvelope(new Uint8Array([1]), PEER_DID);
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockGroupOutcome = 'consumed';
  mockGroupCalls = 0;
  mockGate.hold = false;
  mockGate.release = null;
  mockSaved.length = 0;
  svc = new MessagingService(myPair);
});

describe('упавший разбор не съедает повтор кадра', () => {
  it('после занятой базы тот же кадр разбирается снова', async () => {
    mockGroupOutcome = 'throw';
    await expect(deliver()).rejects.toThrow('SQLITE_BUSY');

    // Relay отдаёт кадр повторно, база к этому разу открылась.
    mockGroupOutcome = 'consumed';
    expect(await deliver()).toBe('consumed');
    // Главное здесь — двойка: до правки второй заход обрывался на метке и до
    // обработчика не доходил вовсе.
    expect(mockGroupCalls).toBe(2);
  });

  it('исключение уходит наружу как есть — на нём держится отметка кадра', async () => {
    mockGroupOutcome = 'throw';
    // Проглотить его нельзя: координатор отличает провал от удачи только так,
    // и проглоченное стало бы «разобрано».
    await expect(deliver()).rejects.toThrow('SQLITE_BUSY: database is locked');
  });

  it('падать может и подряд — метка не накапливается', async () => {
    mockGroupOutcome = 'throw';
    await expect(deliver()).rejects.toThrow();
    await expect(deliver()).rejects.toThrow();
    mockGroupOutcome = 'consumed';
    expect(await deliver()).toBe('consumed');
    expect(mockGroupCalls).toBe(3);
  });

  it('личное сообщение после падения на нём же — доходит и сохраняется', async () => {
    mockGroupOutcome = 'throw';
    await expect(deliver()).rejects.toThrow();
    // Тот же идентификатор, но уже обычный текст: кадр разбирается заново
    // целиком, а не отсекается меткой на входе.
    expect(await deliver('привет')).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ direction: 'in', text: 'привет' });
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Снятие метки — это не «перестать отсекать дубли». Отсечение обязано работать
 * ровно как раньше: иначе один конверт, приехавший с трёх входов, ляжет в
 * переписку трижды.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: настоящие дубли отсекаются по-прежнему', () => {
  it('разобранный кадр второй раз до обработчика не доходит', async () => {
    expect(await deliver()).toBe('consumed');
    expect(await deliver()).toBe('consumed');
    expect(mockGroupCalls).toBe(1);
  });

  it('разные кадры разбираются каждый сам по себе', async () => {
    expect(await deliver(GRP, 'm-1')).toBe('consumed');
    expect(await deliver(GRP, 'm-2')).toBe('consumed');
    expect(mockGroupCalls).toBe(2);
  });

  it('личное сообщение не задваивается', async () => {
    expect(await deliver('привет')).toBe('consumed');
    expect(await deliver('привет')).toBe('consumed');
    expect(mockSaved).toHaveLength(1);
  });

  it('«отложено» по-прежнему возвращает кадр памяти повторов (v4.32.790)', async () => {
    mockGroupOutcome = 'deferred';
    expect(await deliver()).toBe('deferred');
    mockGroupOutcome = 'consumed';
    expect(await deliver()).toBe('consumed');
    expect(mockGroupCalls).toBe(2);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Всё держится на трёх фактах, и каждый проверяется отдельно: метка ставится ДО
 * работы; разбор действительно может упасть исключением, а не ответом; кадр
 * после падения действительно приходит снова.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('метка стоит раньше разбора: сосед по кадру отсекается, пока первый ещё идёт', async () => {
    mockGate.hold = true;
    const first = deliver();
    await tick();
    // Разбор ещё не закончился, а второй экземпляр уже отвечает «разобрано» —
    // значит метка поставлена до работы, и снимать её после падения обязан
    // кто-то другой.
    expect(await deliver()).toBe('consumed');
    expect(mockGroupCalls).toBe(1);
    mockGate.hold = false;
    mockGate.release?.();
    expect(await first).toBe('consumed');
  });

  it('холодный старт поднимает профили и бросает сознательно', () => {
    const msg = fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');
    // Номер профиля выясняется внутри разбора, уже ПОСЛЕ метки.
    expect(msg).toContain('await profileManager.init();');
    expect(msg).toContain(
      "if (await chatMessageExists(em.messageId, await this.ownerProfileId())) return 'consumed';",
    );
    const pm = fs.readFileSync(
      path.join(__dirname, '..', '..', 'identity', 'profileManager.ts'),
      'utf8',
    );
    expect(pm).toContain('this.initPromise = null;\n      throw e;');
  });

  it('координатор ловит брошенное, удерживает отметку и ждёт повтора', () => {
    const coord = fs.readFileSync(
      path.join(__dirname, '..', '..', 'transport', 'internet', 'internetCoordinator.ts'),
      'utf8',
    );
    expect(coord).toContain("failure = e ?? new Error('unknown');");
    expect(coord).toContain('rememberFailure(frameAtMs);');
    expect(coord).toContain("log.warn('internet_frame_handle_failed', {");
  });
});

/** Рэтчет формы: снятие метки связано с исходом разбора, а не с местом в нём. */
describe('форма исходников: помеченным остаётся только разобранное', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');
  const wrapper = (): string => {
    const a = SRC.indexOf('  private async persistIncomingFromEnvelope(');
    const b = SRC.indexOf('  private async persistIncomingFromEnvelopeInner(', a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return SRC.slice(a, b);
  };

  it('обёртка снимает метку и на брошенном тоже', () => {
    expect(wrapper()).toContain('} catch (e) {');
    expect(wrapper()).toContain('this.seenMessageIds.delete(em.messageId);\n      throw e;');
  });

  it('и по-прежнему — на слове «отложено»', () => {
    expect(wrapper()).toContain(
      "if (verdict === 'deferred') this.seenMessageIds.delete(em.messageId);",
    );
  });

  it('образец дисциплины рядом — ленты — обёрнут точно так же', () => {
    const feed = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
    expect(feed).toContain('feedSeenForget(dedupKey);');
  });
});
