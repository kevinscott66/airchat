/**
 * Своя отправка в группу не считает нечитаемый состав пустой группой (v4.32.700).
 *
 * Дефект. `listGroupMembers` на сбое чтения отдаёт пустой список — это её
 * задокументированное свойство, и ровно из-за него в v4.32.648 появилась
 * `listGroupMembersRead`. Приём конвертов на неё перешёл, отправка — нет, хотя
 * тот же файл её уже импортирует. На пути отправки пустой список читался
 * дважды и оба раза давал потерю:
 *
 *   • `groupSendVerdict` → `lookupGroupActor` → пустой состав → роль null →
 *     `canSendToGroup` отвечает `not_member` → рассылка возвращает
 *     `{ ok: false, reason: 'denied' }`. Планировщик отложенных снимает строку
 *     расписания именно по отказу в правах (и правильно делает: права сами не
 *     вернутся) — назначенный на утро текст исчезает без следа, а человеку
 *     показывают «Вы не участник этой группы».
 *   • сама рассылка → пустой список адресатов → `{ ok: true, members: 0 }` →
 *     `groupSendProblem` отвечает null, потому что пустая группа бедой не
 *     считается. Локальная копия пишется, строка расписания снимается, экран
 *     молчит — сообщение не получил никто.
 *
 * Исправление разводит два ответа по сторонам, каждый в свою:
 *   • вердикт — ОТКРЫВАЕТ отправку: отказ чтения это отказ проверки, а не
 *     отказ в праве (та же политика, что у собственного catch этой функции);
 *     получатели вынесут вердикт заново и лишнее отбросят;
 *   • рассылка — ЗАКРЫВАЕТ: здесь нужны настоящие адреса, и повторить стоит.
 */
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number };

/** null здесь значит «состав не прочитался», как у настоящей listGroupMembersRead. */
let mockMembers: FakeMember[] | null = null;
const mockSent: string[] = [];

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async (id: string, pid: number) => ({
    id,
    ownerProfileId: pid,
    name: 'Двор',
    type: 'group',
    archived: false,
    isAdmin: false,
    adminOnlyPosting: false,
  })),
  // Копия настоящей пары: обёртка со сплющиванием и обёртка с третьим исходом.
  // Обе на месте, чтобы прогон ДО правки шёл по настоящему коду, а не по
  // отсутствующему имени.
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessage: jest.fn(async () => true),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
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
  listGroups: jest.fn(async () => []),
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
    sendMessage: async (peer: string) => {
      mockSent.push(peer);
      return 'ok';
    },
    groupRecipient: async () => ({ pid: 1 }),
  }),
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

import fs from 'fs';
import path from 'path';

import { fanoutGroupMessage, groupSendVerdict } from '../groupMessaging';
import { groupSendProblem, groupSendProblemShort, groupSendProblemText } from '../groupSendOutcome';

const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);
const GID = 'g-unreadable-700';

const SOCIAL = path.join(__dirname, '..');
const STORAGE = path.join(__dirname, '..', '..', 'storage');
const gmSrc = fs.readFileSync(path.join(SOCIAL, 'groupMessaging.ts'), 'utf8');
const gaSrc = fs.readFileSync(path.join(SOCIAL, 'groupActor.ts'), 'utf8');
const schedSrc = fs.readFileSync(path.join(SOCIAL, 'scheduledMessages.ts'), 'utf8');
const localSrc = fs.readFileSync(path.join(STORAGE, 'local.ts'), 'utf8');

beforeEach(() => {
  mockMembers = null;
  mockSent.length = 0;
});

describe('состав не прочитался — рассылка отказывается, а не «успешно молчит»', () => {
  it('рассылка отвечает своей причиной, а не успехом с нулём принявших', async () => {
    const res = await fanoutGroupMessage(GID, 'привет', 'Я', ME, 'm-1');
    expect(res).toEqual({ ok: false, reason: 'members_unreadable' });
    expect(mockSent).toEqual([]);
  });

  it('разбор исхода называет это недоставкой, а не отказом в правах', async () => {
    const res = await fanoutGroupMessage(GID, 'привет', 'Я', ME, 'm-2');
    const problem = groupSendProblem(res);
    expect(problem).toEqual({ kind: 'undelivered', reason: 'members_unreadable' });
    // Именно 'undelivered' спасает строку расписания: по 'denied' планировщик
    // удаляет её сразу и навсегда.
    expect(problem?.kind).not.toBe('denied');
    expect(groupSendProblemText(problem!)).toContain('Сообщение осталось только у вас.');
    expect(groupSendProblemShort(problem!)).toBe('состав не прочитан');
  });

  it('прочитанный состав по-прежнему рассылается', async () => {
    mockMembers = [
      { peerPubB64: ME, role: 'member', ownerProfileId: 1 },
      { peerPubB64: PEER, role: 'member', ownerProfileId: 1 },
    ];
    const res = await fanoutGroupMessage(GID, 'привет', 'Я', ME, 'm-3');
    expect(res).toEqual({ ok: true, members: 1, sent: 1, failed: 0 });
    expect(mockSent).toEqual([PEER]);
    expect(groupSendProblem(res)).toBeNull();
  });

  it('настоящий пустой состав по-прежнему разбирается как прежде', async () => {
    // Пустой состав — честный ответ базы, и вывод из него честный: меня среди
    // участников нет. Вердикт отвечает «не участник», исход — отказ в правах.
    // Ровно этот разбор и был бедой, пока сбой чтения выглядел так же.
    mockMembers = [];
    const res = await fanoutGroupMessage(GID, 'привет', 'Я', ME, 'm-4');
    expect(res).toEqual({ ok: false, reason: 'denied', code: 'not_member' });
    expect(groupSendProblem(res)).toEqual({ kind: 'denied', code: 'not_member' });
  });
});

