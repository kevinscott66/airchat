/**
 * Исключение не доводится до конца, пока отметка не легла на диск (v4.32.817).
 *
 * Дефект. Ветка `kick` делала три шага подряд: писала системную строку,
 * удаляла участника из состава и ставила отметку «этого отсюда исключили».
 * Первый шаг об отказе сообщал и уводил кадр в перезапрос, третий — молчал:
 * `markGroupRemoval` ничего не возвращала. Разбор шёл дальше, знак времени
 * вставал вперёд, кадр с relay исчезал.
 *
 * Цена. Отметка — единственное, что стоит между исключённым и его
 * возвращением: строки в group_members больше нет, `join` прав не спрашивает
 * (представить можно только себя), а пригласительный токен есть лишь у
 * администраторов — остальным decideInviteToken отдаёт 'unenforceable', и
 * старая ссылка проходит. Запас в памяти процесса (v4.32.787) держал отметку
 * до закрытия приложения, но пересылают ссылку когда угодно: после
 * перезапуска исключённый возвращался ко ВСЕМ, кроме администраторов. Его
 * сообщения проходили анти-спуф-фильтр у большинства группы, а
 * администраторы его не видели и удивлялись ответам на пустоту.
 *
 * Правка. Отметка ставится ДО удаления из состава, а её отказ откладывает
 * кадр. Порядок здесь и есть суть: отложить после удаления бесполезно —
 * повтор того же конверта упирается в `if (!target) return 'consumed'` в
 * начале ветки и выходит, ничего не починив. Пока участник на месте, повтор
 * доходит до отметки снова.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
  requireApproval: boolean; anonymousPosting: boolean; slowModeSeconds: number;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };

/** Отказывает ли база на записи ОТМЕТКИ. Прочие ключи пишутся как всегда. */
let mockMarkWriteFails = false;
/** Необратимые шаги по порядку. */
const mockApplied: string[] = [];
/** Тексты системных строк. */
const mockSaidLines: string[] = [];

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, FakeMember[]> = {};
const mockKv = new Map<string, string>();

/** Тот же префикс, что и в groupRemovalMark: по нему видно отметку в базе. */
const mockMarkPrefix = 'grp_removed_v1:';

const ME = 'M'.repeat(43);
const ADMIN = 'A'.repeat(43);
const VICTIM = 'V'.repeat(43);
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
  insertGroupMessageChecked: jest.fn(async (row: { text: string }) => {
    mockSaidLines.push(row.text);
    return 'inserted';
  }),
  updateGroupMessageText: jest.fn(async () => true),
  deleteGroupMessage: jest.fn(async () => {}),
  deleteGroupMessageChecked: jest.fn(async () => 'deleted'),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  createGroup: jest.fn(async () => {}),
  createGroupWithRoster: jest.fn(async () => true),
  upsertGroupMember: jest.fn(async (row: { groupId: string; peerPubB64: string; role: string; ownerProfileId: number }) => {
    mockApplied.push(`upsert:${row.peerPubB64.slice(0, 1)}:${row.role}`);
    const list = mockMembers[row.groupId] ?? (mockMembers[row.groupId] = []);
    const found = list.find((m) => m.peerPubB64 === row.peerPubB64);
    if (found) found.role = row.role;
    else list.push({ peerPubB64: row.peerPubB64, role: row.role, ownerProfileId: row.ownerProfileId });
  }),
  updateGroupMemberRole: jest.fn(async (gid: string, pub: string, role: string) => {
    mockApplied.push(`role:${pub.slice(0, 1)}:${role}`);
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
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    // Занятая база — ровно на одном ключе: знак времени и всё остальное
    // должны ложиться как обычно, иначе проверка сказала бы лишь «когда
    // сломано всё, разбор останавливается».
    if (mockMarkWriteFails && k.includes(mockMarkPrefix)) throw new Error('database is locked');
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
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, blockedListReadable: () => true, isBlocked: () => false },
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

import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { handleIncomingGroupControl } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';
import { resetControlTsMirrorForTests } from '../controlWatermark';
import { wasRemovedFromGroup } from '../groupRemovalMark';

const RCPT = { pid: 1, pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) }, myPub: ME } as unknown as GroupRecipient;

/** Группа, где ADMIN — владелец, а VICTIM и я — обычные участники. */
function known(gid: string): void {
  mockGroups.push({
    id: gid, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
    isAdmin: false, adminOnlyPosting: false, adminOnlyPinning: false,
    requireApproval: false, anonymousPosting: false, slowModeSeconds: 0,
  });
  mockMembers[gid] = [
    { peerPubB64: ADMIN, role: 'owner', ownerProfileId: 1, displayName: 'Хозяин' },
    { peerPubB64: ME, role: 'member', ownerProfileId: 1, displayName: 'Я' },
    { peerPubB64: VICTIM, role: 'member', ownerProfileId: 1, displayName: 'Сосед' },
  ];
}

const kick = (gid: string, ts = TS) =>
  encodeGroupCtlEnvelope({
    op: 'kick', groupId: gid, ts, target: VICTIM, targetName: 'Сосед', actorName: 'Хозяин',
  } as never);

/** Лежит ли отметка об исключении в базе. Ключ профильный: `p1:`. */
const markOnDisk = (gid: string): boolean =>
  [...mockKv.keys()].some((k) => k.includes(mockMarkPrefix) && k.includes(gid));

/** Остался ли человек в составе. */
const inRoster = (gid: string, pub: string): boolean =>
  (mockMembers[gid] ?? []).some((m) => m.peerPubB64 === pub);

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
const MARK = codeOnly(readFileSync(pathJoin(__dirname, '..', 'groupRemovalMark.ts'), 'utf8'));

