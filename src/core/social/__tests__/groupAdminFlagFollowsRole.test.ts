/**
 * Назначенный администратор получает права, а не подпись (v4.32.512).
 *
 * Дефект. В строке группы есть колонка `is_admin` — «я здесь администратор».
 * Пишет её ровно одно место, `createGroup`, в момент появления группы. Дальше
 * она не менялась НИКОГДА: повышение зовёт `updateGroupMemberRole` и правит
 * только `group_members`. Две записи об одном и том же разъезжались в обе
 * стороны.
 *
 * Повысили — в `group_members` роль 'admin', в `groups.is_admin` ноль.
 * Системная строка «теперь администратор» написана, подпись в списке
 * участников стоит, а прав нет: заявки на вступление такой администратор
 * молча выбрасывал (обе дороги — и личное сообщение '\x0agjr:', и конверт
 * 'join'), вступивших по ссылке остальным не пересказывал, сброс ссылки не
 * принимал, отказ по отозванной ссылке не отправлял. Со стороны заявителя это
 * ровно немота: заявка ушла, ответа нет, спросить некого.
 *
 * Понизили — зеркально: роль 'member', флаг остался единицей. Экран группы
 * читал флаг ПЕРВЫМ (`if (amAdmin) return 'admin'`), поэтому понизившийся —
 * и даже забаненный — видел у себя полный набор админских кнопок, нажимал их
 * и получал системную строку у себя и ноль последствий у остальных: их
 * устройства спрашивают роль у `group_members`.
 *
 * Здесь проверяется живой приём: заявка доходит до повышенного и не доходит
 * до понижённого, флаг догоняет собственную роль, а BEFORE-раздел показывает,
 * чем отвечал прежний вопрос.
 */
type FakeGroup = {
  id: string;
  ownerProfileId: number;
  name: string;
  type: 'group' | 'channel' | 'supergroup';
  archived: boolean;
  isAdmin: boolean;
  requireApproval?: boolean;
  adminOnlyPosting?: boolean;
  anonymousPosting?: boolean;
  inviteToken?: string | null;
  slowModeSeconds?: number;
  disappearAfterMs?: number | null;
};

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, Array<{ peerPubB64: string; role: string; ownerProfileId: number }>> = {};
const mockJoinRequests: unknown[][] = [];
const mockRoleWrites: Array<{ peerPubB64: string; role: string }> = [];
const mockMetaPatches: Array<Record<string, unknown>> = [];

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async (id: string, pid: number) =>
    mockGroups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null),
  listGroupMembers: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  getGroupMessageTarget: jest.fn(async () => null),
  insertGroupMessage: jest.fn(async () => {}),
  updateGroupMessageText: jest.fn(async () => true),
  deleteGroupMessage: jest.fn(async () => {}),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  insertGroupJoinRequest: jest.fn(async (...a: unknown[]) => {
    mockJoinRequests.push(a);
    return { created: true };
  }),
  createGroup: jest.fn(async () => {}),
  upsertGroupMember: jest.fn(async () => {}),
  updateGroupMemberRole: jest.fn(async (gid: string, peerPubB64: string, role: string) => {
    mockRoleWrites.push({ peerPubB64, role });
    const row = (mockMembers[gid] ?? []).find((m) => m.peerPubB64 === peerPubB64);
    if (row) row.role = role;
  }),
  removeGroupMember: jest.fn(async (gid: string, peerPubB64: string) => {
    mockMembers[gid] = (mockMembers[gid] ?? []).filter((m) => m.peerPubB64 !== peerPubB64);
  }),
  updateGroupMeta: jest.fn(async (id: string, pid: number, patch: Record<string, unknown>) => {
    mockMetaPatches.push(patch);
    const g = mockGroups.find((x) => x.id === id && x.ownerProfileId === pid);
    if (g && patch.isAdmin !== undefined) g.isAdmin = !!patch.isAdmin;
  }),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
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
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async () => false,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  GROUP_JOIN_REQUEST_PREFIX,
  handleIncomingGroupControl,
  handleIncomingGroupJoinRequest,
} from '../groupMessaging';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { isAdminRole, ownGroupRole } from '../ownGroupRole';
import { getGroup, listGroupMembers } from '../../storage/local';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-promoted-1';
const ME = 'M'.repeat(43);
const OWNER = 'W'.repeat(43);
const STRANGER = 'S'.repeat(43);
const PID = 1;

