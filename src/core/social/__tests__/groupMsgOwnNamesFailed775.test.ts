/**
 * Приёмник группы кладёт строку и след в списке чатов одной операцией (v4.32.775).
 *
 * Раньше приёмник писал строку сообщения, а потом отдельным вызовом двигал
 * список переписок: счётчик непрочитанного, бейдж упоминания, превью и имя
 * отправителя. Тот вызов — `touchGroupConversation` — свой отказ гасил сам и
 * отвечал `void`, поэтому занятая база съедала весь след молча: сообщение
 * лежало внутри группы, а в списке чатов не было ни «новых», ни текста.
 * Перезапросить кадр было нечем: повтор конверта отвечает `'duplicate'` и до
 * следа не доходит вовсе — так задумано с v4.32.581, чтобы повтор не поднимал
 * счётчик со вчерашним текстом.
 *
 * Теперь обе записи идут одной транзакцией (`insertGroupMessageWithTouch`), и
 * `'failed'` честно значит «не произошло ничего, спрашивайте снова».
 *
 * Второй повод: свои имена (отображаемое и username) читались из базы уже
 * ПОСЛЕ записи строки, а `getOwnUsernameFor` свой отказ не гасит. Его ошибка
 * прилетала в общий catch — и кадр уходил `'consumed'` с сообщением в базе, но
 * без следа в списке. Считать при отказе «упоминания нет» нельзя: бейдж
 * упоминания второй раз взяться неоткуда. Поэтому чтение стоит до записи, а
 * отказ откладывает кадр.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean;
  anonymousPosting?: boolean;
};

/** Исход общей записи: как у настоящей insertGroupMessageWithTouch. */
let mockWrite: 'inserted' | 'duplicate' | 'failed' = 'inserted';
/** Аргументы общей записи: строка и описание следа. */
const mockCalls: Array<{ row: { id: string }; touch: Record<string, unknown> }> = [];
/** Порядок обращений: чтение имён должно стоять до записи. */
const mockOrder: string[] = [];
/** Уронить ли чтение канонического имени. */
let mockUsernameThrows = false;

let mockGroupRow: FakeGroup | null = null;

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async () => mockGroupRow),
  getGroupRead: jest.fn(async () =>
    mockGroupRow ? { state: 'found', value: mockGroupRow } : { state: 'missing' }),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => mockMembers),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessage: jest.fn(async () => mockWrite === 'inserted'),
  insertGroupMessageChecked: jest.fn(async () => mockWrite),
  insertGroupMessageWithTouch: jest.fn(
    async (row: { id: string }, touch: Record<string, unknown>) => {
      mockOrder.push('write');
      if (mockWrite === 'inserted') mockCalls.push({ row, touch });
      return mockWrite;
    },
  ),
  touchGroupConversation: jest.fn(async () => { mockOrder.push('touch'); }),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  createGroup: jest.fn(async () => {}),
  upsertGroupMember: jest.fn(async () => {}),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => { mockOrder.push('name'); return 'Аня'; },
  // v4.32.779: приём читает своё отображаемое имя различающей формой.
  getOwnDisplayNameTryFor: async () => { mockOrder.push('name'); return { name: 'Аня' }; },
  getOwnDisplayName: async () => 'Аня',
  getOwnUsernameFor: async () => {
    mockOrder.push('username');
    if (mockUsernameThrows) throw new Error('database is locked');
    return 'anya';
  },
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: async () => {}, groupRecipient: async () => null }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [{ peerPublicKey: 'P'.repeat(43) }] }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async () => false,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join as pathJoin } from 'path';
import { encodeGroupMsgEnvelope, handleIncomingGroupEnvelope } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';

const mockLog = (jest.requireMock('../../logger') as {
  log: { warn: jest.Mock; debug: jest.Mock; info: jest.Mock; error: jest.Mock };
}).log;

const GID = 'g-775';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);

const mockMembers = [
  { peerPubB64: ME, role: 'owner', ownerProfileId: 1 },
  { peerPubB64: PEER, role: 'member', ownerProfileId: 1 },
];

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, которую мы знаем; отправитель в ней состоит. */
function known(): FakeGroup {
  return {
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group',
    archived: false, isAdmin: true, adminOnlyPosting: false,
  };
}

