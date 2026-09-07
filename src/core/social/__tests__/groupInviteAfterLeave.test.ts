/**
 * Повтор приглашения после выхода из группы (v4.32.621).
 *
 * `invite` — единственная операция, применимая к ещё не известной группе, и
 * от повтора её защищала ровно одна строка: `if (group) return true` —
 * «уже состоим, приглашение идемпотентно». Выход из группы эту защиту и
 * снимает: `deleteGroup` стирает строку, и `getGroup` отвечает null.
 *
 * Реле хранит конверты тридцать суток, темы выводятся из открытых DID, писать
 * в них может кто угодно. Те же байты, присланные ещё раз, заводили группу
 * заново — с прежним составом и прежними правами, — и `isInviteTrusted` этому
 * не мешала: приглашал контакт, а контакту она доверяет по определению.
 *
 * У каждой проверки здесь есть парная «BEFORE», показывающая, что прежнее
 * поведение действительно давало другой ответ.
 */
type FakeGroup = { id: string; ownerProfileId: number; name: string };

const mockGroups: FakeGroup[] = [];
const mockCreated: string[] = [];
/** Ключ — `${pid}|${key}`. */
const mockKv = new Map<string, string>();
/** Отвечает ли scoped kv вообще (null — «не прочиталось»). */
let mockKvReadable = true;
let mockContacts: () => Array<{ peerPublicKey: string; implicit?: boolean }> = () => [];

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) =>
    (mockKvReadable ? { value: mockKv.get(`${pid}|${key}`) ?? null } : null)),
  scopedKvSetFor: jest.fn(async (pid: number, key: string, value: string) => {
    mockKv.set(`${pid}|${key}`, value);
  }),
  scopedKvDeleteFor: jest.fn(async (pid: number, key: string) => {
    mockKv.delete(`${pid}|${key}`);
  }),
}));

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
  createGroup: jest.fn(async (id: string) => { mockCreated.push(id); }),
  upsertGroupMember: jest.fn(async () => {}),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => 'Я',
  getOwnDisplayName: async () => 'Я',
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: jest.fn(async () => 'echo'),
    groupRecipient: async () => ({ pid: 1, myPub: 'M'.repeat(43) }),
  }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: 0, failed: 0, skipped: 0 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => mockContacts() }));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async () => true,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';

import { handleIncomingGroupControl } from '../groupMessaging';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { clearGroupLeft, inviteNewerThanLeave, leaveMarkKey, markGroupLeft } from '../groupLeaveMark';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-leave-1';
const ME = 'M'.repeat(43);
const INVITER = 'A'.repeat(43);
const PID = 1;
const T_LEAVE = 1_700_000_000_000;

const RCPT = {
  pid: PID,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

function inviteEnv(ts: number): string {
  return encodeGroupCtlEnvelope({
    op: 'invite',
    groupId: GID,
    groupName: 'Двор',
    groupType: 'group',
    members: [{ pub: INVITER, name: 'Админ' }],
    ts,
    actorName: 'Админ',
  });
}

beforeEach(() => {
  mockGroups.length = 0;
  mockCreated.length = 0;
  mockKv.clear();
  mockKvReadable = true;
  // Пригласивший — обычный контакт: именно так `isInviteTrusted` и пропускает
  // приглашение. Без этого проверка ниже ничего не значила бы.
  mockContacts = () => [{ peerPublicKey: INVITER, implicit: false }];
});

describe('отметка выхода из группы', () => {
  it('без отметки любое приглашение считается новым', async () => {
    expect(await inviteNewerThanLeave(GID, PID, 1)).toBe(true);
  });

  it('приглашение старше выхода — повтор', async () => {
    await markGroupLeft(GID, PID, T_LEAVE);
    expect(mockKv.get(`${PID}|${leaveMarkKey(GID)}`)).toBe(String(T_LEAVE));
    expect(await inviteNewerThanLeave(GID, PID, T_LEAVE - 1)).toBe(false);
    expect(await inviteNewerThanLeave(GID, PID, T_LEAVE)).toBe(false);
  });

  it('приглашение новее выхода проходит', async () => {
    await markGroupLeft(GID, PID, T_LEAVE);
    expect(await inviteNewerThanLeave(GID, PID, T_LEAVE + 1)).toBe(true);
  });

  it('снятая отметка больше ничего не запрещает', async () => {
    await markGroupLeft(GID, PID, T_LEAVE);
    await clearGroupLeft(GID, PID);
    expect(await inviteNewerThanLeave(GID, PID, T_LEAVE - 1)).toBe(true);
  });

  it('нечитаемая база пропускает: у приглашения нет обратной связи', async () => {
    await markGroupLeft(GID, PID, T_LEAVE);
    mockKvReadable = false;
    expect(await inviteNewerThanLeave(GID, PID, T_LEAVE - 1)).toBe(true);
  });

  it('испорченное значение не запрещает ничего', async () => {
    mockKv.set(`${PID}|${leaveMarkKey(GID)}`, 'не число');
    expect(await inviteNewerThanLeave(GID, PID, T_LEAVE - 1)).toBe(true);
  });

  it('отметки разных профилей не пересекаются', async () => {
    await markGroupLeft(GID, PID, T_LEAVE);
    expect(await inviteNewerThanLeave(GID, 2, T_LEAVE - 1)).toBe(true);
  });
});

describe('ветка invite в обработчике группы', () => {
  it('BEFORE: без отметки повтор приглашения заводит группу заново', async () => {
    const applied = await handleIncomingGroupControl(inviteEnv(T_LEAVE - 60_000), RCPT, INVITER);
    expect(applied).toBe(true);
    expect(mockCreated).toEqual([GID]);
  });

  it('повтор приглашения, отправленного до выхода, группу не заводит', async () => {
    await markGroupLeft(GID, PID, T_LEAVE);
    const applied = await handleIncomingGroupControl(inviteEnv(T_LEAVE - 60_000), RCPT, INVITER);
    expect(applied).toBe(true);
    expect(mockCreated).toEqual([]);
  });

  it('новое приглашение после выхода принимается и снимает отметку', async () => {
    await markGroupLeft(GID, PID, T_LEAVE);
    await handleIncomingGroupControl(inviteEnv(T_LEAVE + 60_000), RCPT, INVITER);
    expect(mockCreated).toEqual([GID]);
    expect(mockKv.has(`${PID}|${leaveMarkKey(GID)}`)).toBe(false);
  });

  it('отметка не мешает, пока группа на месте', async () => {
    mockGroups.push({ id: GID, ownerProfileId: PID, name: 'Двор' });
    await markGroupLeft(GID, PID, T_LEAVE);
    const applied = await handleIncomingGroupControl(inviteEnv(T_LEAVE + 60_000), RCPT, INVITER);
    expect(applied).toBe(true);
    // Группа уже есть — приглашение идемпотентно, повторно её никто не заводит.
    expect(mockCreated).toEqual([]);
  });
});

describe('храповик: выход помечается до удаления строки', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
    'utf-8'
  );

  it('markGroupLeft вызывается перед deleteGroup', () => {
    const lines = SRC.split('\n');
    const mark = lines.findIndex((l) => l.includes('await markGroupLeft(g.id, pid);'));
    const del = lines.findIndex((l) => l.includes('await deleteGroup(g.id, pid);'));
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(mark);
  });
});