const RCPT = {
  pid: PID,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/**
 * Группа, в которую мы вступили по ссылке (`is_admin = 0`), и наша роль в ней
 * задаётся отдельно — ровно так расходились две записи.
 */
function group(myRole: string, storedIsAdmin: boolean, extra: Partial<FakeGroup> = {}): void {
  mockGroups.push({
    id: GID,
    ownerProfileId: PID,
    name: 'Двор',
    type: 'group',
    archived: false,
    isAdmin: storedIsAdmin,
    inviteToken: null,
    ...extra,
  });
  mockMembers[GID] = [
    { peerPubB64: OWNER, role: 'owner', ownerProfileId: PID },
    { peerPubB64: ME, role: myRole, ownerProfileId: PID },
  ];
}

function joinRequestDm(): string {
  return GROUP_JOIN_REQUEST_PREFIX + JSON.stringify({
    groupId: GID,
    groupName: 'Двор',
    requesterPubB64: STRANGER,
    requesterName: 'Гость',
    ts: Date.now(),
  });
}

function joinCtl(): string {
  return encodeGroupCtlEnvelope({
    op: 'join',
    groupId: GID,
    target: STRANGER,
    targetName: 'Гость',
    ts: Date.now(),
    actorName: 'Гость',
  });
}

function roleCtl(target: string, role: 'admin' | 'member' | 'restricted'): string {
  return encodeGroupCtlEnvelope({
    op: 'role',
    groupId: GID,
    target,
    role,
    targetName: 'Кто-то',
    ts: Date.now(),
    actorName: 'Хозяин',
  });
}

function opCtl(op: 'ban' | 'unban' | 'kick', target: string): string {
  return encodeGroupCtlEnvelope({
    op,
    groupId: GID,
    target,
    targetName: 'Кто-то',
    ts: Date.now(),
    actorName: 'Хозяин',
  });
}

beforeEach(() => {
  mockGroups.length = 0;
  mockJoinRequests.length = 0;
  mockRoleWrites.length = 0;
  mockMetaPatches.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  jest.clearAllMocks();
});

describe('заявка на вступление приходит к тому, кто вправе её разобрать', () => {
  it('повышенный администратор её получает, хотя флаг группы не менялся', async () => {
    group('admin', false, { requireApproval: true });
    await handleIncomingGroupJoinRequest(joinRequestDm(), RCPT, STRANGER);
    expect(mockJoinRequests).toHaveLength(1);
  });

  it('и тем же путём — управляющим конвертом от вступившего по ссылке', async () => {
    group('admin', false, { requireApproval: true });
    await handleIncomingGroupControl(joinCtl(), RCPT, STRANGER);
    expect(mockJoinRequests).toHaveLength(1);
  });

  it('понижённый администратор её больше не получает', async () => {
    // Обратная сторона той же рассинхронизации: флаг остался с создания
    // группы, роль давно 'member'. Разбирать заявку нечем — кнопки у него
    // есть только на своём экране.
    group('member', true, { requireApproval: true });
    await handleIncomingGroupJoinRequest(joinRequestDm(), RCPT, STRANGER);
    await handleIncomingGroupControl(joinCtl(), RCPT, STRANGER);
    expect(mockJoinRequests).toEqual([]);
  });

  it('владелец получает её как и раньше', async () => {
    group('owner', true, { requireApproval: true });
    await handleIncomingGroupJoinRequest(joinRequestDm(), RCPT, STRANGER);
    expect(mockJoinRequests).toHaveLength(1);
  });

  it('рядовой участник — нет, и это правило не изменилось', async () => {
    group('member', false, { requireApproval: true });
    await handleIncomingGroupJoinRequest(joinRequestDm(), RCPT, STRANGER);
    expect(mockJoinRequests).toEqual([]);
  });

  it('без своей строки в списке отвечает флаг — списка ещё нет', async () => {
    // Запасной ответ: у группы, созданной до появления собственной строки
    // участника, спрашивать в таблице нечего.
    mockGroups.push({
      id: GID, ownerProfileId: PID, name: 'Двор', type: 'group',
      archived: false, isAdmin: true, requireApproval: true, inviteToken: null,
    });
    mockMembers[GID] = [{ peerPubB64: OWNER, role: 'owner', ownerProfileId: PID }];
    await handleIncomingGroupJoinRequest(joinRequestDm(), RCPT, STRANGER);
    expect(mockJoinRequests).toHaveLength(1);
  });
});

describe('флаг группы догоняет собственную роль', () => {
  it('повышение записывает is_admin = true', async () => {
    group('member', false);
    await handleIncomingGroupControl(roleCtl(ME, 'admin'), RCPT, OWNER);
    expect(mockRoleWrites).toEqual([{ peerPubB64: ME, role: 'admin' }]);
    expect(mockMetaPatches).toEqual([{ isAdmin: true }]);
  });

  it('понижение записывает is_admin = false', async () => {
    group('admin', true);
    await handleIncomingGroupControl(roleCtl(ME, 'member'), RCPT, OWNER);
    expect(mockMetaPatches).toEqual([{ isAdmin: false }]);
  });

  it('«только чтение» тоже снимает права', async () => {
    group('admin', true);
    await handleIncomingGroupControl(roleCtl(ME, 'restricted'), RCPT, OWNER);
    expect(mockMetaPatches).toEqual([{ isAdmin: false }]);
  });

  it('бан и исключение снимают их же', async () => {
    group('admin', true);
    await handleIncomingGroupControl(opCtl('ban', ME), RCPT, OWNER);
    expect(mockMetaPatches).toEqual([{ isAdmin: false }]);

    mockMetaPatches.length = 0;
    mockGroups.length = 0;
    mockMembers[GID] = [];
    group('admin', true);
    await handleIncomingGroupControl(opCtl('kick', ME), RCPT, OWNER);
    expect(mockMetaPatches).toEqual([{ isAdmin: false }]);
  });

  it('чужое повышение своего флага не трогает', async () => {
    group('member', false);
    mockMembers[GID].push({ peerPubB64: STRANGER, role: 'member', ownerProfileId: PID });
    await handleIncomingGroupControl(roleCtl(STRANGER, 'admin'), RCPT, OWNER);
    expect(mockRoleWrites).toEqual([{ peerPubB64: STRANGER, role: 'admin' }]);
    expect(mockMetaPatches).toEqual([]);
  });

  it('повтор той же роли не пишет ничего — конверт мог прийти дважды', async () => {
    group('admin', true);
    await handleIncomingGroupControl(roleCtl(ME, 'admin'), RCPT, OWNER);
    expect(mockRoleWrites).toEqual([]);
    expect(mockMetaPatches).toEqual([]);
  });

  it('флаг и роль сходятся: после повышения заявки начинают доходить', async () => {
    // Сквозная проверка того, ради чего всё: одним конвертом человек
    // становится администратором и тут же им работает.
    group('member', false, { requireApproval: true });
    await handleIncomingGroupJoinRequest(joinRequestDm(), RCPT, STRANGER);
    expect(mockJoinRequests).toEqual([]);

    await handleIncomingGroupControl(roleCtl(ME, 'admin'), RCPT, OWNER);
    await handleIncomingGroupJoinRequest(joinRequestDm(), RCPT, STRANGER);
    expect(mockJoinRequests).toHaveLength(1);
  });
});

describe('BEFORE — чем отвечал прежний вопрос', () => {
  it('колонка группы и роль участника отвечали по-разному', async () => {
    // Состояние после повышения, каким его видела база до этой правки:
    // updateGroupMemberRole записал роль, колонку не тронул никто.
    group('admin', false);
    const row = await getGroup(GID, PID);
    const mine = (await listGroupMembers(GID, PID)).find((m) => m.peerPubB64 === ME);

    expect(mine?.role).toBe('admin');   // так нас видят все остальные участники
    expect(row?.isAdmin).toBe(false);   // а так — прежняя строка приёма у нас
    expect(row?.isAdmin).not.toBe(isAdminRole(ownGroupRole(await listGroupMembers(GID, PID), ME, false)));
  });

  it('и в обратную сторону — у понижённого', async () => {
    group('member', true);
    const row = await getGroup(GID, PID);
    expect(row?.isAdmin).toBe(true);
    expect(isAdminRole(ownGroupRole(await listGroupMembers(GID, PID), ME, true))).toBe(false);
  });
});
