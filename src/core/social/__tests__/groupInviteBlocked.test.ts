/**
 * Заблокированный человек не заводит мне группу (v4.32.617).
 *
 * `\x0egctl:` переживает блокировку намеренно: состав и права группы задаются
 * ролями в ней, а не моим личным списком, и тихо выбрасывать бан или смену
 * роли от заблокированного администратора значит остаться со своим,
 * расходящимся представлением о группе (blockPolicy). Но у операции 'invite'
 * прежнего общего состояния нет — она применима именно к ЕЩЁ НЕ ИЗВЕСТНОЙ
 * группе. То есть через неё исключение работало ровно наоборот: удалённый и
 * заблокированный присылал один конверт и получал у меня новую группу с собой
 * в администраторах, а вместе с ней — право слать в неё сообщения, которые
 * тем же исключением тоже проходят.
 *
 * Второй путь в ту же дыру: доверие к отправителю проверялось по списку
 * контактов, а неявную строку в этом списке заводил его же конверт мгновением
 * раньше. Неявная строка — это «незнакомец однажды написал», в разделе
 * «Контакты» её не видно; считать её доверием значит отменять настройку
 * «Добавление в группы — только контакты».
 */
type FakeGroup = { id: string; ownerProfileId: number; name: string; type: 'group'; archived: boolean };
type FakeContact = { peerPublicKey: string; implicit?: boolean };

const mockGroups: FakeGroup[] = [];
const mockCreated: unknown[][] = [];
const mockUpserts: Array<{ peerPubB64: string; role: string }> = [];
const mockContacts: FakeContact[] = [];
const mockBlocked = new Set<string>();
let mockOnlyContacts: boolean | null = false;

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async (id: string, pid: number) =>
    mockGroups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => []),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessage: jest.fn(async () => true),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  createGroup: jest.fn(async (...a: unknown[]) => { mockCreated.push(a); }),
  upsertGroupMember: jest.fn(async (m: { peerPubB64: string; role: string }) => { mockUpserts.push(m); }),
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
  getOwnDisplayNameFor: async () => 'Я',
  getOwnDisplayName: async () => 'Я',
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: async () => {}, groupRecipient: async () => null }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: 0, failed: 0, skipped: 0 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => mockContacts }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: (p: string) => mockBlocked.has(p) },
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async () => mockOnlyContacts,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { handleIncomingGroupControl } from '../groupMessaging';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-new-1';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

function invite(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID,
    ts: Date.now(),
    op: 'invite',
    groupName: 'Двор',
    groupType: 'group',
    actorName: 'Пётр',
    members: [{ pub: PEER, name: 'Пётр', role: 'admin' }],
  } as never);
}

beforeEach(() => {
  mockGroups.length = 0;
  mockCreated.length = 0;
  mockUpserts.length = 0;
  mockContacts.length = 0;
  mockBlocked.clear();
  mockOnlyContacts = false;
  jest.clearAllMocks();
});

describe('приглашение в неизвестную группу', () => {
  it('от заблокированного не заводит группу', async () => {
    mockBlocked.add(PEER);
    await handleIncomingGroupControl(invite(), RCPT, PEER);
    expect(mockCreated).toEqual([]);
    expect(mockUpserts).toEqual([]);
  });

  it('проверка не пустая: от незаблокированного группа заводится', async () => {
    await handleIncomingGroupControl(invite(), RCPT, PEER);
    expect(mockCreated).toHaveLength(1);
    expect(mockUpserts.some((m) => m.peerPubB64 === PEER && m.role === 'admin')).toBe(true);
  });

  it('заблокированного не спасает и строка контакта', async () => {
    // Тот самый путь: конверт заводит неявную строку, она же сходит за доверие.
    mockBlocked.add(PEER);
    mockContacts.push({ peerPublicKey: PEER, implicit: true });
    await handleIncomingGroupControl(invite(), RCPT, PEER);
    expect(mockCreated).toEqual([]);
  });
});

describe('«только контакты» и неявные строки', () => {
  beforeEach(() => { mockOnlyContacts = true; });

  it('неявная строка за контакт не считается', async () => {
    mockContacts.push({ peerPublicKey: PEER, implicit: true });
    await handleIncomingGroupControl(invite(), RCPT, PEER);
    expect(mockCreated).toEqual([]);
  });

  it('проверка не пустая: явный контакт приглашает как прежде', async () => {
    mockContacts.push({ peerPublicKey: PEER });
    await handleIncomingGroupControl(invite(), RCPT, PEER);
    expect(mockCreated).toHaveLength(1);
  });
});
