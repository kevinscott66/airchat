/**
 * Занятая база больше не отменяет удаление «у всех» (v4.32.766).
 *
 * Правка, удаление и закрепление приходят в группу служебным конвертом и
 * находят свою цель по `env.msgId`. Цель читалась схлопывающей
 * `getGroupMessageTarget`: она отдаёт один и тот же `null` и на «такого
 * сообщения у меня нет», и на отказ базы — это её задокументированное
 * свойство, ради которого в v4.32.763 завели различающую
 * `getGroupMessageTargetRead`. Здесь её не применили, хотя она лежала рядом и
 * ни одним другим местом не использовалась.
 *
 * Отказ уходил в `group_ctl_msgop_unknown_msg` уровнем debug и наружу — в
 * `'consumed'`. Это слово двигает метку «докуда прочитано» у ретранслятора, а
 * второго конверта у служебных операций нет: автор свою копию уже удалил и
 * больше ничего не пошлёт. Итог — у этого одного участника удалённое
 * сообщение остаётся видимым навсегда, а отредактированное навсегда остаётся
 * со старым текстом. У остальных при этом всё применилось, так что и заметить
 * расхождение некому.
 *
 * Что правка допустима, видно по соседям в той же ветке: отказ ЗАПИСИ
 * закрепления откладывает кадр с v4.32.758, а отказ чтения цели — нет, хотя
 * беда та же и проходит она сама.
 *
 * Отложить можно только то, что пройдёт само. «Такого сообщения нет» таким не
 * является: своим оно от перезапроса не станет, а вечный перезапрос запер бы
 * метку чтения навсегда. Это проверяется отдельно, для всех трёх операций.
 *
 * Водяной знак свежести при этом не мешает второй попытке: `groupMessageTsFresh`
 * спрашивают ПОСЛЕ чтения цели, а сдвигают знак и вовсе после применения.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean; adminOnlyPinning: boolean;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };

/** Что ответит чтение цели: как настоящая getGroupMessageTargetRead. */
let mockTarget: 'found' | 'missing' | 'failed' = 'found';
/** Применённые операции — чтобы видеть, дошло ли дело до записи. */
const mockApplied: string[] = [];

let mockGroupRow: FakeGroup | null = null;
let mockMembers: FakeMember[] = [];

const GID = 'g-766';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);
const MSG = 'm-766';

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async () => mockGroupRow),
  getGroupRead: jest.fn(async () =>
    mockGroupRow ? { state: 'found', value: mockGroupRow } : { state: 'missing' }),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => mockMembers),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  // Та самая пара: схлопывающая форма и форма с третьим исходом. Обе на месте,
  // чтобы прогон ДО правки шёл по настоящему коду, а не по пустому имени.
  getGroupMessageTarget: jest.fn(async () =>
    mockTarget === 'found' ? { groupId: 'g-766', senderPubB64: 'P'.repeat(43), text: 'старый текст' } : null),
  getGroupMessageTargetRead: jest.fn(async () =>
    mockTarget === 'failed'
      ? { state: 'failed' }
      : mockTarget === 'missing'
        ? { state: 'missing' }
        : { state: 'found', value: { groupId: 'g-766', senderPubB64: 'P'.repeat(43), text: 'старый текст' } }),
  updateGroupMessageText: jest.fn(async () => { mockApplied.push('edit'); return true; }),
  deleteGroupMessage: jest.fn(async () => {}),
  deleteGroupMessageChecked: jest.fn(async () => { mockApplied.push('del'); return 'deleted'; }),
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
  commitGroupControlTs: jest.fn(async () => {}),
  commitGroupMessageTs: jest.fn(async () => {}),
  commitGroupPinTs: jest.fn(async () => {}),
  groupControlTsFresh: jest.fn(async () => true),
  groupMessageTsFresh: jest.fn(async () => true),
  groupPinTsFresh: jest.fn(async () => true),
}));
jest.mock('../groupPinSync', () => ({
  applyLocalPin: jest.fn(async () => { mockApplied.push('pin'); return { ok: true }; }),
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
import { handleIncomingGroupControl } from '../groupMessaging';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import type { GroupRecipient } from '../groupRecipient';

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

/** Правка своего сообщения автором. */
function edit(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID, ts: Date.now(), op: 'edit', msgId: MSG, text: 'новый текст', actorName: 'Пётр',
  } as never);
}

/** Удаление своего сообщения автором — то самое «удалить у всех». */
function del(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID, ts: Date.now(), op: 'del', msgId: MSG, actorName: 'Пётр',
  } as never);
}

/** Закрепление сообщения участником. */
function pin(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID, ts: Date.now(), op: 'pin', msgId: MSG, on: true, actorName: 'Пётр',
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
  mockTarget = 'found';
  mockApplied.length = 0;
  jest.clearAllMocks();
});

