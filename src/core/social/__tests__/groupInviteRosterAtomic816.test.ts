/**
 * Приглашение заводит группу вместе с составом — целиком или никак (v4.32.816).
 *
 * Дефект. Ветка `invite` раскладывала приглашение россыпью: `createGroup`,
 * следом `upsertGroupMember` на каждого участника. Обе функции отвечают `void`
 * и о своём отказе сообщают исключением — то есть занятая база на любом
 * участнике уносила разбор конверта, оставив группу заведённой, а состав
 * недоложенным.
 *
 * Цена. Починить это повтором нельзя: тот же конверт, поданный заново,
 * упирается в `if (group) return 'consumed'` в начале ветки — группа-то уже
 * есть. Состав замирал в том виде, в каком его застал сбой, а другого случая
 * его сложить не представлялось: приглашение приходит один раз. Первым в
 * списке идёт пригласивший, и по его роли `admin` мы решаем, принимать ли от
 * него управляющие конверты: без этой строки человек оказывался в группе, где
 * до него не доходят ни переименование, ни бан, ни исключение.
 *
 * Правка. Группа и весь состав ложатся одной записью под общей транзакцией.
 * Отказ откладывает кадр, не тронув устройство, и повтор начинает с чистого
 * места — как того и требует договор `'deferred'`.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
  requireApproval: boolean; anonymousPosting: boolean; slowModeSeconds: number;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, FakeMember[]> = {};
const mockKv = new Map<string, string>();

/**
 * На каком по счёту участнике база отказывает. 0 — не отказывает.
 *
 * Отказ ровно такой, как у настоящей записи: `upsertGroupMember` возвращает
 * `void` и сообщает о себе исключением, а общая запись — `false`, не тронув
 * ни одной строки.
 */
let mockFailMemberAt = 0;
/** Сколько раз состав уже писали поимённо. */
let mockMemberWrites = 0;

