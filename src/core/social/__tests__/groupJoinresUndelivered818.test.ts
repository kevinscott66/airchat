/**
 * Ответ заявителю не выбрасывается в пустоту (v4.32.818).
 *
 * Дефект. Обе ветки, отвечающие постороннему на его «я вступил по ссылке»,
 * звали `sendGroupControlTo` через `void`: и отказ по отозванной ссылке, и
 * «заявка ждёт одобрения». Функция отвечает `{ sent: false, reason }` — служба
 * переписки ещё не поднята, конверт не ушёл ни одному адресату, — но ответ
 * выбрасывался, и кадр объявлялся разобранным.
 *
 * Цена. Ровно та немота, ради ухода от которой ответ и заводили (v4.32.266):
 * человек, вошедший по устаревшей ссылке, у себя группу уже создал и видит
 * «Вы добавлены». Он пишет в неё, а его сообщения выбрасывает анти-спуф-фильтр
 * на каждом устройстве — без единого признака, в чём дело. Повторов у
 * управляющего конверта нет: не дошедший ответ не досылает никто.
 *
 * Правка. Исход отправки читается, а неудача откладывает кадр — он полежит на
 * relay и придёт снова. У заявки пришлось заодно переставить порядок:
 * «первая ли это заявка» решалось по ответу записи (`created`), поэтому на
 * повторе заявка уже лежала, ответ считался лишним и не уходил никогда.
 * Теперь «первая ли» спрашивается чтением, а запись идёт после удачного
 * рассказа.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
  requireApproval: boolean; anonymousPosting: boolean; slowModeSeconds: number;
  inviteToken?: string | null;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };
type FakeRequest = { id: string; groupId: string; requesterPubB64: string; ownerProfileId: number };

/** Уходят ли конверты. false — служба переписки не поднята. */
let mockFanoutOk = true;
/** Метки отправленных адресно конвертов: `group_ctl_direct_<op>`. */
const mockSentOps: string[] = [];

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, FakeMember[]> = {};
const mockRequests: FakeRequest[] = [];
const mockKv = new Map<string, string>();

const GID = 'g-818';
const ME = 'M'.repeat(43);
const STRANGER = 'S'.repeat(43);
const TS = 1_700_000_000_000;
/** Форма токена важна: чужое слово не считается токеном вовсе. */
const TOKEN_OK = 'A'.repeat(22);
const TOKEN_OLD = 'B'.repeat(22);

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async (id: string, pid: number) =>
    mockGroups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null),
  getGroupRead: jest.fn(async (id: string, pid: number) => {
    const row = mockGroups.find((g) => g.id === id && g.ownerProfileId === pid);
    return row ? { state: 'found', value: row } : { state: 'missing' };
  }),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  listGroupMembersRead: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  getGroupMessageTarget: jest.fn(async () => null),
  getGroupMessageTargetRead: jest.fn(async () => ({ state: 'missing' })),
  insertGroupMessage: jest.fn(async () => true),
  insertGroupMessageChecked: jest.fn(async () => 'inserted'),
  updateGroupMessageText: jest.fn(async () => true),
  deleteGroupMessage: jest.fn(async () => {}),
  deleteGroupMessageChecked: jest.fn(async () => 'deleted'),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  // Та же дедупликация, что и в базе: заявка одна на человека, повторное
  // открытие ссылки обновляет ту же строку.
  insertGroupJoinRequest: jest.fn(async (gid: string, requester: string, _n: unknown, _m: unknown, pid: number) => {
    const found = mockRequests.find((r) => r.groupId === gid && r.requesterPubB64 === requester && r.ownerProfileId === pid);
    if (found) return { id: found.id, created: false };
    const row = { id: `req-${mockRequests.length + 1}`, groupId: gid, requesterPubB64: requester, ownerProfileId: pid };
    mockRequests.push(row);
    return { id: row.id, created: true };
  }),
  listGroupJoinRequests: jest.fn(async (gid: string, pid: number) =>
    mockRequests.filter((r) => r.groupId === gid && r.ownerProfileId === pid)),
  createGroup: jest.fn(async () => {}),
  createGroupWithRoster: jest.fn(async () => true),
  upsertGroupMember: jest.fn(async (row: { groupId: string; peerPubB64: string; role: string; ownerProfileId: number }) => {
    const list = mockMembers[row.groupId] ?? (mockMembers[row.groupId] = []);
    list.push({ peerPubB64: row.peerPubB64, role: row.role, ownerProfileId: row.ownerProfileId });
  }),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  }),
  kvSet: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, v);
  }),
  kvSetSecret: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  }),
  kvGetSecretCellScoped: jest.fn(async () => ({ state: 'absent' })),
  kvDelete: jest.fn(async (k: string) => {
    mockKv.delete(k);
  }),
  kvDeleteChecked: jest.fn(async (k: string) => {
    mockKv.delete(k);
  }),
  kvListKeysByPrefix: jest.fn(async () => []),
}));