beforeEach(() => {
  resetControlTsMirrorForTests();
  mockGroups.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  mockKv.clear();
  mockApplied.length = 0;
  mockSaidLines.length = 0;
  mockMarkWriteFails = false;
  jest.clearAllMocks();
});

describe('отметка не легла — исключение не доведено до конца', () => {
  it('кадр откладывается, а не считается разобранным', async () => {
    const gid = 'g-817-defer';
    known(gid);
    mockMarkWriteFails = true;
    expect(await handleIncomingGroupControl(kick(gid), RCPT, ADMIN)).toBe('deferred');
  });

  it('участник остаётся в составе: иначе повтор выйдет на `if (!target)`', async () => {
    const gid = 'g-817-roster';
    known(gid);
    mockMarkWriteFails = true;
    await handleIncomingGroupControl(kick(gid), RCPT, ADMIN);
    expect(mockApplied).not.toContain('remove:V');
    expect(inRoster(gid, VICTIM)).toBe(true);
  });

  it('база освободилась — тот же кадр доводит исключение до конца', async () => {
    const gid = 'g-817-repair';
    known(gid);
    mockMarkWriteFails = true;
    expect(await handleIncomingGroupControl(kick(gid), RCPT, ADMIN)).toBe('deferred');
    expect(markOnDisk(gid)).toBe(false);

    // Знак времени не сдвинут — тот же ts проходит заново.
    mockMarkWriteFails = false;
    expect(await handleIncomingGroupControl(kick(gid), RCPT, ADMIN)).toBe('consumed');
    expect(markOnDisk(gid)).toBe(true);
    expect(inRoster(gid, VICTIM)).toBe(false);
  });

  it('после перезапуска отметка на месте — исключённый не вернётся по старой ссылке', async () => {
    const gid = 'g-817-restart';
    known(gid);
    mockMarkWriteFails = true;
    await handleIncomingGroupControl(kick(gid), RCPT, ADMIN);
    mockMarkWriteFails = false;
    await handleIncomingGroupControl(kick(gid), RCPT, ADMIN);

    // Запас в памяти процесса перезапуск не переживёт — спрашиваем диск.
    expect(markOnDisk(gid)).toBe(true);
    expect(await wasRemovedFromGroup(gid, VICTIM, 1)).toBe(true);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Откладывать можно только то, что при исправной базе проходит само. Обычное
 * исключение обязано разбираться с первого раза и делать всё то же, что
 * делало раньше.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычное исключение разбирается с первого раза', () => {
  it('кадр разобран, состав и счётчик обновлены, строка рассказана', async () => {
    const gid = 'g-817-ok';
    known(gid);
    expect(await handleIncomingGroupControl(kick(gid), RCPT, ADMIN)).toBe('consumed');
    expect(mockApplied).toContain('remove:V');
    expect(mockApplied).toContain('recount');
    expect(mockSaidLines).toEqual([expect.stringContaining('Сосед исключён(а) из группы')]);
    expect(markOnDisk(gid)).toBe(true);
  });

  it('исключение того, кого в группе нет, по-прежнему молча разобрано', async () => {
    const gid = 'g-817-absent';
    mockGroups.push({
      id: gid, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
      isAdmin: false, adminOnlyPosting: false, adminOnlyPinning: false,
      requireApproval: false, anonymousPosting: false, slowModeSeconds: 0,
    });
    mockMembers[gid] = [{ peerPubB64: ADMIN, role: 'owner', ownerProfileId: 1 }];
    expect(await handleIncomingGroupControl(kick(gid), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaidLines).toEqual([]);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Запас в памяти (v4.32.787) отвечает за диск наравне с ним — и потому легко
 * принять его за решение. Он им не является: базе отметку так и не отдали.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: запас живёт только в памяти процесса', () => {
  it('отказ записи оставляет базу пустой, хотя спрашивающий получает «да»', async () => {
    const gid = 'g-817-alive';
    known(gid);
    mockMarkWriteFails = true;
    await handleIncomingGroupControl(kick(gid), RCPT, ADMIN);
    // Диску отметку не отдали…
    expect([...mockKv.keys()].filter((k) => k.includes(mockMarkPrefix))).toEqual([]);
    // …а в этой сессии она всё же отвечает: иначе исключённый вернулся бы
    // немедленно, не дожидаясь перезапуска.
    expect(await wasRemovedFromGroup(gid, VICTIM, 1)).toBe(true);
  });
});

describe('форма исходников: отметка ставится до удаления из состава', () => {
  const kickBranch = (): string => {
    const at = GRP.indexOf("case 'kick': {");
    expect(at).toBeGreaterThan(0);
    return GRP.slice(at, GRP.indexOf("case 'add': {", at));
  };

  it('вызов отметки стоит раньше удаления участника', () => {
    const body = kickBranch();
    const marked = body.indexOf('markGroupRemoval(env.groupId, env.target, pid, env.ts)');
    const removed = body.indexOf('removeGroupMember(env.groupId, env.target, pid)');
    expect(marked).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
    expect(marked).toBeLessThan(removed);
  });

  it('ответ отметки прочитан, а не выброшен', () => {
    const body = kickBranch();
    expect(body).toContain("return 'deferred';");
    expect(body.split('\n').filter((l) => l.trim().startsWith('await markGroupRemoval('))).toEqual([]);
  });

  it('сама отметка отвечает словом, легла ли она на диск', () => {
    expect(MARK).toContain('export async function markGroupRemoval(');
    expect(MARK).toMatch(/markGroupRemoval\([^)]*\n(?:[^)]*\n)*?\): Promise<boolean> \{/);
  });
});
