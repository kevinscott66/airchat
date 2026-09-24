/**
 * Остальные системные строки управляющих конвертов (v4.32.774).
 *
 * v4.32.773 научила читать исход записи только ветки состава — ban, unban,
 * kick, add, role. Остальные шесть мест писали строку вслепую, и у каждого была
 * своя причина, по которой повтор кадра ничего не чинил:
 *
 *  • приглашение — `if (group) return 'consumed'` в начале ветки: группа уже
 *    заведена, и повтор выходит раньше строки;
 *  • вступление — `commitGroupControlTs` шёл ДО строки, и повтор приходил уже
 *    устаревшим;
 *  • выход — `acceptGroupControlTs` двигал знак до применения, то есть хоронил
 *    и саму строку, и удаление из списка участников;
 *  • настройки — события собираются сравнением с текущим значением, а после
 *    применения сравнение совпадает, и событие не собирается вовсе;
 *  • закрепление и ответ на заявку — знака нет, но отказ всё равно съедался
 *    молча, хотя рядом, строкой выше, такой же отказ уже откладывал кадр.
 *
 * Теперь строка везде пишется до необратимого шага, а её отказ уводит кадр в
 * перезапрос.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
  requireApproval: boolean; anonymousPosting: boolean; slowModeSeconds: number;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };

/** Что ответит запись системной строки: как настоящая insertGroupMessageChecked. */
let mockSysWrite: 'inserted' | 'duplicate' | 'failed' = 'inserted';
/** Тексты записанных системных строк — по ним видно, дошёл ли рассказ. */
const mockSaidLines: string[] = [];
/** Необратимые шаги по порядку — по ним видно, применилось ли хоть что-то. */
const mockApplied: string[] = [];

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, FakeMember[]> = {};
const mockKv = new Map<string, string>();

/** Невидимая метка системной строки. */
const SYS = '\x0bsys:';

