/**
 * Занятая база больше не съедает «удалить у всех» в группе (v4.32.772).
 *
 * v4.32.766 научила ветку отличать отказ базы от «такого сообщения нет» — но
 * только на ЧТЕНИИ цели. Сама запись вызывалась вслепую: `deleteGroupMessage`
 * отвечала `void` и гасила свой отказ в собственном `catch`. Следом шёл
 * `commitGroupMessageTs` — безусловно.
 *
 * Отсюда беда хуже обычной. Мало того что кадр объявлялся разобранным и метка
 * «докуда прочитано» у ретранслятора уходила вперёд, — сдвинутый знак свежести
 * отвергал и тот же самый кадр, принесённый relay заново: он приходил уже как
 * устаревший (`group_ctl_msgop_stale_drop`). Второго конверта у служебной
 * операции нет, автор свою копию уже удалил. У этого одного участника
 * удалённое сообщение оставалось видимым навсегда, и заметить расхождение было
 * некому.
 *
 * Близнец по той же ветке — правка — читает исход записи с v4.32.530 и знак
 * при неудаче не двигает. Здесь ровно то же самое, плюс третье слово: «ни одной
 * строки не подошло» — не отказ, повтор кадра её не заведёт.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };

/** Что ответит запись удаления: как настоящая deleteGroupMessageChecked. */
let mockDelWrite: 'deleted' | 'missing' | 'failed' = 'deleted';
/** Что ответит запись правки — прежний булев исход (v4.32.530). */
let mockEditWrite = true;
/** Применённые операции — чтобы видеть, дошло ли дело до записи. */
const mockApplied: string[] = [];

let mockGroupRow: FakeGroup | null = null;
let mockMembers: FakeMember[] = [];

const GID = 'g-772';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);
const MSG = 'm-772';

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async () => mockGroupRow),
  getGroupRead: jest.fn(async () =>
    mockGroupRow ? { state: 'found', value: mockGroupRow } : { state: 'missing' }),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => mockMembers),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  getGroupMessageTarget: jest.fn(async () => ({
    groupId: 'g-772', senderPubB64: 'P'.repeat(43), text: 'старый текст',
  })),
  getGroupMessageTargetRead: jest.fn(async () => ({
    state: 'found',
    value: { groupId: 'g-772', senderPubB64: 'P'.repeat(43), text: 'старый текст' },
  })),
  updateGroupMessageText: jest.fn(async () => {
    if (mockEditWrite) mockApplied.push('edit');
    return mockEditWrite;
  }),
  // Схлопывающая форма остаётся — её зовёт экран групп; приём зовёт
  // различающую.
  deleteGroupMessage: jest.fn(async () => {}),
  deleteGroupMessageChecked: jest.fn(async () => {
    if (mockDelWrite === 'deleted') mockApplied.push('del');
    return mockDelWrite;
  }),
  insertGroupMessage: jest.fn(async () => true),
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
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
}));

