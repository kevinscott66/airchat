/**
 * Архив — это «убрать с глаз», а не «выйти из группы» (v4.32.511).
 *
 * Дефект. Приём конвертов группы спрашивал «а наша ли это группа?» запросом
 * `listGroups`, а тот отдаёт только `archived = 0`. То есть вопрос на самом
 * деле звучал «есть ли эта группа в моём СПИСКЕ», и ответ «нет» получала не
 * только чужая группа, но и собственная, убранная в архив. Убирается она одним
 * движением по строке в списке, пункт называется «В архив», рядом живёт кнопка
 * «Разархивировать» — то есть человек прячет группу, а не выходит из неё.
 *
 * Пока группа лежала в архиве:
 *   • её сообщения съедались как «неизвестная группа» — молча, без строки в
 *     переписке и без следа в интерфейсе; после «Разархивировать» их уже
 *     ничем не вернуть, отправители об этом не узнают;
 *   • реакции, голоса в опросах, завершение опроса и отметки о прочтении не
 *     принимались тоже — их приём идёт через lookupGroupActor, а он спрашивал
 *     тем же запросом;
 *   • заявки на вступление пропадали у администратора;
 *   • и главное: ветка 'invite' управляющего конверта применима именно к
 *     НЕИЗВЕСТНОЙ группе, а защита от повторного применения — это `if (group)
 *     return true`. Своя группа в архиве проходила эту защиту насквозь, и
 *     приглашение применялось целиком: приславший становился администратором,
 *     хозяин группы — рядовым участником, состав переписывался присланным
 *     списком. Достаточно знать идентификатор группы и быть контактом.
 *
 * Здесь проверяется поведение обоих приёмников на архивной группе и отдельно —
 * что старый способ поиска действительно давал «чужая»: иначе зелёный тест не
 * значил бы ничего.
 */
type FakeGroup = {
  id: string;
  ownerProfileId: number;
  name: string;
  type: 'group' | 'channel' | 'supergroup';
  archived: boolean;
  isAdmin?: boolean;
  adminOnlyPosting?: boolean;
  anonymousPosting?: boolean;
  requireApproval?: boolean;
  inviteToken?: string | null;
};

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, Array<{ peerPubB64: string; role: string; ownerProfileId: number }>> = {};
const mockInserted: Array<{ groupId: string; text: string }> = [];
const mockJoinRequests: unknown[][] = [];
const mockCreated: unknown[][] = [];
const mockUpserts: Array<{ peerPubB64: string; role: string }> = [];