const GID = 'g-774';
const ME = 'M'.repeat(43);
const ADMIN = 'A'.repeat(43);
const NEWBIE = 'N'.repeat(43);
const MSG = 'm-774';
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
  getGroupMessageTargetRead: jest.fn(async () => ({
    state: 'found',
    value: { groupId: 'g-774', senderPubB64: 'A'.repeat(43), text: 'закрепляемое' },
  })),
  insertGroupMessage: jest.fn(async () => true),
  insertGroupMessageChecked: jest.fn(async (row: { text: string }) => {
    if (mockSysWrite !== 'failed') mockSaidLines.push(row.text);
    return mockSysWrite;
  }),
  updateGroupMessageText: jest.fn(async () => true),
  deleteGroupMessage: jest.fn(async () => {}),
  deleteGroupMessageChecked: jest.fn(async () => 'deleted'),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  createGroup: jest.fn(async (id: string, pid: number, name: string) => {
    mockApplied.push(`createGroup:${name}`);
    mockGroups.push({
      id, ownerProfileId: pid, name, type: 'group', archived: false, isAdmin: false,
      adminOnlyPosting: false, adminOnlyPinning: false, requireApproval: false,
      anonymousPosting: false, slowModeSeconds: 0,
    });
  }),
  // v4.32.816: приглашение кладёт группу и состав одной записью. Подмена
  // оставляет тот же след, что и прежняя россыпь вызовов, — порядок отметок
  // в mockApplied не меняется.
  createGroupWithRoster: jest.fn(async (
    g: { id: string; ownerProfileId: number; name: string },
    members: Array<{ groupId: string; peerPubB64: string; role: string; ownerProfileId: number }>,
  ) => {
    mockApplied.push(`createGroup:${g.name}`);
    mockGroups.push({
      id: g.id, ownerProfileId: g.ownerProfileId, name: g.name, type: 'group', archived: false, isAdmin: false,
      adminOnlyPosting: false, adminOnlyPinning: false, requireApproval: false,
      anonymousPosting: false, slowModeSeconds: 0,
    });
    for (const row of members) {
      mockApplied.push(`upsert:${row.peerPubB64.slice(0, 1)}:${row.role}`);
      const list = mockMembers[row.groupId] ?? (mockMembers[row.groupId] = []);
      const found = list.find((m) => m.peerPubB64 === row.peerPubB64);
      if (found) found.role = row.role;
      else list.push({ peerPubB64: row.peerPubB64, role: row.role, ownerProfileId: row.ownerProfileId });
    }
    return true;
  }),
  upsertGroupMember: jest.fn(async (row: { groupId: string; peerPubB64: string; role: string; ownerProfileId: number }) => {
    mockApplied.push(`upsert:${row.peerPubB64.slice(0, 1)}:${row.role}`);
    const list = mockMembers[row.groupId] ?? (mockMembers[row.groupId] = []);
    const found = list.find((m) => m.peerPubB64 === row.peerPubB64);
    if (found) found.role = row.role;
    else list.push({ peerPubB64: row.peerPubB64, role: row.role, ownerProfileId: row.ownerProfileId });
  }),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async (gid: string, peerPubB64: string) => {
    mockApplied.push(`remove:${peerPubB64.slice(0, 1)}`);
    mockMembers[gid] = (mockMembers[gid] ?? []).filter((m) => m.peerPubB64 !== peerPubB64);
  }),
  updateGroupMeta: jest.fn(async (id: string, pid: number, patch: Record<string, unknown>) => {
    mockApplied.push(`meta:${Object.keys(patch).join(',')}`);
    const g = mockGroups.find((x) => x.id === id && x.ownerProfileId === pid);
    if (g && typeof patch.name === 'string') g.name = patch.name;
  }),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async (id: string, pid: number, sec: number) => {
    mockApplied.push(`slow:${sec}`);
  }),
  setGroupDisappearTimer: jest.fn(async () => {
    mockApplied.push('disappear');
  }),
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
  kvDelete: jest.fn(async (k: string) => {
    mockKv.delete(k);
  }),
}));

jest.mock('../groupPinSync', () => ({
  applyLocalPin: jest.fn(async () => ({ ok: true })),
}));
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
  fanoutControlEnvelope: async () => ({ sent: 0, failed: 0, skipped: 0 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async () => {},
    // v4.32.795: «список прочитан» — предмет отдельного вопроса, а не
    // молчаливого «не заблокирован». Здесь база открыта.
    blockedListReadable: () => true,
    isBlocked: () => false,
  },
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

import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { handleIncomingGroupControl } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';
import { resetControlTsMirrorForTests } from '../controlWatermark';

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, которую мы уже знаем: ADMIN — владелец, я обычный участник. */
function known(): void {
  mockGroups.push({
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
    isAdmin: false, adminOnlyPosting: false, adminOnlyPinning: false,
    requireApproval: false, anonymousPosting: false, slowModeSeconds: 0,
  });
  mockMembers[GID] = [
    { peerPubB64: ADMIN, role: 'owner', ownerProfileId: 1, displayName: 'Хозяин' },
    { peerPubB64: ME, role: 'member', ownerProfileId: 1, displayName: 'Я' },
  ];
}

const invite = (ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'invite', groupId: GID, ts, groupName: 'Двор', actorName: 'Хозяин',
    members: [{ pub: ADMIN, name: 'Хозяин' }],
  } as never);

const join = (ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'join', groupId: GID, ts, target: NEWBIE, targetName: 'Новичок', actorName: 'Новичок',
  } as never);

const leave = (ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'leave', groupId: GID, ts, target: ADMIN, targetName: 'Хозяин', actorName: 'Хозяин',
  } as never);

const pin = (ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'pin', groupId: GID, ts, msgId: MSG, on: true, actorName: 'Хозяин',
  } as never);