describe('состав не прочитался — вердикт не превращает своё сообщение в запрещённое', () => {
  it('нечитаемый состав открывает отправку, а не закрывает её', async () => {
    const verdict = await groupSendVerdict(GID, ME, 'привет');
    expect(verdict.allowed).toBe(true);
  });

  it('на прочитанном составе вердикт по-прежнему считается', async () => {
    // Меня в составе нет — это законное «не участник», и оно обязано остаться.
    mockMembers = [{ peerPubB64: PEER, role: 'member', ownerProfileId: 1 }];
    const verdict = await groupSendVerdict(GID, ME, 'привет');
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.code).toBe('not_member');
  });
});

describe('форма правки закреплена', () => {
  it('у отправляющей стороны обе точки чтения — с третьим исходом', () => {
    expect(gmSrc).toContain('await listGroupMembersRead(groupId, (await svc.groupRecipient()).pid)');
    expect(gmSrc).toContain('const actor = await lookupGroupActorRead(groupId, senderPubB64, pid);');
    expect(gmSrc).not.toContain('await listGroupMembers(groupId, (await svc.groupRecipient()).pid)');
    expect(gmSrc).not.toContain('const actor = await lookupGroupActor(groupId, senderPubB64, pid);');
  });

  it('обёртка с третьим исходом не подменяет собой прежнюю', () => {
    // Приёму конвертов пустой ответ безобиден: конверт не применится, а
    // отправитель повторит. Обе формы живут рядом, каждая для своей стороны.
    expect(gaSrc).toContain('export async function lookupGroupActor(');
    expect(gaSrc).toContain('export async function lookupGroupActorRead(');
    expect(gaSrc).toContain('const members = await listGroupMembersRead(groupId, ownerProfileId);');
    expect(gaSrc).toContain('if (!members) return null;');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('сплющивающая обёртка по-прежнему отдаёт пустой список на сбое', () => {
    expect(localSrc).toContain('return (await readGroupMembers(groupId, ownerProfileId))?.slice() ?? [];');
    expect(localSrc).toContain('return (await readGroupMembers(groupId, ownerProfileId))?.slice() ?? null;');
  });

  it('планировщик по-прежнему удаляет строку расписания по отказу в правах', () => {
    const idx = schedSrc.indexOf("if (problem?.kind === 'denied') {");
    expect(idx).toBeGreaterThan(0);
    const window = schedSrc.slice(idx, idx + 600);
    expect(window).toContain('await deleteScheduledMessage(msg.id, pid);');
    expect(window).not.toContain('await insertGroupMessage(');
  });

  it('пустая группа по-прежнему считается законным успехом', () => {
    const outcome = fs.readFileSync(path.join(SOCIAL, 'groupSendOutcome.ts'), 'utf8');
    expect(outcome).toContain("if (res.members > 0 && res.sent === 0) return { kind: 'undelivered', reason: 'all_failed' };");
  });

  it('роль по пустому составу выходит «не участник»', () => {
    const policy = fs.readFileSync(path.join(SOCIAL, 'groupSendPolicy.ts'), 'utf8');
    expect(policy).toContain("if (role == null) return { allowed: false, code: 'not_member', reason: DENY.not_member };");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитаны', () => {
    expect(gmSrc.length).toBeGreaterThan(10000);
    expect(gaSrc.length).toBeGreaterThan(1000);
    expect(schedSrc.length).toBeGreaterThan(1000);
    expect(localSrc.length).toBeGreaterThan(10000);
  });

  it('заглушка состава действительно различает три исхода', async () => {
    const { listGroupMembers, listGroupMembersRead } = await import('../../storage/local');
    mockMembers = null;
    expect(await listGroupMembers(GID, 1)).toEqual([]);
    expect(await listGroupMembersRead(GID, 1)).toBeNull();
    mockMembers = [];
    expect(await listGroupMembersRead(GID, 1)).toEqual([]);
  });
});