/** Обычное сообщение участника PEER. */
function message(text = 'встречаемся в семь', msgId = 'm-1'): string {
  return encodeGroupMsgEnvelope({
    groupId: GID,
    msgId,
    senderName: 'Пётр',
    senderPubB64: PEER,
    text,
    ts: Date.now(),
  });
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

const GRP = codeOnly(readFileSync(pathJoin(__dirname, '..', 'groupMessaging.ts'), 'utf8'));

beforeEach(() => {
  mockGroupRow = known();
  mockWrite = 'inserted';
  mockUsernameThrows = false;
  mockCalls.length = 0;
  mockOrder.length = 0;
  jest.clearAllMocks();
});

describe('след ложится той же операцией, что и строка', () => {
  it('счётчик, бейдж и превью уходят в запись, а не отдельным вызовом', async () => {
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('consumed');
    expect(mockCalls).toHaveLength(1);
    expect(mockCalls[0].touch).toEqual({
      groupId: GID,
      ownerProfileId: 1,
      preview: 'встречаемся в семь',
      incrementUnread: true,
      senderName: 'Пётр',
      incrementMention: false,
      senderPubB64: PEER,
    });
    // Отдельного сдвига списка приёмник больше не делает.
    expect(mockOrder).not.toContain('touch');
  });

  it('упоминание считается до записи и уезжает в неё же', async () => {
    await handleIncomingGroupEnvelope(message('привет @anya, ты идёшь?'), RCPT, PEER);
    expect(mockCalls[0].touch.incrementMention).toBe(true);
    expect(mockOrder.indexOf('username')).toBeLessThan(mockOrder.indexOf('write'));
  });

  it('отказ общей записи откладывает кадр целиком', async () => {
    mockWrite = 'failed';
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('deferred');
    expect(mockLog.warn).toHaveBeenCalledWith('group_msg_save_failed_defer', expect.any(Object));
  });
});

describe('свои имена читаются до записи', () => {
  it('нечитаемое каноническое имя откладывает кадр, а не теряет бейдж', async () => {
    mockUsernameThrows = true;
    expect(await handleIncomingGroupEnvelope(message('@anya глянь'), RCPT, PEER)).toBe('deferred');
    expect(mockLog.warn).toHaveBeenCalledWith('group_msg_own_names_failed', expect.any(Object));
  });

  it('и не оставляет за собой ни строки, ни следа', async () => {
    mockUsernameThrows = true;
    await handleIncomingGroupEnvelope(message('@anya глянь'), RCPT, PEER);
    expect(mockCalls).toEqual([]);
    expect(mockOrder).not.toContain('write');
  });

  it('отказ назван отказом, а не «сообщение применить не вышло»', async () => {
    mockUsernameThrows = true;
    await handleIncomingGroupEnvelope(message(), RCPT, PEER);
    expect(mockLog.error).not.toHaveBeenCalledWith('group_msg_apply_failed', expect.anything());
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы на месте', () => {
  it('повтор конверта по-прежнему разобран и следа не двигает', async () => {
    mockWrite = 'duplicate';
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('consumed');
    expect(mockCalls).toEqual([]);
    expect(mockLog.debug).toHaveBeenCalledWith('group_msg_duplicate_skip', expect.any(Object));
  });

  it('анонимная группа по-прежнему прячет имя из списка чатов', async () => {
    mockGroupRow = { ...known(), anonymousPosting: true };
    await handleIncomingGroupEnvelope(message(), RCPT, PEER);
    expect(mockCalls[0].touch.senderName).toBeNull();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отдельного сдвига списка в приёмнике не осталось', () => {
    expect(GRP).toContain('const stored = await insertGroupMessageWithTouch(row, {');
    expect(GRP).not.toContain('await touchGroupConversation(');
    expect(GRP).not.toContain('void touchGroupConversation(');
  });

  it('имена читаются выше записи и их отказ разобран на месте', () => {
    const names = GRP.indexOf('await getOwnUsernameFor(pid)');
    const write = GRP.indexOf('await insertGroupMessageWithTouch(row, {');
    expect(names).toBeGreaterThan(0);
    expect(names).toBeLessThan(write);
    // Разбор стоит между ними: отказ имени не доезжает до общего catch.
    expect(GRP.slice(names, write)).toContain("log.warn('group_msg_own_names_failed'");
  });
});