jest.mock('../groupPinSync', () => ({ applyLocalPin: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => 'Я',
  getOwnDisplayName: async () => 'Я',
  getOwnUsernameFor: async () => 'ya',
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: async () => {}, groupRecipient: async () => null }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: (members: Array<{ peerPubB64: string }>) => members.map((m) => m.peerPubB64),
  fanoutControlEnvelope: async (op: string) => {
    if (!mockFanoutOk) return { sent: false, reason: 'no_service' };
    mockSentOps.push(op);
    return { sent: true, recipients: 1 };
  },
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, blockedListReadable: () => true, isBlocked: () => false },
}));
jest.mock('../../settings/privacyPrefs', () => ({
  // «Только контакты» выключено: посторонний доходит до очереди заявок.
  privacyPrefTryBoolFor: async () => false,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join as pathJoin } from 'path';

import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { handleIncomingGroupControl, sendGroupControlTo } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';
import { resetControlTsMirrorForTests } from '../controlWatermark';

const RCPT = { pid: 1, pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }, myPub: ME } as unknown as GroupRecipient;

/** Группа, где я администратор. `token` — действующий пригласительный токен. */
function myGroup(extra: Partial<FakeGroup> = {}): void {
  mockGroups.push({
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
    isAdmin: true, adminOnlyPosting: false, adminOnlyPinning: false,
    requireApproval: false, anonymousPosting: false, slowModeSeconds: 0,
    ...extra,
  });
  mockMembers[GID] = [{ peerPubB64: ME, role: 'admin', ownerProfileId: 1, displayName: 'Я' }];
}

const join = (opts: { ts?: number; inviteToken?: string } = {}) =>
  encodeGroupCtlEnvelope({
    op: 'join', groupId: GID, ts: opts.ts ?? TS, target: STRANGER, targetName: 'Гость',
    actorName: 'Гость', ...(opts.inviteToken ? { inviteToken: opts.inviteToken } : {}),
  } as never);

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
  resetControlTsMirrorForTests();
  mockGroups.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  mockRequests.length = 0;
  mockKv.clear();
  mockSentOps.length = 0;
  mockFanoutOk = true;
  jest.clearAllMocks();
});

describe('отказ по отозванной ссылке: объяснение либо доходит, либо кадр ждёт', () => {
  it('конверт не ушёл — кадр откладывается', async () => {
    myGroup({ inviteToken: TOKEN_OK });
    mockFanoutOk = false;
    expect(await handleIncomingGroupControl(join({ inviteToken: TOKEN_OLD }), RCPT, STRANGER)).toBe('deferred');
  });

  it('служба поднялась — тот же кадр объясняет отказ и разбирается', async () => {
    myGroup({ inviteToken: TOKEN_OK });
    mockFanoutOk = false;
    await handleIncomingGroupControl(join({ inviteToken: TOKEN_OLD }), RCPT, STRANGER);
    expect(mockSentOps).toEqual([]);

    mockFanoutOk = true;
    expect(await handleIncomingGroupControl(join({ inviteToken: TOKEN_OLD }), RCPT, STRANGER)).toBe('consumed');
    expect(mockSentOps).toEqual(['group_ctl_direct_joinres']);
  });

  it('в группу по отозванной ссылке не пускают ни при каком исходе отправки', async () => {
    myGroup({ inviteToken: TOKEN_OK });
    mockFanoutOk = false;
    await handleIncomingGroupControl(join({ inviteToken: TOKEN_OLD }), RCPT, STRANGER);
    expect(mockMembers[GID].map((m) => m.peerPubB64)).toEqual([ME]);
  });
});

