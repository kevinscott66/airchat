/**
 * Сброс пригласительной ссылки вслепую выдавал себя за разосланный (v4.32.753).
 *
 * Дефект. `rotateGroupInviteToken` записывала новый токен, а потом брала
 * список администраторов через `listGroupMembers` — схлопывающее чтение: отказ
 * базы оно отдаёт тем же пустым списком, что и «кроме меня никого». Пустой
 * список адресатов в группе законен, и воронка честно отвечает на него
 * «разослано нулю» (`sent: true, recipients: 0`). Значит секунда занятой базы
 * давала исход «состоялось»: экран показывал «Ссылка сброшена — прежние больше
 * не действуют», а второй администратор о новом токене не узнавал никогда.
 * Повтора у служебного конверта нет.
 *
 * Цена ровно та, ради которой в v4.32.452 исход рассылки и вытащили наверх: у
 * второго администратора кнопка «Пригласительная ссылка» продолжает выдавать
 * ссылки, которые группа уже не пускает, и понять это ему неоткуда — приглашённый
 * просто не попадает в группу.
 *
 * Правка. Состав читается различающим `listGroupMembersRead` — тем же приёмом,
 * что у рассылки управляющего конверта в v4.32.737. Нечитаемый состав даёт
 * `{ sent: false, reason: 'members_unreadable' }`, и `inviteTokenSpreadProblem`
 * говорит человеку правду. Сам токен при этом остаётся новым: он уже записан,
 * прежние ссылки уже отозваны, и прятать это было бы второй ложью.
 */
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number };

/** Состав группы. null — «состав не прочитался», как у listGroupMembersRead. */
let mockMembers: FakeMember[] | null = [];
/** Аргументы каждого updateGroupMeta — токен обязан лечь в базу до рассылки. */
const mockMetaWrites: unknown[][] = [];
/** Кому ушёл служебный конверт: воронку подменяем, сеть не нужна. */
let mockFanoutTo: string[] | null = null;

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async () => null),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  updateGroupMeta: jest.fn(async (...a: unknown[]) => { mockMetaWrites.push(a); }),
  insertGroupMessage: jest.fn(async () => true),
  // v4.32.765: приёмник группы пишет различающей формой — она отличает
  // настоящий повтор от отказа базы. Предмет этого набора другой.
  insertGroupMessageChecked: jest.fn(async () => 'inserted'),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  createGroup: jest.fn(async () => {}),
  upsertGroupMember: jest.fn(async () => {}),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
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
  getMessagingService: () => ({ sendMessage: async () => 'cid', groupRecipient: async () => null }),
}));
jest.mock('../controlFanout', () => {
  const actual = jest.requireActual('../controlFanout');
  return {
    ...actual,
    fanoutControlEnvelope: jest.fn(async (_op: string, _p: string, t: { recipients?: string[] }) => {
      mockFanoutTo = t.recipients ?? [];
      return { sent: true, recipients: mockFanoutTo.length };
    }),
  };
});
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
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
import { join } from 'path';

import { inviteTokenSpreadProblem } from '../groupControlOutcome';
import { rotateGroupInviteToken } from '../groupMessaging';

const GID = 'g-753';
const ME = 'M'.repeat(43);
const ADMIN = 'A'.repeat(43);
const PLAIN = 'P'.repeat(43);

/** Строка участника с нужной ролью — состав держим минимальным. */
function member(pub: string, role: string): FakeMember {
  return { peerPubB64: pub, role, ownerProfileId: 1 };
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Тело функции: от объявления до строки, закрывающей его. */
function bodyOf(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.includes(`export async function ${name}(`));
  if (start < 0) return '';
  let end = start;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

beforeEach(() => {
  mockMembers = [];
  mockMetaWrites.length = 0;
  mockFanoutTo = null;
});

describe('состав группы не прочитался', () => {
  it('исход рассылки — отказ с причиной, а не «разослано нулю»', async () => {
    mockMembers = null;

    const res = await rotateGroupInviteToken(GID, 1, ME, 'Я');

    expect(res.announced).toEqual({ op: 'meta', sent: false, reason: 'members_unreadable' });
  });

  it('человеку говорят про ссылку, а не про «настройку»', async () => {
    mockMembers = null;

    const res = await rotateGroupInviteToken(GID, 1, ME, 'Я');

    const text = inviteTokenSpreadProblem(res.announced!);
    expect(text).toContain('Ссылка сброшена только у вас (состав группы не прочитан)');
    expect(text).toContain('продолжит выдавать ссылки, которые группа уже не пускает');
  });

  it('токен всё равно новый и записан: прежние ссылки уже отозваны', async () => {
    mockMembers = null;

    const res = await rotateGroupInviteToken(GID, 1, ME, 'Я');

    expect(res.token).toHaveLength(22);
    expect(mockMetaWrites).toHaveLength(1);
    expect(mockMetaWrites[0][2]).toEqual({ inviteToken: res.token });
  });

  it('в сеть при этом ничего не уходит', async () => {
    mockMembers = null;

    await rotateGroupInviteToken(GID, 1, ME, 'Я');

    expect(mockFanoutTo).toBeNull();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: пустой состав остаётся пустым составом', () => {
  it('я единственный администратор — рассылать правда некому, и это успех', async () => {
    mockMembers = [member(ME, 'owner'), member(PLAIN, 'member')];

    const res = await rotateGroupInviteToken(GID, 1, ME, 'Я');

    expect(res.announced).toEqual({ op: 'meta', sent: true, recipients: 0 });
    expect(inviteTokenSpreadProblem(res.announced!)).toBeNull();
    expect(mockFanoutTo).toEqual([]);
  });

  it('второй администратор есть — конверт уходит именно ему', async () => {
    mockMembers = [member(ME, 'owner'), member(ADMIN, 'admin'), member(PLAIN, 'member')];

    const res = await rotateGroupInviteToken(GID, 1, ME, 'Я');

    expect(mockFanoutTo).toEqual([ADMIN]);
    expect(res.announced).toEqual({ op: 'meta', sent: true, recipients: 1 });
  });

  it('обычному участнику токен не раздают: иначе отзыв бессмыслен', async () => {
    mockMembers = [member(ME, 'owner'), member(PLAIN, 'member')];

    await rotateGroupInviteToken(GID, 1, ME, 'Я');

    expect(mockFanoutTo).not.toContain(PLAIN);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8');

  it('сброс читает состав различающим чтением и отсекает отказ до рассылки', () => {
    const body = codeOnly(bodyOf(SOURCE, 'rotateGroupInviteToken'));
    expect(body).toContain('const members = await listGroupMembersRead(groupId, ownerProfileId);');
    expect(body).toContain("return { token, announced: { op: 'meta', sent: false, reason: 'members_unreadable' } };");
    // Схлопывающего чтения в этой функции не осталось вовсе.
    expect(body).not.toContain('await listGroupMembers(groupId, ownerProfileId)');
  });

  it('причина отказа живёт в общем словаре, а не заведена тут заново', () => {
    const fanout = codeOnly(readFileSync(join(__dirname, '..', 'controlFanout.ts'), 'utf8'));
    expect(fanout).toContain("'members_unreadable'");
    expect(fanout).toContain("if (reason === 'members_unreadable') return 'состав группы не прочитан';");
  });
});