const joinres = (ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'joinres', groupId: GID, ts, target: ME, status: 'rejected', actorName: 'Хозяин',
  } as never);

const meta = (ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'meta', groupId: GID, ts, name: 'Новый двор', slowModeSeconds: 300, actorName: 'Хозяин',
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
  // v4.32.791: зеркало знака живёт на уровне модуля — убираем его, иначе
  // применённое соседней проверкой судило бы конверты этой.
  resetControlTsMirrorForTests();
  mockGroups.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  mockKv.clear();
  mockSaidLines.length = 0;
  mockApplied.length = 0;
  mockSysWrite = 'inserted';
  jest.clearAllMocks();
});

describe('строка не легла — кадр откладывается, а необратимое не делается', () => {
  it('приглашение: группа не заводится вовсе', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(invite(), RCPT, ADMIN)).toBe('deferred');
    expect(mockApplied).toEqual([]);
    expect(mockGroups).toEqual([]);
  });

  it('приглашение: база освободилась — тот же кадр заводит группу и рассказывает', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(invite(), RCPT, ADMIN)).toBe('deferred');

    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(invite(), RCPT, ADMIN)).toBe('consumed');
    expect(mockApplied[0]).toBe('createGroup:Двор');
    expect(mockSaidLines).toEqual([SYS + 'Хозяин добавил(а) вас в группу']);
  });

  it('вступление: знак свежести не двигается', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(join(), RCPT, NEWBIE)).toBe('deferred');

    // Сдвинутый знак отверг бы повтор как устаревший — проверяем тем же ts.
    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(join(), RCPT, NEWBIE)).toBe('consumed');
    expect(mockSaidLines).toEqual([SYS + 'Новичок вступил(а) в группу']);
  });

  it('выход: участник остаётся в списке, а знак не сдвинут', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(leave(), RCPT, ADMIN)).toBe('deferred');
    expect(mockApplied).toEqual([]);

    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(leave(), RCPT, ADMIN)).toBe('consumed');
    expect(mockApplied).toContain('remove:A');
    expect(mockSaidLines).toEqual([SYS + 'Хозяин покинул(а) группу']);
  });

  it('закрепление: кадр откладывается — закрепление идемпотентно и повторится', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(pin(), RCPT, ADMIN)).toBe('deferred');

    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(pin(), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaidLines).toEqual([SYS + 'Сообщение закреплено']);
  });

  it('ответ на заявку: строка — всё событие, её отказ и есть неразобранный кадр', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(joinres(), RCPT, ADMIN)).toBe('deferred');

    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(joinres(), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaidLines).toEqual([SYS + 'Хозяин отклонил(а) заявку на вступление']);
  });

  it('настройки: ни название, ни медленный режим не применяются', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(meta(), RCPT, ADMIN)).toBe('deferred');
    expect(mockApplied).toEqual([]);
    expect(mockGroups[0].name).toBe('Двор');
  });

  it('настройки: база освободилась — тот же кадр применяет всё и рассказывает', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(meta(), RCPT, ADMIN)).toBe('deferred');

    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(meta(), RCPT, ADMIN)).toBe('consumed');
    expect(mockGroups[0].name).toBe('Новый двор');
    expect(mockApplied).toContain('slow:300');
    expect(mockSaidLines).toHaveLength(2);
    expect(mockSaidLines[0]).toContain('Группа переименована');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отложить можно только то, что пройдёт само. Настоящий повтор строки —
 * окончательный исход: id детерминированный, второй раз она не ляжет никогда.
 * Такой кадр остаётся разобранным, иначе метка чтения заперлась бы навсегда.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные исходы остаются разобранными', () => {
  it('все шесть веток при удачной записи разбирают кадр', async () => {
    const verdicts: string[] = [];
    for (const [make, sender, pre] of [
      [invite, ADMIN, false],
      [join, NEWBIE, true],
      [leave, ADMIN, true],
      [pin, ADMIN, true],
      [joinres, ADMIN, true],
      [meta, ADMIN, true],
    ] as const) {
      mockGroups.length = 0;
      for (const k of Object.keys(mockMembers)) delete mockMembers[k];
      mockKv.clear();
      if (pre) known();
      verdicts.push(await handleIncomingGroupControl(make(), RCPT, sender));
    }
    expect(verdicts).toEqual(Array(6).fill('consumed'));
  });

  it('настоящий повтор строки кадр не запирает', async () => {
    known();
    mockSysWrite = 'duplicate';
    expect(await handleIncomingGroupControl(meta(), RCPT, ADMIN)).toBe('consumed');
    expect(mockGroups[0].name).toBe('Новый двор');
  });

  it('приглашение в уже известную группу по-прежнему идемпотентно и молчит', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(invite(), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaidLines).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('слепых вызовов записи системной строки не осталось', () => {
    // Исход читается везде: вызов либо присвоен, либо сравнён на месте. Отдельным
    // выражением-действием — то есть с выброшенным ответом — он не стоит нигде.
    const blind = GRP.split('\n').filter((l) => l.trim().startsWith('await insertCtlSysMessage('));
    expect(blind).toEqual([]);
  });

  it('каждая ветка называет себя, когда откладывает кадр', () => {
    for (const op of ['invite', 'join', 'leave', 'pin', 'joinres']) {
      expect(GRP).toContain(`return deferCtlSysRow(env, '${op}');`);
    }
    expect(GRP).toContain('return deferCtlSysRow(env, `meta:${ev.field}`);');
  });

  it('приглашение: строка пишется до заведения группы', () => {
    const at = GRP.indexOf("if (env.op === 'invite') {");
    expect(at).toBeGreaterThan(0);
    const branch = GRP.slice(at, GRP.indexOf('group_ctl_invite_applied', at));
    // v4.32.816: заведение и состав идут одной записью — её имя и проверяем.
    expect(branch.indexOf('insertCtlSysMessage(')).toBeLessThan(branch.indexOf('createGroupWithRoster('));
  });

  it('вступление и выход: строка пишется до сдвига знака', () => {
    const at = GRP.indexOf("if (env.op === 'join') {");
    expect(at).toBeGreaterThan(0);
    const branch = GRP.slice(at, GRP.indexOf('group_ctl_join_applied', at));
    const saidJoin = branch.indexOf('insertCtlSysMessage(');
    expect(saidJoin).toBeGreaterThan(0);
    // И до записи состава: записанный участник уводит повтор в 'ignore'.
    expect(saidJoin).toBeLessThan(branch.indexOf('await upsertGroupMember({'));
    expect(saidJoin).toBeLessThan(branch.indexOf('commitGroupControlTs('));

    const lv = GRP.indexOf("if (env.op === 'leave') {");
    expect(lv).toBeGreaterThan(0);
    const lb = GRP.slice(lv, GRP.indexOf('group_ctl_leave_applied', lv));
    expect(lb.indexOf('insertCtlSysMessage(')).toBeLessThan(lb.indexOf('commitGroupControlTs('));
    expect(lb).not.toContain('acceptGroupControlTs(');
  });

  it('настройки: строки пишутся до применения и до сдвига знаков', () => {
    const at = GRP.indexOf("if (env.op === 'meta') {");
    expect(at).toBeGreaterThan(0);
    const branch = GRP.slice(at, GRP.indexOf('group_ctl_meta_applied', at));
    const said = branch.indexOf('insertCtlSysMessage(');
    expect(said).toBeGreaterThan(0);
    expect(said).toBeLessThan(branch.indexOf('await updateGroupMeta(env.groupId, pid, patch)'));
    expect(said).toBeLessThan(branch.indexOf('await setGroupSlowMode('));
    expect(said).toBeLessThan(branch.indexOf('commitGroupControlTs('));
  });
});