describe('цель служебного конверта не прочиталась', () => {
  it('правка откладывается, а не съедается', async () => {
    mockTarget = 'failed';
    expect(await handleIncomingGroupControl(edit(), RCPT, PEER)).toBe('deferred');
  });

  it('удаление «у всех» откладывается, а не съедается', async () => {
    mockTarget = 'failed';
    expect(await handleIncomingGroupControl(del(), RCPT, PEER)).toBe('deferred');
  });

  it('закрепление откладывается, а не съедается', async () => {
    mockTarget = 'failed';
    expect(await handleIncomingGroupControl(pin(), RCPT, PEER)).toBe('deferred');
  });

  it('и ни одна из трёх операций при этом ничего не применяет', async () => {
    mockTarget = 'failed';
    for (const env of [edit(), del(), pin()]) {
      await handleIncomingGroupControl(env, RCPT, PEER);
    }
    expect(mockApplied).toEqual([]);
  });
});

describe('такого сообщения у нас нет', () => {
  it('все три операции остаются разобранными', async () => {
    mockTarget = 'missing';
    for (const [name, env] of [['edit', edit()], ['del', del()], ['pin', pin()]] as const) {
      // Своим чужое сообщение от перезапроса не станет, а вечный перезапрос
      // запер бы метку чтения навсегда.
      expect([name, await handleIncomingGroupControl(env, RCPT, PEER)]).toEqual([name, 'consumed']);
    }
    expect(mockApplied).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: с прочитанной целью всё применяется как прежде', () => {
  it('правка меняет текст', async () => {
    expect(await handleIncomingGroupControl(edit(), RCPT, PEER)).toBe('consumed');
    expect(mockApplied).toEqual(['edit']);
  });

  it('удаление стирает строку', async () => {
    expect(await handleIncomingGroupControl(del(), RCPT, PEER)).toBe('consumed');
    expect(mockApplied).toEqual(['del']);
  });

  it('закрепление ложится в шапку', async () => {
    expect(await handleIncomingGroupControl(pin(), RCPT, PEER)).toBe('consumed');
    expect(mockApplied).toEqual(['pin']);
  });

  it('сообщение из ЧУЖОЙ группы по-прежнему отвергается, а не откладывается', async () => {
    mockGroupRow = { ...known(), id: GID };
    // Цель лежит в g-766, а конверт назвал другую группу: это не заминка базы,
    // а подделка, и перезапрашивать её незачем (v4.32.342).
    const foreign = encodeGroupCtlEnvelope({
      groupId: 'g-другая', ts: Date.now(), op: 'del', msgId: MSG, actorName: 'Пётр',
    } as never);
    mockGroupRow = { ...known(), id: 'g-другая' };
    expect(await handleIncomingGroupControl(foreign, RCPT, PEER)).toBe('consumed');
    expect(mockApplied).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('схлопывающая форма по-прежнему теряет разницу — потому её здесь и нет', () => {
    expect(LOCAL).toContain('return lookupValue(await getGroupMessageTargetRead(messageId, ownerProfileId));');
    expect(LOCAL).toContain('export async function getGroupMessageTargetRead(');
  });

  it('оба места приёма спрашивают различающей формой', () => {
    expect(GRP.split('getGroupMessageTargetRead(env.msgId, pid)').length - 1).toBe(2);
    expect(GRP).not.toContain('getGroupMessageTarget(env.msgId, pid)');
  });

  it('отказ чтения назван отказом в журнале, а не «неизвестным сообщением»', () => {
    expect(GRP).toContain("log.warn('group_ctl_msgop_target_unreadable'");
    expect(GRP).toContain("log.warn('group_ctl_pin_target_unreadable'");
    expect(GRP.split("return 'deferred';").length - 1).toBeGreaterThanOrEqual(5);
  });

  it('водяной знак спрашивают ПОСЛЕ чтения цели — иначе вторая попытка не прошла бы', () => {
    const at = GRP.indexOf("if (env.op === 'edit' || env.op === 'del') {");
    expect(at).toBeGreaterThan(0);
    const branch = GRP.slice(at, GRP.indexOf("if (env.op === 'pin') {", at));
    expect(branch.indexOf('getGroupMessageTargetRead(')).toBeLessThan(branch.indexOf('groupMessageTsFresh('));
    // И сдвигают знак только после применения.
    expect(branch.indexOf('commitGroupMessageTs(')).toBeGreaterThan(branch.indexOf('groupMessageTsFresh('));
  });

  it('сосед в той же ветке откладывает отказ записи — с него и списано', () => {
    const at = GRP.indexOf("if (env.op === 'pin') {");
    const branch = GRP.slice(at, at + 2000);
    expect(branch).toContain('if (!write.ok) {');
    expect(branch).toContain("return 'deferred';");
  });
});
