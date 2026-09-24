/**
 * Занятая база больше не съедает рассказ о смене состава (v4.32.773).
 *
 * Системная строка — единственный способ сообщить человеку, что его исключили,
 * назначили администратором, разблокировали или одобрили его заявку. Пишет её
 * `insertCtlSysMessage`, и до сих пор она заканчивалась пустым
 * `catch { /* дубликат — не страшно *\/ }`. Повтор того же конверта туда и
 * правда попадает безвредно — id строки собирается из ts и совпадает, — но
 * вместе с ним туда уходили занятая база, не открывшийся ключ данных и
 * кончившееся место.
 *
 * Итог: состав менялся, а рассказа не было. И починить это повтором кадра было
 * нельзя — каждая ветка начинается с проверки «уже в этом состоянии», и
 * повторный конверт выходил раньше, чем дело дошло бы до строки: забаненного не
 * банят второй раз, исключённого не находят в списке, роль уже та самая.
 * Человек навсегда оставался без объяснения, почему он больше не может писать.
 *
 * Теперь строка пишется ДО изменения состава и её отказ откладывает кадр:
 * ничего не применено, знак свежести не сдвинут, и повтор проходит целиком.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };

/** Что ответит запись системной строки: как настоящая insertGroupMessageChecked. */
let mockSysWrite: 'inserted' | 'duplicate' | 'failed' = 'inserted';
/** Тексты записанных системных строк — по ним видно, дошёл ли рассказ. */
const mockSaidLines: string[] = [];
/** Изменения состава по порядку — по ним видно, применилось ли хоть что-то. */
const mockApplied: string[] = [];

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, FakeMember[]> = {};
const mockKv = new Map<string, string>();

/** Невидимая метка системной строки — по ней интерфейс отличает её от чужого текста. */
const SYS = '\x0bsys:';

const GID = 'g-773';
const ME = 'M'.repeat(43);
const ADMIN = 'A'.repeat(43);
const VICT = 'V'.repeat(43);
const BANNED = 'B'.repeat(43);
const NEWBIE = 'N'.repeat(43);

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
  // Предмет набора: различающая форма записи строки.
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
  createGroup: jest.fn(async () => {}),
  upsertGroupMember: jest.fn(async (row: { groupId: string; peerPubB64: string; role: string; ownerProfileId: number }) => {
    mockApplied.push(`upsert:${row.peerPubB64.slice(0, 1)}:${row.role}`);
    const list = mockMembers[row.groupId] ?? (mockMembers[row.groupId] = []);
    const found = list.find((m) => m.peerPubB64 === row.peerPubB64);
    if (found) found.role = row.role;
    else list.push({ peerPubB64: row.peerPubB64, role: row.role, ownerProfileId: row.ownerProfileId });
  }),
  updateGroupMemberRole: jest.fn(async (gid: string, peerPubB64: string, role: string) => {
    mockApplied.push(`role:${peerPubB64.slice(0, 1)}:${role}`);
    const row = (mockMembers[gid] ?? []).find((m) => m.peerPubB64 === peerPubB64);
    if (row) row.role = role;
  }),
  removeGroupMember: jest.fn(async (gid: string, peerPubB64: string) => {
    mockApplied.push(`remove:${peerPubB64.slice(0, 1)}`);
    mockMembers[gid] = (mockMembers[gid] ?? []).filter((m) => m.peerPubB64 !== peerPubB64);
  }),
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => {
    mockApplied.push('recount');
  }),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  // Водяные знаки и отметки об исключении ходят в kv через profileScopedKv —
  // без подделки они падали бы внутрь чужого catch, и проверка повтора в этом
  // наборе не работала бы вовсе (см. v4.32.655).
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

import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { handleIncomingGroupControl } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';
import { resetControlTsMirrorForTests } from '../controlWatermark';

const mockLog = (jest.requireMock('../../logger') as { log: { warn: jest.Mock } }).log;

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, где ADMIN — владелец, а я обычный участник. */
function known(): void {
  mockGroups.push({
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
    isAdmin: false, adminOnlyPosting: false, adminOnlyPinning: false,
  });
  mockMembers[GID] = [
    { peerPubB64: ADMIN, role: 'owner', ownerProfileId: 1, displayName: 'Хозяин' },
    { peerPubB64: ME, role: 'member', ownerProfileId: 1, displayName: 'Я' },
    { peerPubB64: VICT, role: 'member', ownerProfileId: 1, displayName: 'Пётр' },
    { peerPubB64: BANNED, role: 'banned', ownerProfileId: 1, displayName: 'Изгой' },
  ];
}