const GID = 'g-816';
const ME = 'M'.repeat(43);
const ADMIN = 'A'.repeat(43);
const FRIEND = 'F'.repeat(43);
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
  insertGroupMessageWithTouch: jest.fn(async () => true),
  updateGroupMessageText: jest.fn(async () => true),
  deleteGroupMessage: jest.fn(async () => {}),
  deleteGroupMessageChecked: jest.fn(async () => 'deleted'),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  // Прежняя пара. Она никуда не делась — ею пользуются ветки состава, — и
  // подмена повторяет её договор: ответ `void`, отказ исключением.
  createGroup: jest.fn(async (id: string, pid: number, name: string) => {
    mockGroups.push({
      id, ownerProfileId: pid, name, type: 'group', archived: false, isAdmin: false,
      adminOnlyPosting: false, adminOnlyPinning: false, requireApproval: false,
      anonymousPosting: false, slowModeSeconds: 0,
    });
  }),
  upsertGroupMember: jest.fn(async (row: { groupId: string; peerPubB64: string; role: string; ownerProfileId: number }) => {
    mockMemberWrites += 1;
    if (mockFailMemberAt > 0 && mockMemberWrites >= mockFailMemberAt) {
      throw new Error('database is locked');
    }
    const list = mockMembers[row.groupId] ?? (mockMembers[row.groupId] = []);
    const found = list.find((m) => m.peerPubB64 === row.peerPubB64);
    if (found) found.role = row.role;
    else list.push({ peerPubB64: row.peerPubB64, role: row.role, ownerProfileId: row.ownerProfileId });
  }),
  // Общая запись: либо легло всё, либо ничего и `false`. Отказ здесь —
  // несостоявшийся COMMIT, поэтому ни строки группы, ни строк состава.
  createGroupWithRoster: jest.fn(async (
    g: { id: string; ownerProfileId: number; name: string },
    members: Array<{ groupId: string; peerPubB64: string; role: string; ownerProfileId: number }>,
  ) => {
    mockMemberWrites += members.length;
    if (mockFailMemberAt > 0 && mockFailMemberAt <= members.length) return false;
    mockGroups.push({
      id: g.id, ownerProfileId: g.ownerProfileId, name: g.name, type: 'group', archived: false,
      isAdmin: false, adminOnlyPosting: false, adminOnlyPinning: false, requireApproval: false,
      anonymousPosting: false, slowModeSeconds: 0,
    });
    for (const row of members) {
      const list = mockMembers[row.groupId] ?? (mockMembers[row.groupId] = []);
      const found = list.find((m) => m.peerPubB64 === row.peerPubB64);
      if (found) found.role = row.role;
      else list.push({ peerPubB64: row.peerPubB64, role: row.role, ownerProfileId: row.ownerProfileId });
    }
    return true;
  }),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => 0),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
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
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));
// v4.32.986: доверие к приглашению спрашивает справочник различающей формой:
// `listContactsFor` отдаёт `?? []`, и непрочитанный список выглядел пустым.
jest.mock('../contacts', () => ({
  listContactsFor: async () => [],
  listContactsReadDetailed: async () => ({ contacts: [], missing: 0 }),
}));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, blockedListReadable: () => true, isBlocked: () => false },
}));
jest.mock('../../settings/privacyPrefs', () => ({
  // false — «добавлять в группы могут все»: приглашение от незнакомца доверено.
  privacyPrefTryBoolFor: async () => false,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join as pathJoin } from 'path';

import { resetControlTsMirrorForTests } from '../controlWatermark';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { handleIncomingGroupControl } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Приглашение от ADMIN: в группе он сам, я и ещё один знакомый. */
const invite = (ts = TS): string =>
  encodeGroupCtlEnvelope({
    op: 'invite', groupId: GID, ts, groupName: 'Двор', actorName: 'Хозяин',
    members: [{ pub: ADMIN, name: 'Хозяин' }, { pub: FRIEND, name: 'Сосед' }],
  } as never);

const apply = (text: string): Promise<string> =>
  handleIncomingGroupControl(text, RCPT, ADMIN) as unknown as Promise<string>;

/** Роль участника в нашей базе — или null, если строки нет. */
function roleOf(pub: string): string | null {
  return (mockMembers[GID] ?? []).find((m) => m.peerPubB64 === pub)?.role ?? null;
}

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const GRP = codeOnly(readFileSync(pathJoin(__dirname, '..', 'groupMessaging.ts'), 'utf8'));
const LOCAL = codeOnly(readFileSync(pathJoin(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8'));

/** Ветка invite целиком — от заголовка до отметки о применении. */
function inviteBranch(): string {
  const at = GRP.indexOf("if (env.op === 'invite') {");
  expect(at).toBeGreaterThan(0);
  return GRP.slice(at, GRP.indexOf('group_ctl_invite_applied', at));
}

beforeEach(() => {
  resetControlTsMirrorForTests();
  mockGroups.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  mockKv.clear();
  mockFailMemberAt = 0;
  mockMemberWrites = 0;
});

describe('отказ базы посреди состава не оставляет полугруппы', () => {
  it('группа не заводится вовсе, а кадр откладывается', async () => {
    mockFailMemberAt = 2;
    await expect(apply(invite())).resolves.toBe('deferred');
    expect(mockGroups).toEqual([]);
    expect(mockMembers[GID] ?? []).toEqual([]);
  });

  it('отказ доносится ответом, а не исключением', async () => {
    mockFailMemberAt = 1;
    await expect(apply(invite())).resolves.toBe('deferred');
  });

  it('повтор того же кадра складывает состав целиком', async () => {
    mockFailMemberAt = 2;
    expect(await apply(invite())).toBe('deferred');
    // База освободилась — relay подаёт тот же кадр ещё раз.
    mockFailMemberAt = 0;
    expect(await apply(invite())).toBe('consumed');
    expect(mockGroups).toHaveLength(1);
    // Пригласивший — администратор: без этой строки группа осталась бы без
    // хозяина, и управляющие конверты от него мы бы больше не принимали.
    expect(roleOf(ADMIN)).toBe('admin');
    expect(roleOf(FRIEND)).toBe('member');
    expect(roleOf(ME)).toBe('member');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычное приглашение принимается как прежде', () => {
  it('группа заводится, состав и роли на месте', async () => {
    expect(await apply(invite())).toBe('consumed');
    expect(mockGroups).toHaveLength(1);
    expect(mockGroups[0].name).toBe('Двор');
    expect(roleOf(ADMIN)).toBe('admin');
    expect(roleOf(FRIEND)).toBe('member');
    expect(roleOf(ME)).toBe('member');
  });

  it('повторное приглашение в уже известную группу идемпотентно', async () => {
    expect(await apply(invite())).toBe('consumed');
    expect(await apply(invite(TS + 1))).toBe('consumed');
    expect(mockGroups).toHaveLength(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: поимённая запись по-прежнему молчит об отказе', () => {
  it('createGroup и upsertGroupMember отвечают void', () => {
    expect(LOCAL).toContain('export async function createGroup(');
    expect(LOCAL).toContain('export async function upsertGroupMember(member: GroupMemberRow): Promise<void> {');
  });

  it('и другие ветки ими по-прежнему пользуются — дело не в самой паре', () => {
    // Бан, разбан и вступление пишут ОДНУ строку: там отказ не оставляет
    // половины, и разбирать его — отдельный разговор.
    expect(GRP).toContain('await upsertGroupMember({');
  });
});

describe('форма исходников: приглашение пишет одной записью', () => {
  it('ветка invite зовёт общую запись и проверяет её ответ', () => {
    const branch = inviteBranch();
    expect(branch).toContain('if (!(await createGroupWithRoster(');
    expect(branch).toContain("return 'deferred';");
  });

  it('и не раскладывает приглашение поимённо', () => {
    const branch = inviteBranch();
    expect(branch).not.toContain('await createGroup(');
    expect(branch).not.toContain('await upsertGroupMember(');
  });

  it('общая запись идёт под транзакцией и отвечает отказом, а не броском', () => {
    const at = LOCAL.indexOf('export async function createGroupWithRoster(');
    expect(at).toBeGreaterThan(0);
    const body = LOCAL.slice(at, LOCAL.indexOf('\n}\n', at));
    expect(body).toContain('const txn = await beginImmediate(d);');
    expect(body).toContain('await txn.rollback();');
    expect(body).toContain('return false;');
    // Ключ данных берётся до транзакции — иначе Keystore держал бы write-lock.
    expect(body.indexOf('getOrCreateDataEncryptionKey()')).toBeLessThan(
      body.indexOf('beginImmediate(d)')
    );
  });
});
