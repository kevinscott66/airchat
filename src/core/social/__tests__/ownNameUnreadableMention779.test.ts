/**
 * Нечитаемое своё имя больше не значит «меня не звали» (v4.32.779).
 *
 * Приём группового сообщения решает по двум своим именам — отображаемому и
 * `@username`, — упоминание это или нет. От ответа зависят бейдж упоминания,
 * счётчик и push, который пробивает выключенные уведомления групп.
 *
 * Отображаемое имя читалось строчной формой `getOwnDisplayNameFor`: она ловит
 * отказ базы и отвечает `null` — тем же самым, чем отвечает «имени нет вовсе».
 * Здесь из этих двух ответов делается вывод НАОБОРОТ: раз имени нет, значит по
 * нему не звали. Занятая на секунду база съедала упоминание навсегда — кадр
 * уходил `'consumed'`, а взяться второй раз бейджу неоткуда: повтор конверта
 * отвечает `'duplicate'` и до подсчёта не доходит.
 *
 * Канонический `@username` этой болезни не знал: `getOwnUsernameFor` свой отказ
 * не гасит, и с v4.32.775 он откладывает кадр. Теперь так же ведёт себя и
 * отображаемое имя — через различающую форму `getOwnDisplayNameTryFor`, пару к
 * уже существовавшей `getOwnUsernameTryFor`.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean;
};

/** Аргументы общей записи: строка и описание следа. */
const mockCalls: Array<{ row: { id: string }; touch: Record<string, unknown> }> = [];
/** Что отвечает чтение отображаемого имени. */
let mockDisplay: { name: string | null } | null = { name: 'Аня' };

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async () => mockGroupRow),
  getGroupRead: jest.fn(async () => ({ state: 'found', value: mockGroupRow })),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => mockMembers),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessage: jest.fn(async () => true),
  insertGroupMessageChecked: jest.fn(async () => 'inserted'),
  insertGroupMessageWithTouch: jest.fn(
    async (row: { id: string }, touch: Record<string, unknown>) => {
      mockCalls.push({ row, touch });
      return 'inserted';
    },
  ),
  touchGroupConversation: jest.fn(async () => {}),
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
  getOwnDisplayNameFor: async () => 'Аня',
  getOwnDisplayName: async () => 'Аня',
  getOwnDisplayNameTryFor: async () => mockDisplay,
  getOwnUsernameFor: async () => 'anya',
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
import { join } from 'path';
import { encodeGroupMsgEnvelope, handleIncomingGroupEnvelope } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';

const mockLog = (jest.requireMock('../../logger') as {
  log: { warn: jest.Mock };
}).log;

const GID = 'g-779';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);

const mockMembers = [
  { peerPubB64: ME, role: 'owner', ownerProfileId: 1 },
  { peerPubB64: PEER, role: 'member', ownerProfileId: 1 },
];

const mockGroupRow: FakeGroup = {
  id: GID, ownerProfileId: 1, name: 'Двор', type: 'group',
  archived: false, isAdmin: true, adminOnlyPosting: false,
};

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Сообщение участника PEER с заданным текстом. */
function message(text: string, msgId = 'm-1'): string {
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

const GRP = codeOnly(readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8'));
const OWN = codeOnly(readFileSync(join(__dirname, '..', '..', 'identity', 'ownProfile.ts'), 'utf8'));

beforeEach(() => {
  mockDisplay = { name: 'Аня' };
  mockCalls.length = 0;
  jest.clearAllMocks();
});

describe('нечитаемое отображаемое имя откладывает кадр', () => {
  it('обращение по имени не объявляется «не упоминанием»', async () => {
    mockDisplay = null;

    expect(await handleIncomingGroupEnvelope(message('@Аня зайди'), RCPT, PEER)).toBe('deferred');
    expect(mockLog.warn).toHaveBeenCalledWith('group_msg_own_names_failed', expect.any(Object));
  });

  it('и не оставляет за собой ни строки, ни следа в списке чатов', async () => {
    mockDisplay = null;

    await handleIncomingGroupEnvelope(message('@Аня зайди'), RCPT, PEER);

    expect(mockCalls).toEqual([]);
  });

  it('следующий проход по читаемому имени поднимает бейдж', async () => {
    mockDisplay = null;
    await handleIncomingGroupEnvelope(message('@Аня зайди'), RCPT, PEER);

    mockDisplay = { name: 'Аня' };
    expect(await handleIncomingGroupEnvelope(message('@Аня зайди'), RCPT, PEER)).toBe('consumed');
    expect(mockCalls[0].touch.incrementMention).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: твёрдое «имени нет» кадр не откладывает', () => {
  it('профиль без имени разбирает сообщение как обычно', async () => {
    mockDisplay = { name: null };

    expect(await handleIncomingGroupEnvelope(message('всем привет'), RCPT, PEER)).toBe('consumed');
    expect(mockCalls).toHaveLength(1);
    expect(mockCalls[0].touch.incrementMention).toBe(false);
  });

  it('у безымянного профиля обращение по @username всё равно считается', async () => {
    mockDisplay = { name: null };

    await handleIncomingGroupEnvelope(message('@anya глянь'), RCPT, PEER);

    expect(mockCalls[0].touch.incrementMention).toBe(true);
  });

  it('читаемое имя по-прежнему поднимает бейдж', async () => {
    await handleIncomingGroupEnvelope(message('@Аня глянь'), RCPT, PEER);

    expect(mockCalls[0].touch.incrementMention).toBe(true);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('подсчёт упоминаний читает различающей формой, а не строчной', () => {
    const at = GRP.indexOf('let myNames:');
    expect(at).toBeGreaterThan(0);
    const block = GRP.slice(at, GRP.indexOf('const isMention =', at));
    expect(block).toContain('await getOwnDisplayNameTryFor(pid)');
    expect(block).not.toContain('await getOwnDisplayNameFor(pid)');
  });

  it('различающая форма отделяет «не открылось» от «нет записи»', () => {
    const body = OWN.slice(
      OWN.indexOf('export async function getOwnDisplayNameTryFor('),
      OWN.indexOf('export async function getOwnUsername(')
    );
    expect(body).toContain('if (cell === null) return null;');
    expect(body).toContain('return { name: sanitizeOwnDisplayName(profileManager.getProfileName(pid)) || null };');
    // ПРОВЕРКА НЕ ПУСТАЯ: строчная форма осталась — её читают четыре места,
    // которым «показать нечего» довольно.
    expect(OWN).toContain('export async function getOwnDisplayNameFor(');
  });
});