/** Управляющий конверт о составе от владельца группы. */
function ctl(op: 'ban' | 'unban' | 'kick' | 'add', target: string, ts = 1_700_000_000_000): string {
  return encodeGroupCtlEnvelope({
    op, groupId: GID, target, targetName: 'Пётр', ts, actorName: 'Хозяин',
  } as never);
}

/** Смена роли — тот же водяной знак, что у ban/kick/add. */
function roleCtl(target: string, role: 'admin' | 'member' | 'restricted', ts = 1_700_000_000_000): string {
  return encodeGroupCtlEnvelope({
    op: 'role', groupId: GID, target, role, targetName: 'Пётр', ts, actorName: 'Хозяин',
  } as never);
}

/** Роль человека в моём списке участников — или '—', если его там нет. */
function roleOfLocal(pub: string): string {
  return (mockMembers[GID] ?? []).find((m) => m.peerPubB64 === pub)?.role ?? '—';
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
  known();
});

describe('строка о смене состава не легла — кадр откладывается', () => {
  it('бан: ответ «отложено», и состав не тронут', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(ctl('ban', VICT), RCPT, ADMIN)).toBe('deferred');
    expect(mockApplied).toEqual([]);
    expect(roleOfLocal(VICT)).toBe('member');
  });

  it('исключение: я остаюсь в списке участников, раз рассказать об этом нечем', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(ctl('kick', ME), RCPT, ADMIN)).toBe('deferred');
    expect(mockApplied).toEqual([]);
    expect(roleOfLocal(ME)).toBe('member');
  });

  it('смена роли: роль остаётся прежней', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(roleCtl(VICT, 'admin'), RCPT, ADMIN)).toBe('deferred');
    expect(roleOfLocal(VICT)).toBe('member');
  });

  it('снятие блокировки: человек остаётся заблокированным', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(ctl('unban', BANNED), RCPT, ADMIN)).toBe('deferred');
    expect(roleOfLocal(BANNED)).toBe('banned');
  });

  it('добавление: новый участник не появляется', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(ctl('add', NEWBIE), RCPT, ADMIN)).toBe('deferred');
    expect(roleOfLocal(NEWBIE)).toBe('—');
  });

  it('одобрение моей заявки: строка и есть всё событие, отказ откладывает её', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(ctl('add', ME), RCPT, ADMIN)).toBe('deferred');
    expect(mockSaidLines).toEqual([]);
  });

  it('отказ назван отказом в журнале', async () => {
    mockSysWrite = 'failed';
    await handleIncomingGroupControl(ctl('kick', VICT), RCPT, ADMIN);
    expect(mockLog.warn).toHaveBeenCalledWith(
      'group_ctl_sys_row_deferred',
      expect.objectContaining({ op: 'kick' })
    );
  });

  it('база освободилась — ТОТ ЖЕ кадр применяется целиком', async () => {
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(ctl('kick', VICT), RCPT, ADMIN)).toBe('deferred');

    // Знак свежести не сдвинут — иначе повтор пришёл бы уже устаревшим.
    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(ctl('kick', VICT), RCPT, ADMIN)).toBe('consumed');
    expect(roleOfLocal(VICT)).toBe('—');
    expect(mockSaidLines).toEqual([SYS + 'Пётр исключён(а) из группы']);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отложить можно только то, что пройдёт само. Настоящий повтор строки —
 * окончательный исход, а не заминка: id детерминированный, и второй раз она не
 * ляжет никогда. Такой кадр остаётся разобранным, иначе метка чтения у
 * ретранслятора заперлась бы навсегда.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные исходы остаются разобранными', () => {
  it('строка легла — состав изменён, рассказ записан', async () => {
    expect(await handleIncomingGroupControl(ctl('ban', VICT), RCPT, ADMIN)).toBe('consumed');
    expect(roleOfLocal(VICT)).toBe('banned');
    expect(mockSaidLines).toEqual([SYS + 'Пётр заблокирован(а) в группе']);
  });

  it('строка уже была (настоящий повтор) — изменение всё равно применяется', async () => {
    mockSysWrite = 'duplicate';
    expect(await handleIncomingGroupControl(ctl('kick', VICT), RCPT, ADMIN)).toBe('consumed');
    expect(roleOfLocal(VICT)).toBe('—');
  });

  it('три исхода записи дают два разных ответа', async () => {
    const verdicts: string[] = [];
    for (const w of ['inserted', 'duplicate', 'failed'] as const) {
      mockSysWrite = w;
      mockGroups.length = 0;
      for (const k of Object.keys(mockMembers)) delete mockMembers[k];
      mockKv.clear();
      // Зеркало знака чистится вместе с базой (v4.32.791): три захода идут одним
      // и тем же кадром, и без уборки второй был бы отбит как повтор.
      resetControlTsMirrorForTests();
      known();
      verdicts.push(await handleIncomingGroupControl(roleCtl(VICT, 'admin'), RCPT, ADMIN));
    }
    expect(verdicts).toEqual(['consumed', 'consumed', 'deferred']);
  });

  it('«уже в этом состоянии» по-прежнему выходит молча и без строки', async () => {
    // Идемпотентность v4.32.267 не пострадала: повторный бан не пишет вторую
    // строку и не вычитает участника ещё раз.
    expect(await handleIncomingGroupControl(ctl('ban', BANNED), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaidLines).toEqual([]);
    expect(mockApplied).toEqual([]);
  });

  it('одобрение чужой заявки мне не рассказывают как своё', async () => {
    expect(await handleIncomingGroupControl(ctl('add', NEWBIE), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaidLines).toEqual([SYS + 'Пётр вступил(а) в группу']);
    expect(roleOfLocal(NEWBIE)).toBe('member');
  });

  it('одобрение МОЕЙ заявки — рассказ есть, состав не меняется', async () => {
    expect(await handleIncomingGroupControl(ctl('add', ME), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaidLines).toEqual([SYS + 'Хозяин одобрил(а) вашу заявку на вступление']);
    expect(mockApplied).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('запись системной строки отвечает словом, а не молчанием', () => {
    expect(GRP).toContain(
      'async function insertCtlSysMessage(env: GroupCtlEnvelope, pid: number, event: string, slot?: string): Promise<GroupMessageWrite> {'
    );
    expect(GRP).toContain('return await insertGroupMessageChecked({');
    // Пустого глушителя на этом пути не осталось.
    expect(GRP).not.toContain('catch { /* дубликат — не страшно */ }');
    expect(GRP).toContain("log.warn('group_ctl_sys_row_failed'");
  });

  it('отказ откладывает кадр отдельной названной формой', () => {
    expect(GRP).toContain("function deferCtlSysRow(env: GroupCtlEnvelope, op: string): EnvelopeIntake {");
    expect(GRP).toContain("return 'deferred';");
  });

  it('каждая ветка состава читает исход строки', () => {
    for (const op of ['ban', 'unban', 'kick', 'add', 'role']) {
      expect(GRP).toContain(`return deferCtlSysRow(env, '${op}');`);
    }
  });

  it('строка пишется ДО изменения состава — иначе повтор ничего не чинит', () => {
    for (const [head, mutation] of [
      ["case 'ban': {", 'updateGroupMemberRole(env.groupId, env.target, \'banned\', pid)'],
      ["case 'unban': {", 'updateGroupMemberRole(env.groupId, env.target, \'member\', pid)'],
      ["case 'kick': {", 'removeGroupMember(env.groupId, env.target, pid)'],
      ["case 'role': {", 'updateGroupMemberRole(env.groupId, env.target, env.role, pid)'],
    ] as const) {
      const at = GRP.indexOf(head);
      expect(at).toBeGreaterThan(0);
      const branch = GRP.slice(at, GRP.indexOf('break;', at));
      expect(branch.indexOf('insertCtlSysMessage(')).toBeGreaterThan(0);
      expect(branch.indexOf('insertCtlSysMessage(')).toBeLessThan(branch.indexOf(mutation));
    }
  });

  it('знак свежести двигается после всего switch — отложенному кадру есть куда вернуться', () => {
    const at = GRP.indexOf("switch (env.op) {");
    expect(at).toBeGreaterThan(0);
    expect(GRP.indexOf('commitGroupControlTs(`m:${env.target}`', at)).toBeGreaterThan(at);
  });
});