describe('«заявка ждёт одобрения»: рассказ идёт до записи заявки', () => {
  it('конверт не ушёл — кадр откладывается, и заявка ещё не записана', async () => {
    myGroup({ requireApproval: true });
    mockFanoutOk = false;
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('deferred');
    expect(mockRequests).toEqual([]);
  });

  it('служба поднялась — тот же кадр и рассказывает, и записывает заявку', async () => {
    myGroup({ requireApproval: true });
    mockFanoutOk = false;
    await handleIncomingGroupControl(join(), RCPT, STRANGER);

    mockFanoutOk = true;
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('consumed');
    expect(mockSentOps).toEqual(['group_ctl_direct_joinres']);
    expect(mockRequests).toHaveLength(1);
  });

  it('повторное открытие ссылки второй строки «ждём одобрения» не даёт (v4.32.266)', async () => {
    myGroup({ requireApproval: true });
    await handleIncomingGroupControl(join(), RCPT, STRANGER);
    expect(mockSentOps).toHaveLength(1);

    // Другой кадр, другое время — но заявка уже числится ждущей.
    expect(await handleIncomingGroupControl(join({ ts: TS + 60_000 }), RCPT, STRANGER)).toBe('consumed');
    expect(mockSentOps).toHaveLength(1);
    expect(mockRequests).toHaveLength(1);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Откладывать можно только то, что при живой связи проходит с первого раза, —
 * иначе заявка от постороннего заперла бы метку relay насовсем.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: при живой связи обе ветки разбирают кадр сразу', () => {
  it('отозванная ссылка: кадр разобран, объяснение ушло', async () => {
    myGroup({ inviteToken: TOKEN_OK });
    expect(await handleIncomingGroupControl(join({ inviteToken: TOKEN_OLD }), RCPT, STRANGER)).toBe('consumed');
    expect(mockSentOps).toEqual(['group_ctl_direct_joinres']);
  });

  it('заявка: кадр разобран, заявка записана, рассказ ушёл один раз', async () => {
    myGroup({ requireApproval: true });
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('consumed');
    expect(mockRequests).toHaveLength(1);
    expect(mockSentOps).toEqual(['group_ctl_direct_joinres']);
  });

  it('не-администратор отозванную ссылку по-прежнему роняет молча', async () => {
    myGroup({ inviteToken: TOKEN_OK });
    mockMembers[GID] = [{ peerPubB64: ME, role: 'member', ownerProfileId: 1 }];
    mockGroups[0].isAdmin = false;
    mockFanoutOk = false;
    // Отвечать не наше дело — значит и откладывать нечего.
    expect(await handleIncomingGroupControl(join({ inviteToken: TOKEN_OLD }), RCPT, STRANGER)).toBe('consumed');
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отправка сообщает о беде ОТВЕТОМ, а не исключением: `void` перед ней ничего
 * не ронял и ничего не печатал. Значит выброшенный ответ — это именно молчание,
 * а не «упало бы и так».
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: неудачная отправка не бросает', () => {
  it('sendGroupControlTo возвращает отказ словом', async () => {
    mockFanoutOk = false;
    const out = await sendGroupControlTo([STRANGER], GID, { op: 'joinres', target: STRANGER, status: 'pending' }, 'Я');
    expect(out.sent).toBe(false);
    expect(mockSentOps).toEqual([]);
  });
});

describe('форма исходников: оба ответа заявителю прочитаны', () => {
  it('отказ по отозванной ссылке и «ждём одобрения» уходят с чтением исхода', () => {
    expect(GRP).toContain('const toldRv = await sendGroupControlTo(');
    expect(GRP).toContain('const toldQ = await sendGroupControlTo(');
    expect(GRP).toContain("if (!toldRv.sent) {");
    expect(GRP).toContain("if (!toldQ.sent) {");
  });

  it('«первая ли заявка» спрашивается чтением, а запись идёт после рассказа', () => {
    const at = GRP.indexOf("if (verdict === 'queue') {");
    expect(at).toBeGreaterThan(0);
    const branch = GRP.slice(at, GRP.indexOf('group_ctl_join_queued', at));
    const read = branch.indexOf('await listGroupJoinRequests(');
    const told = branch.indexOf('sendGroupControlTo(');
    const wrote = branch.indexOf('await insertGroupJoinRequest(');
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(told);
    expect(told).toBeLessThan(wrote);
    // Прежнее условие «первая заявка» по ответу записи исчезло совсем.
    expect(branch).not.toContain('queued.created');
  });
});
