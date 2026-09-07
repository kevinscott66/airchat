/**
 * Состав группы, который не прочитался, — не пустая группа (v4.32.648).
 *
 * Дефект. `listGroupMembers` ловит любую ошибку чтения и отдаёт `[]`. Для
 * пятнадцати мест, которые состав ПОКАЗЫВАЮТ, это допустимо: пустой список —
 * «показывать нечего», следующий заход перерисует. Но на пустом списке
 * строятся ещё два вывода, и оба — про чужие данные:
 *
 * - «вас нет среди участников». Голос в своей же группе отклонялся с чужой
 *   причиной, а на входящем пути сообщение живого участника отбрасывалось с
 *   записью «отказано по правам»;
 * - «рассылать некому». `fanoutControlEnvelope` считает групповую рассылку
 *   удавшейся при нуле получателей (ветка no_peer — только для лички), значит
 *   `closeAndSyncPoll` печатал «Опрос завершён», не отправив ничего: у автора
 *   опрос закрыт, у всех остальных жив.
 *
 * Правка. `listGroupMembersRead` — та же выборка, но с третьим исходом, как у
 * `listContactsRead`. Оба вывода делает только тот, кто состав действительно
 * прочитал; в `closeAndSyncPoll` чтение поднято ВЫШЕ локальной записи, чтобы
 * отказ не оставлял опрос закрытым у одного автора.
 *
 * Чего правка не чинит. На приёме группового сообщения отказ чтения по-прежнему
 * ведёт к потере: вернуть `false` нельзя (это «сохрани как обычную личку», и
 * оба вызывающих всё равно отбрасывают ответ), канала переспроса нет. Улучшена
 * только честность записи в журнал — см. блок формы исходника.
 */
import fs from 'fs';
import path from 'path';

const mockKv = new Map<string, string>();
/** Состав, чтение которого «не удалось»: listGroupMembersRead отвечает null. */
let mockFailMembers = false;
/** Состав прочитался, но в группе никого: законный исход, не сбой. */
let mockEmptyMembers = false;
const mockVotesSet: string[] = [];
let mockFanouts = 0;
let mockRecipients: string[] = [];
let mockNotifies = 0;

const MSG = 'msg-poll-648';
const mockGroup = 'g648';
const mockPeer = 'peer-pub-b64-aaaa';
const mockMe = 'me-pub';
const PID = 7;
const CLOSED_KEY = `p${PID}:poll_closed_${MSG}`;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvDeleteChecked: async (k: string) => {
    mockKv.delete(k);
    return true;
  },
  kvListKeysByPrefix: async () => [],
  setPollVote: async (msgId: string, voter: string, idx: number) => {
    mockVotesSet.push(`${msgId}/${voter}/${idx}`);
  },
  deletePollVote: async () => {},
  getChatMessageTarget: async () => ({ groupId: mockGroup }),
  getGroupMessageTarget: async () => ({ groupId: mockGroup }),
  getChatMessageAuthor: async () => ({ direction: 'in', contactPubB64: mockPeer }),
  listGroupMembersRead: async () => {
    if (mockFailMembers) return null;
    if (mockEmptyMembers) return [];
    return [
      { peerPubB64: mockMe, role: 'owner' },
      { peerPubB64: mockPeer, role: 'member' },
    ];
  },
  notifyChatStorageChanged: () => {
    mockNotifies += 1;
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 7, name: 'Рабочий' }),
    getActiveIdentity: () => ({ pid: 7, myPubB64: 'me-pub' }),
  },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async (
    _op: string,
    _payload: string,
    target: { kind: string; recipients?: string[] }
  ) => {
    mockFanouts += 1;
    mockRecipients = target.recipients ?? [];
    return { sent: true, recipients: mockRecipients.length };
  },
  activeRecipients: (members: { peerPubB64: string }[], me: string) =>
    members.filter((m) => m.peerPubB64 !== me).map((m) => m.peerPubB64),
  undeliveredText: (head: string) => `${head}, но разослать не вышло.`,
  fanoutReasonText: () => '',
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { castAndSyncPollVote, closeAndSyncPoll } from '../pollVoteSync';