jest.mock('../../storage/local', () => ({
  // Копия настоящего запроса: строка ищется по составному ключу и про архив не
  // знает ничего — `SELECT * FROM groups WHERE id = ? AND owner_profile_id = ?`.
  getGroup: jest.fn(async (id: string, pid: number) =>
    mockGroups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null),
  // Тоже копия настоящего, вместе с той самой оговоркой:
  // `SELECT * FROM groups WHERE owner_profile_id = ? AND archived = 0`.
  // В production-коде больше не зовётся — нужен здесь, чтобы показать, чем
  // отличался прежний ответ.
  listGroups: jest.fn(async (pid: number) =>
    mockGroups.filter((g) => g.ownerProfileId === pid && !g.archived)),
  listGroupMembers: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessage: jest.fn(async (row: { groupId: string; text: string }) => { mockInserted.push(row); return true; }),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  insertGroupJoinRequest: jest.fn(async (...a: unknown[]) => {
    mockJoinRequests.push(a);
    return { created: true };
  }),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  createGroup: jest.fn(async (...a: unknown[]) => { mockCreated.push(a); }),
  upsertGroupMember: jest.fn(async (m: { peerPubB64: string; role: string }) => { mockUpserts.push(m); }),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async () => {}),
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
  encodeGroupMsgEnvelope,
  handleIncomingGroupControl,
  handleIncomingGroupEnvelope,
  handleIncomingGroupJoinRequest,
} from '../groupMessaging';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { listGroups } from '../../storage/local';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-archived-1';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);
const STRANGER = 'S'.repeat(43);
const PID = 1;

const RCPT = {
  pid: PID,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Своя группа, лежащая в архиве: строка на месте, из списка скрыта. */
function archivedGroup(extra: Partial<FakeGroup> = {}, myRole = 'owner'): void {
  mockGroups.push({
    id: GID,
    ownerProfileId: PID,
    name: 'Двор',
    type: 'group',
    archived: true,
    isAdmin: true,
    ...extra,
  });
  mockMembers[GID] = [
    { peerPubB64: ME, role: myRole, ownerProfileId: PID },
    { peerPubB64: PEER, role: 'member', ownerProfileId: PID },
  ];
}

function msgFrom(sender: string, text: string): string {
  return encodeGroupMsgEnvelope({
    groupId: GID,
    msgId: `m-${text}`,
    senderName: 'Пётр',
    senderPubB64: sender,
    text,
    ts: Date.now(),
  });
}

beforeEach(() => {
  mockGroups.length = 0;
  mockInserted.length = 0;
  mockJoinRequests.length = 0;
  mockCreated.length = 0;
  mockUpserts.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  jest.clearAllMocks();
});

describe('сообщения в группу, убранную в архив', () => {
  it('доходят и сохраняются', async () => {
    archivedGroup();
    await handleIncomingGroupEnvelope(msgFrom(PEER, 'привет'), RCPT, PEER);
    expect(mockInserted.map((r) => r.text)).toEqual(['привет']);
  });

  it('в архиве действуют те же права, что и вне его', async () => {
    // Канал с «пишут только администраторы»: архив не смягчает правила и не
    // ужесточает их — решение по-прежнему выносит groupSendPolicy.
    archivedGroup({ type: 'channel', adminOnlyPosting: true });
    await handleIncomingGroupEnvelope(msgFrom(PEER, 'реклама'), RCPT, PEER);
    expect(mockInserted).toEqual([]);
  });

  it('чужая группа своей от этого не становится', async () => {
    mockGroups.push({ id: GID, ownerProfileId: 2, name: 'Двор', type: 'group', archived: false });
    await handleIncomingGroupEnvelope(msgFrom(PEER, 'привет'), RCPT, PEER);
    expect(mockInserted).toEqual([]);
  });

  it('незнакомая группа по-прежнему отбрасывается', async () => {
    await handleIncomingGroupEnvelope(msgFrom(PEER, 'привет'), RCPT, PEER);
    expect(mockInserted).toEqual([]);
  });
});

describe('заявка на вступление в архивную группу', () => {
  function joinRequest(): string {
    return GROUP_JOIN_REQUEST_PREFIX + JSON.stringify({
      groupId: GID,
      groupName: 'Двор',
      requesterPubB64: STRANGER,
      requesterName: 'Гость',
      ts: Date.now(),
    });
  }

  it('доходит до администратора', async () => {
    archivedGroup();
    await handleIncomingGroupJoinRequest(joinRequest(), RCPT, STRANGER);
    expect(mockJoinRequests).toHaveLength(1);
  });

  it('к неадминистратору не попадает — это правило архив не отменяет', async () => {
    // v4.32.512: «неадминистратор» — это роль в group_members, а не колонка
    // groups.is_admin; она с тех пор лишь запасной ответ на пустой список.
    archivedGroup({ isAdmin: false }, 'member');
    await handleIncomingGroupJoinRequest(joinRequest(), RCPT, STRANGER);
    expect(mockJoinRequests).toEqual([]);
  });
});

describe('приглашение в собственную архивную группу', () => {
  function invite(from: string): string {
    return encodeGroupCtlEnvelope({
      op: 'invite',
      groupId: GID,
      groupName: 'Двор',
      groupType: 'group',
      members: [{ pub: from, name: 'Чужой' }],
      ts: Date.now(),
      actorName: 'Чужой',
    });
  }

  it('отбивается: состав и роли остаются нашими', async () => {
    // Тот самый захват. До правки архивная группа читалась как незнакомая,
    // ветка 'invite' проходила защиту `if (group) return true` насквозь и
    // переписывала таблицу участников присланным списком: приславший —
    // администратором, хозяин группы — рядовым участником.
    archivedGroup();
    const consumed = await handleIncomingGroupControl(invite(STRANGER), RCPT, STRANGER);
    expect(consumed).toBe(true);
    expect(mockCreated).toEqual([]);
    expect(mockUpserts).toEqual([]);
  });

  it('приглашение в группу, которой у нас нет, по-прежнему применяется', async () => {
    // Ратчет с двух сторон: правка закрывает захват, но не ломает вступление.
    const consumed = await handleIncomingGroupControl(invite(STRANGER), RCPT, STRANGER);
    expect(consumed).toBe(true);
    expect(mockCreated).toHaveLength(1);
    expect(mockUpserts.find((m) => m.peerPubB64 === STRANGER)?.role).toBe('admin');
    expect(mockUpserts.find((m) => m.peerPubB64 === ME)?.role).toBe('member');
  });
});

describe('BEFORE — чем отвечал прежний способ поиска', () => {
  it('своя архивная группа выглядела чужой', async () => {
    archivedGroup();
    // Ровно та строка, что стояла на всех пяти местах приёма.
    const asBefore = (await listGroups(PID)).find((g) => g.id === GID);
    expect(asBefore).toBeUndefined();
  });

  it('а неархивная — своей: разница ровно в архиве, и больше ни в чём', async () => {
    archivedGroup({ archived: false });
    const asBefore = (await listGroups(PID)).find((g) => g.id === GID);
    expect(asBefore?.id).toBe(GID);
  });
});
