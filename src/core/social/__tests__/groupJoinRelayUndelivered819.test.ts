/**
 * Пересказ вступления остальным участникам не выбрасывается в пустоту (v4.32.819).
 *
 * Дефект. Вступивший по ссылке рассылает «я вступил» только тем, кого несла
 * ссылка, — а она несёт не больше 20 участников (v4.32.262). Остальным о нём
 * рассказывает администратор конвертом 'add'. Этот пересказ звался через
 * `void` последним действием разбора: рассылка, не ушедшая никому (служба
 * переписки не поднята), пропадала бесследно, а кадр объявлялся разобранным.
 *
 * Цена. В группе из тридцати десять человек о новичке так и не узнают, и
 * анти-спуф-фильтр входящих молча выбрасывает у них КАЖДОЕ его сообщение: он
 * пишет, ему отвечает часть группы, и понять, почему остальные молчат,
 * невозможно. Повторов у управляющего конверта нет — вторую попытку не делает
 * никто.
 *
 * Правка. Пересказ идёт ПЕРЕД записью состава, и его отказ откладывает кадр.
 * Откладывать после записи бессмысленно: тот же кадр во второй раз уводит
 * decideJoin в 'ignore' (участник уже записан), а водяной знак `m:` отвечает
 * «устарел» — то есть повтор не доходит до пересказа никогда.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
  requireApproval: boolean; anonymousPosting: boolean; slowModeSeconds: number;
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
const OTHER = 'O'.repeat(43);
const TS = 1_700_000_000_000;

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

/** Группа, где я администратор, и вход по ссылке одобрения не требует. */
function myGroup(extra: Partial<FakeGroup> = {}): void {
  mockGroups.push({
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
    isAdmin: true, adminOnlyPosting: false, adminOnlyPinning: false,
    requireApproval: false, anonymousPosting: false, slowModeSeconds: 0,
    ...extra,
  });
  mockMembers[GID] = [
    { peerPubB64: ME, role: 'admin', ownerProfileId: 1, displayName: 'Я' },
    // Тот, кого ссылка не несла: ради него пересказ и существует.
    { peerPubB64: OTHER, role: 'member', ownerProfileId: 1 },
  ];
}

const join = (ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'join', groupId: GID, ts, target: STRANGER, targetName: 'Гость', actorName: 'Гость',
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

const inRoster = (pub: string) => (mockMembers[GID] ?? []).some((m) => m.peerPubB64 === pub);

describe('пересказ не ушёл — кадр не разобран', () => {
  it('служба переписки не поднята: кадр откладывается, состав не тронут', async () => {
    myGroup();
    mockFanoutOk = false;
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('deferred');
    expect(inRoster(STRANGER)).toBe(false);
  });

  it('служба поднялась — тот же кадр и рассказывает, и записывает', async () => {
    myGroup();
    mockFanoutOk = false;
    await handleIncomingGroupControl(join(), RCPT, STRANGER);
    expect(mockSentOps).toEqual([]);

    mockFanoutOk = true;
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('consumed');
    expect(mockSentOps).toEqual(['group_ctl_direct_add']);
    expect(inRoster(STRANGER)).toBe(true);
  });

  it('ни состав, ни водяной знак не уходят вперёд пересказа', async () => {
    myGroup();
    mockFanoutOk = false;
    await handleIncomingGroupControl(join(), RCPT, STRANGER);
    // Оба сторожа повтора должны остаться нетронутыми: записанный участник
    // уводит decideJoin в 'ignore', сдвинутый знак отвечает «устарел», — и в
    // обоих случаях повторённый кадр до пересказа уже не доходит. Тот же ts.
    mockFanoutOk = true;
    await handleIncomingGroupControl(join(), RCPT, STRANGER);
    expect(mockSentOps).toEqual(['group_ctl_direct_add']);
    expect(inRoster(STRANGER)).toBe(true);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Откладывать можно только то, что при живой связи проходит с первого раза, —
 * иначе вступление по ссылке заперло бы метку relay насовсем.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: при живой связи кадр разбирается сразу', () => {
  it('новичок записан, пересказ ушёл, кадр разобран', async () => {
    myGroup();
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('consumed');
    expect(inRoster(STRANGER)).toBe(true);
    expect(mockSentOps).toEqual(['group_ctl_direct_add']);
  });

  it('группа, где кроме нас никого: рассказывать некому — это удача, а не отказ', async () => {
    myGroup();
    mockMembers[GID] = [{ peerPubB64: ME, role: 'admin', ownerProfileId: 1 }];
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('consumed');
    expect(inRoster(STRANGER)).toBe(true);
  });

  it('не-администратор не пересказывает и без связи: откладывать ему нечего', async () => {
    myGroup();
    mockGroups[0].isAdmin = false;
    mockMembers[GID] = [
      { peerPubB64: ME, role: 'member', ownerProfileId: 1 },
      { peerPubB64: OTHER, role: 'member', ownerProfileId: 1 },
    ];
    mockFanoutOk = false;
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('consumed');
    expect(inRoster(STRANGER)).toBe(true);
    expect(mockSentOps).toEqual([]);
  });

  it('повторный кадр после удачного разбора ничего не пересказывает заново', async () => {
    myGroup();
    await handleIncomingGroupControl(join(), RCPT, STRANGER);
    expect(mockSentOps).toHaveLength(1);
    // Участник уже записан — decideJoin отвечает 'ignore' раньше пересказа.
    expect(await handleIncomingGroupControl(join(), RCPT, STRANGER)).toBe('consumed');
    expect(mockSentOps).toHaveLength(1);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Рассылка сообщает о беде ОТВЕТОМ, а не исключением: `void` перед ней ничего
 * не ронял и ничего не печатал. Значит выброшенный ответ — это именно молчание.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: неудачная рассылка не бросает', () => {
  it('sendGroupControlTo возвращает отказ словом', async () => {
    mockFanoutOk = false;
    const out = await sendGroupControlTo([OTHER], GID, { op: 'add', target: STRANGER }, 'Я');
    expect(out.sent).toBe(false);
    expect(mockSentOps).toEqual([]);
  });
});

describe('форма исходников: пересказ прочитан и стоит перед записью', () => {
  it('в приёмнике не осталось рассылок через void', () => {
    expect(GRP).not.toContain('void sendGroupControlTo(');
  });

  it('исход пересказа читается, а запись состава идёт после него', () => {
    const at = GRP.indexOf("log.warn('group_ctl_join_stale'");
    expect(at).toBeGreaterThan(0);
    const branch = GRP.slice(at, GRP.indexOf("log.info('group_ctl_join_applied'", at));
    const told = branch.indexOf('const toldAdd = await sendGroupControlTo(');
    const guard = branch.indexOf('if (!toldAdd.sent) {');
    const wrote = branch.indexOf('await upsertGroupMember({');
    const commit = branch.indexOf('await commitGroupControlTs(');
    expect(told).toBeGreaterThan(0);
    expect(told).toBeLessThan(guard);
    expect(guard).toBeLessThan(wrote);
    expect(wrote).toBeLessThan(commit);
    expect(branch.slice(guard, guard + 260)).toContain("return 'deferred';");
  });
});