jest.mock('../controlWatermark', () => ({
  acceptGroupControlTs: jest.fn(async () => true),
  commitGroupControlTs: jest.fn(async () => {}),
  commitGroupMessageTs: jest.fn(async () => {}),
  groupControlTsFresh: jest.fn(async () => true),
  groupMessageTsFresh: jest.fn(async () => true),
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

import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { handleIncomingGroupControl } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';

const mockWatermark = jest.requireMock('../controlWatermark') as {
  commitGroupMessageTs: jest.Mock;
};
const mockLog = (jest.requireMock('../../logger') as { log: { warn: jest.Mock } }).log;

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, которую мы знаем; PEER в ней состоит и он же автор сообщения. */
function known(): FakeGroup {
  return {
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
    isAdmin: true, adminOnlyPosting: false, adminOnlyPinning: false,
  };
}

/** Удаление своего сообщения автором — то самое «удалить у всех». */
function del(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID, ts: Date.now(), op: 'del', msgId: MSG, actorName: 'Пётр',
  } as never);
}

/** Правка своего сообщения автором — близнец по той же ветке. */
function edit(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID, ts: Date.now(), op: 'edit', msgId: MSG, text: 'новый текст', actorName: 'Пётр',
  } as never);
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
const LOCAL = codeOnly(readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8'));

beforeEach(() => {
  mockGroupRow = known();
  mockMembers = [
    { peerPubB64: ME, role: 'owner', ownerProfileId: 1, displayName: 'Я' },
    { peerPubB64: PEER, role: 'member', ownerProfileId: 1, displayName: 'Пётр' },
  ];
  mockDelWrite = 'deleted';
  mockEditWrite = true;
  mockApplied.length = 0;
  jest.clearAllMocks();
});

describe('запись удаления не удалась', () => {
  it('кадр откладывается, а не съедается', async () => {
    mockDelWrite = 'failed';
    expect(await handleIncomingGroupControl(del(), RCPT, PEER)).toBe('deferred');
  });

  it('знак свежести не двигается — иначе повтор пришёл бы уже устаревшим', async () => {
    mockDelWrite = 'failed';
    await handleIncomingGroupControl(del(), RCPT, PEER);
    expect(mockWatermark.commitGroupMessageTs).not.toHaveBeenCalled();
  });

  it('отказ назван отказом в журнале', async () => {
    mockDelWrite = 'failed';
    await handleIncomingGroupControl(del(), RCPT, PEER);
    expect(mockLog.warn).toHaveBeenCalledWith(
      'group_ctl_delete_not_applied',
      expect.objectContaining({ why: 'failed' })
    );
  });

  it('база освободилась — тот же кадр стирает строку', async () => {
    mockDelWrite = 'failed';
    expect(await handleIncomingGroupControl(del(), RCPT, PEER)).toBe('deferred');
    expect(mockApplied).toEqual([]);

    mockDelWrite = 'deleted';
    expect(await handleIncomingGroupControl(del(), RCPT, PEER)).toBe('consumed');
    expect(mockApplied).toEqual(['del']);
    expect(mockWatermark.commitGroupMessageTs).toHaveBeenCalled();
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отложить можно только то, что пройдёт само. Вечный перезапрос запер бы метку
 * чтения навсегда, поэтому окончательные исходы остаются разобранными.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: окончательные исходы остаются разобранными', () => {
  it('обычное удаление стирает строку и двигает знак', async () => {
    expect(await handleIncomingGroupControl(del(), RCPT, PEER)).toBe('consumed');
    expect(mockApplied).toEqual(['del']);
    expect(mockWatermark.commitGroupMessageTs).toHaveBeenCalled();
  });

  it('стирать нечего — «разобрано»: повтор кадра строку не заведёт', async () => {
    mockDelWrite = 'missing';
    expect(await handleIncomingGroupControl(del(), RCPT, PEER)).toBe('consumed');
  });

  it('и знак при этом не двигается — как у неприменившейся правки', async () => {
    // Строка может прийти позже своего удаления: сдвинутый знак отверг бы
    // законный повтор.
    mockDelWrite = 'missing';
    await handleIncomingGroupControl(del(), RCPT, PEER);
    expect(mockWatermark.commitGroupMessageTs).not.toHaveBeenCalled();
  });

  it('три исхода записи дают два разных ответа', async () => {
    const verdicts: string[] = [];
    for (const w of ['deleted', 'missing', 'failed'] as const) {
      mockDelWrite = w;
      verdicts.push(await handleIncomingGroupControl(del(), RCPT, PEER));
    }
    expect(verdicts).toEqual(['consumed', 'consumed', 'deferred']);
  });

  it('близнец-правка ведёт себя как прежде (v4.32.530)', async () => {
    expect(await handleIncomingGroupControl(edit(), RCPT, PEER)).toBe('consumed');
    expect(mockApplied).toEqual(['edit']);

    mockEditWrite = false;
    mockApplied.length = 0;
    jest.clearAllMocks();
    expect(await handleIncomingGroupControl(edit(), RCPT, PEER)).toBe('consumed');
    expect(mockWatermark.commitGroupMessageTs).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('различающая форма записи отвечает словом, а не молчанием', () => {
    expect(LOCAL).toContain('export type GroupDeleteWrite =');
    const at = LOCAL.indexOf('export async function deleteGroupMessageChecked(');
    expect(at).toBeGreaterThan(0);
    expect(LOCAL.slice(at, at + 200)).toContain('): Promise<GroupDeleteWrite> {');
    // «Ни одной строки не подошло» стало отличимо от отказа.
    expect(LOCAL).toContain("log.warn('delete_group_message_no_row'");
  });

  it('сплющивающая форма осталась — и осталась ровно обёрткой', () => {
    // Её зовёт экран групп: там уборка своей копии, и отвечать там нечем.
    const a = LOCAL.indexOf('export async function deleteGroupMessage(');
    const b = LOCAL.indexOf('export async function deleteGroupMessageChecked(');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(LOCAL.slice(a, b)).toContain(
      'await deleteGroupMessageChecked(messageId, ownerProfileId);'
    );
    expect(LOCAL.slice(a, b)).not.toContain('DELETE FROM group_messages');
  });

  it('приёмник читает исход записи и откладывает отказ', () => {
    expect(GRP).toContain('const removed = await deleteGroupMessageChecked(env.msgId, pid);');
    expect(GRP).toContain("if (removed !== 'deleted') {");
    expect(GRP).toContain("return removed === 'failed' ? 'deferred' : 'consumed';");
    // Слепого вызова на этом пути не осталось.
    expect(GRP).not.toContain('await deleteGroupMessage(env.msgId, pid)');
  });

  it('знак свежести двигается ПОСЛЕ применения, и только после удачного', () => {
    const at = GRP.indexOf("if (env.op === 'edit') {");
    expect(at).toBeGreaterThan(0);
    const branch = GRP.slice(at, GRP.indexOf('group_ctl_msgop_applied', at));
    expect(branch.indexOf('deleteGroupMessageChecked(')).toBeLessThan(
      branch.indexOf('commitGroupMessageTs(')
    );
    // Оба неприменившихся исхода выходят из ветки до сдвига знака.
    expect(branch.split("return 'consumed';").length - 1).toBeGreaterThanOrEqual(1);
  });
});