/** Исходник без строк-комментариев: в них старая форма упомянута нарочно. */
const srcOf = (...rel: string[]): string =>
  fs
    .readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

const LOCAL = srcOf('storage', 'local.ts');
const GM = srcOf('social', 'groupMessaging.ts');
const PV = srcOf('social', 'pollVoteSync.ts');

/** Тело функции: от объявления до первой строки `}` в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const i = src.indexOf(head);
  expect(i).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}\n', i);
  expect(end).toBeGreaterThan(i);
  return src.slice(i, end + 2);
}

const voteInGroup = (): ReturnType<typeof castAndSyncPollVote> =>
  castAndSyncPollVote({ msgId: MSG, idx: 0, on: true, multi: false, myPubB64: mockMe, groupId: mockGroup });

const closeInGroup = (): ReturnType<typeof closeAndSyncPoll> =>
  closeAndSyncPoll({ msgId: MSG, myPubB64: mockMe, groupId: mockGroup });

beforeEach(() => {
  mockKv.clear();
  mockFailMembers = false;
  mockEmptyMembers = false;
  mockVotesSet.length = 0;
  mockFanouts = 0;
  mockRecipients = [];
  mockNotifies = 0;
});

describe('повод для правки жив', () => {
  it('listGroupMembers по-прежнему отдаёт пустой список на сбое — на нём выводов не строят', () => {
    expect(bodyOf(LOCAL, 'export async function listGroupMembers(')).toContain(
      'return (await readGroupMembers(groupId, ownerProfileId))?.slice() ?? [];'
    );
  });

  it('третий исход есть у отдельной обёртки, и выборка у обеих одна', () => {
    const read = bodyOf(LOCAL, 'export async function listGroupMembersRead(');
    expect(read).toContain('): Promise<GroupMemberRow[] | null> {');
    expect(read).toContain('return (await readGroupMembers(groupId, ownerProfileId))?.slice() ?? null;');
    expect(read).not.toContain('group_members');
  });

  it('пустая группа и нечитаемая группа различимы только через неё', async () => {
    mockEmptyMembers = true;
    const empty = await closeInGroup();
    mockEmptyMembers = false;
    mockFailMembers = true;
    const broken = await closeInGroup();
    expect(empty.ok).toBe(true);
    expect(broken.ok).toBe(false);
  });
});

describe('проверка не пустая: состав читается — всё как было', () => {
  it('свой голос в группе записан и разослан живым участникам', async () => {
    await expect(voteInGroup()).resolves.toEqual({ ok: true });
    expect(mockVotesSet).toEqual([`${MSG}/${mockMe}/0`]);
    expect(mockFanouts).toBe(1);
    expect(mockRecipients).toEqual([mockPeer]);
  });

  it('завершение опроса ставит флаг, будит подписчиков и рассылает конверт', async () => {
    await expect(closeInGroup()).resolves.toEqual({ ok: true });
    expect(mockKv.get(CLOSED_KEY)).toBe('1');
    expect(mockNotifies).toBe(1);
    expect(mockFanouts).toBe(1);
    expect(mockRecipients).toEqual([mockPeer]);
  });

  it('пустой состав — законный ответ: опрос закрывается, рассылать просто некому', async () => {
    mockEmptyMembers = true;
    await expect(closeInGroup()).resolves.toEqual({ ok: true });
    expect(mockKv.get(CLOSED_KEY)).toBe('1');
    expect(mockRecipients).toEqual([]);
  });

  it('пустой состав по-прежнему отказывает в голосе: вас в группе нет', async () => {
    mockEmptyMembers = true;
    const res = await voteInGroup();
    expect(res.ok).toBe(false);
    expect(mockVotesSet).toEqual([]);
  });
});

describe('состав не прочитался — голос не записывают', () => {
  it('голос не лёг в базу и никуда не ушёл', async () => {
    mockFailMembers = true;
    const res = await voteInGroup();
    expect(res.ok).toBe(false);
    expect(mockVotesSet).toEqual([]);
    expect(mockFanouts).toBe(0);
  });

  it('причина названа по-русски и отличима от «вас тут нет» и от неизвестного состояния опроса', async () => {
    mockFailMembers = true;
    const broken = await voteInGroup();
    mockFailMembers = false;
    mockEmptyMembers = true;
    const notMember = await voteInGroup();
    if (broken.ok || notMember.ok) throw new Error('ожидался отказ');
    expect(broken.reason).toMatch(/[А-Яа-яЁё]/);
    expect(broken.reason).not.toBe(notMember.reason);
    expect(broken.reason).not.toBe('Опрос завершён');
    expect(broken.reason).not.toContain('не завершён ли опрос');
  });

  it('в личном опросе состав не читают вовсе — отказ туда не протекает', async () => {
    mockFailMembers = true;
    await expect(
      castAndSyncPollVote({ msgId: MSG, idx: 0, on: true, multi: false, myPubB64: mockMe, peerPubB64: mockPeer })
    ).resolves.toEqual({ ok: true });
    expect(mockVotesSet).toEqual([`${MSG}/${mockMe}/0`]);
  });
});

describe('состав не прочитался — опрос не завершают', () => {
  it('флаг не поставлен, подписчики не разбужены, конверт не разослан', async () => {
    mockFailMembers = true;
    const res = await closeInGroup();
    expect(res.ok).toBe(false);
    expect(mockKv.has(CLOSED_KEY)).toBe(false);
    expect(mockNotifies).toBe(0);
    expect(mockFanouts).toBe(0);
  });

  it('«завершён» не печатается при нуле получателей — рассылка не выдаётся за успех', async () => {
    mockFailMembers = true;
    const res = await closeInGroup();
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.reason).toMatch(/[А-Яа-яЁё]/);
    expect(mockRecipients).toEqual([]);
  });

  it('после того как база ответила, завершение проходит', async () => {
    mockFailMembers = true;
    await closeInGroup();
    mockFailMembers = false;
    await expect(closeInGroup()).resolves.toEqual({ ok: true });
    expect(mockKv.get(CLOSED_KEY)).toBe('1');
  });

  it('чтение состава стоит ДО локальной записи флага', () => {
    const body = bodyOf(PV, 'export async function closeAndSyncPoll(params: {');
    const read = body.indexOf('await listGroupMembersRead(');
    const write = body.indexOf('await scopedKvSetCheckedFor(');
    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeLessThan(write);
  });
});

describe('форма источника: выводы о составе делает только тот, кто его прочитал', () => {
  it('в опросах не осталось ни одного чтения без третьего исхода', () => {
    expect(PV).not.toMatch(/\blistGroupMembers\(/);
    expect((PV.match(/listGroupMembersRead\(/g) ?? []).length).toBe(2);
  });

  it('оба отказа опроса называют одну причину и пишутся в журнал', () => {
    expect(PV).toContain("const MEMBERS_UNKNOWN = 'Не удалось прочитать состав группы. Попробуйте ещё раз.';");
    expect((PV.match(/reason: MEMBERS_UNKNOWN/g) ?? []).length).toBe(2);
    expect(PV).toContain("log.warn('poll_vote_members_read_failed'");
    expect(PV).toContain("log.warn('poll_close_members_read_failed'");
  });

  it('приём группового сообщения не решает по нечитаемому составу, что отправитель чужой', () => {
    const body = bodyOf(GM, 'export async function handleIncomingGroupEnvelope(');
    expect(body).toContain('const members = await listGroupMembersRead(env.groupId, pid);');
    expect(body).toContain("if (!members) throw new Error('group_members_unreadable');");
    expect(body).toContain('role: roleOf(members, senderPubB64),');
  });

  it('и записывает такой отказ честно: «проверить не удалось», а не «отказано по правам»', () => {
    const body = bodyOf(GM, 'export async function handleIncomingGroupEnvelope(');
    const failed = body.indexOf("log.warn('group_msg_verdict_failed_drop'");
    const denied = body.indexOf("log.warn('group_msg_denied_drop'");
    expect(denied).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(denied);
    expect(body.slice(denied, failed)).toContain('} catch (e) {');
  });
});
