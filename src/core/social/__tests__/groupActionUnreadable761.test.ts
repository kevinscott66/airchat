/**
 * Занятая база больше не выдаёт себя за отсутствие прав и группы (v4.32.761).
 *
 * Дефект. `listGroupMembers` на сбое чтения отдаёт пустой список, а `getGroup`
 * отвечает одним `null` и на «такой группы нет», и на «прочитать не удалось».
 * Оба свойства задокументированы, ради обоих в v4.32.548 и v4.32.648 завели
 * различающую пару — но два действия человека на них так и остались:
 *
 *   • реакция в группе: пустой состав → роль null → `canInteractInGroup`
 *     отвечает `not_member`, и человеку сообщают, что он не участник группы,
 *     которая открыта у него на экране. Отказ выглядит окончательным, и он
 *     ему верит: права сами не появляются;
 *   • закрепление: `getGroup` вернул null → «Группа не найдена — возможно, её
 *     только что удалили», а состав, который не прочитался, молча становился
 *     ролью «участник» — право закреплять выдавалось или отнималось по
 *     ответу, которого база не давала.
 *
 * Правка. Оба пути читают тем же входом, что и приём чужого конверта:
 * реакция — `listGroupMembersRead`, закрепление — `lookupGroupActorRead`,
 * который различает и строку группы, и состав. Отказ базы получает свой текст:
 * у реакции тот же, что у опроса (v4.32.648), у закрепления — новая причина
 * `group_unreadable` рядом с `no_group`.
 */

/** Состав группы. `null` — не прочитался, как у настоящей listGroupMembersRead. */
let mockMembers: { peerPubB64: string; role: string }[] | null = null;
/** Что ответит чтение строки группы: 'found' | 'missing' | 'failed'. */
let mockGroupState: 'found' | 'missing' | 'failed' = 'found';
/** Закреплять могут только администраторы. */
let mockAdminOnlyPinning = false;
/** Записанные реакции — по порядку. */
const mockReactions: { msgId: string; emoji: string }[] = [];
/** Разосланные служебные конверты — по названию операции. */
const mockFanouts: string[] = [];
/** Значения kv профиля. */
const mockKv = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  // Обе обёртки на месте: прогон ДО правки должен идти по настоящему коду, а
  // не спотыкаться об отсутствующее имя.
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroup: jest.fn(async () => (mockGroupState === 'found' ? mockGroup() : null)),
  getGroupRead: jest.fn(async () =>
    mockGroupState === 'found'
      ? { state: 'found', value: mockGroup() }
      : { state: mockGroupState }
  ),
  toggleReaction: jest.fn(async (msgId: string, emoji: string) => {
    mockReactions.push({ msgId, emoji });
    return { ok: true, on: true };
  }),
  setGroupPinnedMessage: jest.fn(async () => {}),
  getGroupMessageTexts: jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, `текст ${id}`]))),
}));

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: async (_pid: number, key: string) => ({ value: mockKv.get(key) ?? null }),
  scopedKvSetCheckedFor: async (_pid: number, key: string, value: string) => {
    mockKv.set(key, value);
    return true;
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getActiveIdentity: () => ({ pid: 1, myPubB64: 'M'.repeat(43) }),
  },
}));

jest.mock('../controlFanout', () => ({
  activeRecipients: (members: { peerPubB64: string }[], self: string) =>
    members.filter((m) => m.peerPubB64 !== self).map((m) => m.peerPubB64),
  fanoutControlEnvelope: async (op: string) => {
    mockFanouts.push(op);
    return { sent: true };
  },
  undeliveredText: (head: string) => head,
}));

jest.mock('../groupMessaging', () => ({
  fanoutGroupControl: async () => {
    mockFanouts.push('pin');
    return { ok: true };
  },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { toggleAndSyncReaction } from '../reactionSync';
import { togglePinAndSync, groupPinRefusalText } from '../groupPinSync';

const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);
const GID = 'g-unreadable-761';

/** Строка группы в том виде, в каком её отдаёт база. */
function mockGroup(): Record<string, unknown> {
  return {
    id: 'g-unreadable-761',
    ownerProfileId: 1,
    name: 'Двор',
    type: 'group',
    archived: false,
    isAdmin: false,
    adminOnlyPinning: mockAdminOnlyPinning,
  };
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

/** Текст отказа — или пустая строка, если действие удалось. */
function refusalOf(res: { ok: boolean; reason?: string }): string {
  return res.ok ? '' : (res.reason ?? '');
}

const MEMBERS_UNKNOWN = 'Не удалось прочитать состав группы. Попробуйте ещё раз.';

beforeEach(() => {
  mockMembers = [
    { peerPubB64: ME, role: 'owner' },
    { peerPubB64: PEER, role: 'member' },
  ];
  mockGroupState = 'found';
  mockAdminOnlyPinning = false;
  mockReactions.length = 0;
  mockFanouts.length = 0;
  mockKv.clear();
});

describe('реакция: нечитаемый состав — не чужая группа', () => {
  it('состав не прочитался — отказ называет базу, а не участие', async () => {
    mockMembers = null;
    const res = await toggleAndSyncReaction({ msgId: 'm1', emoji: '👍', groupId: GID });
    expect(res.ok).toBe(false);
    expect(refusalOf(res)).toBe(MEMBERS_UNKNOWN);
    // И ничего не записано: реакция, которой не видит никто, кроме автора,
    // хуже честного отказа.
    expect(mockReactions).toEqual([]);
    expect(mockFanouts).toEqual([]);
  });

  it('база освободилась — та же реакция проходит', async () => {
    mockMembers = null;
    await toggleAndSyncReaction({ msgId: 'm2', emoji: '👍', groupId: GID });
    mockMembers = [{ peerPubB64: ME, role: 'owner' }];
    const res = await toggleAndSyncReaction({ msgId: 'm2', emoji: '👍', groupId: GID });
    expect(res.ok).toBe(true);
    expect(mockReactions).toEqual([{ msgId: 'm2', emoji: '👍' }]);
  });
});

describe('закрепление: нечитаемая группа — не удалённая группа', () => {
  it('строка группы не прочиталась — своя причина, а не «группу удалили»', async () => {
    mockGroupState = 'failed';
    const res = await togglePinAndSync({ groupId: GID, msgId: 'm3', on: true });
    expect(res.ok).toBe(false);
    expect(refusalOf(res)).toBe('group_unreadable');
    expect(mockFanouts).toEqual([]);
  });

  it('состав не прочитался — тоже отказ, а не молчаливая роль «участник»', async () => {
    mockMembers = null;
    const res = await togglePinAndSync({ groupId: GID, msgId: 'm4', on: true });
    expect(res.ok).toBe(false);
    expect(refusalOf(res)).toBe('group_unreadable');
    expect(mockFanouts).toEqual([]);
  });

  it('текст новой причины — свой, и ни с одной прежней не совпадает', () => {
    const text = groupPinRefusalText('group_unreadable');
    for (const other of ['no_group', 'no_identity', 'denied', 'read_failed', 'write_failed'] as const) {
      expect(text).not.toBe(groupPinRefusalText(other));
    }
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отказ «база занята» лечится повтором, и человек его повторит. Поэтому
 * окончательные отказы обязаны остаться окончательными: если новым текстом
 * накрыть и настоящее «вас тут нет», человек будет жать кнопку до вечера.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: окончательные отказы остались собой', () => {
  it('реакция: меня действительно нет в составе — прежний отказ по участию', async () => {
    mockMembers = [{ peerPubB64: PEER, role: 'owner' }];
    const res = await toggleAndSyncReaction({ msgId: 'm5', emoji: '👍', groupId: GID });
    expect(res.ok).toBe(false);
    expect(refusalOf(res)).not.toBe(MEMBERS_UNKNOWN);
    expect(refusalOf(res)).not.toBe('');
    expect(mockReactions).toEqual([]);
  });

  it('реакция: личка состав не читает вовсе', async () => {
    mockMembers = null;
    const res = await toggleAndSyncReaction({ msgId: 'm6', emoji: '🔥', peerPubB64: PEER });
    expect(res.ok).toBe(true);
    expect(mockReactions).toEqual([{ msgId: 'm6', emoji: '🔥' }]);
  });

  it('закрепление: группы правда нет — прежнее no_group', async () => {
    mockGroupState = 'missing';
    const res = await togglePinAndSync({ groupId: GID, msgId: 'm7', on: true });
    expect(refusalOf(res)).toBe('no_group');
  });

  it('закрепление: прав нет — прежнее denied', async () => {
    mockAdminOnlyPinning = true;
    mockMembers = [
      { peerPubB64: ME, role: 'member' },
      { peerPubB64: PEER, role: 'owner' },
    ];
    const res = await togglePinAndSync({ groupId: GID, msgId: 'm8', on: true });
    expect(refusalOf(res)).toBe('denied');
  });

  it('закрепление: исправная база — закрепляет и рассылает', async () => {
    const res = await togglePinAndSync({ groupId: GID, msgId: 'm9', on: true });
    expect(res.ok).toBe(true);
    expect(mockFanouts).toEqual(['pin']);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Сплющивающие обёртки никуда не делись — они нужны там, где пустой список
 * действительно ответ. Проверяем, что на ЭТИХ двух путях их больше нет:
 * вернуть их обратно значит вернуть и оба отказа.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('реакция читает состав различающей обёрткой', () => {
    const body = codeOnly(read('core/social/reactionSync.ts'));
    expect(body).toContain('await listGroupMembersRead(groupId, pid)');
    expect(body).not.toContain('listGroupMembers(groupId, pid)');
    expect(body).toContain("return { ok: false, reason: MEMBERS_UNKNOWN };");
  });

  it('закрепление берёт группу и роль тем же входом, что и приём', () => {
    const body = codeOnly(read('core/social/groupPinSync.ts'));
    expect(body).toContain('await lookupGroupActorRead(groupId, myPub, pid)');
    expect(body).toContain("return { ok: false, reason: 'group_unreadable' };");
    // Прежние сплющивающие чтения ушли вместе со своими отказами.
    expect(body).not.toContain('await getGroup(groupId, pid)');
    expect(body).not.toContain('await listGroupMembers(groupId, ownerProfileId)');
  });

  it('новая причина закрыта типом и обязана иметь фразу', () => {
    const body = read('core/social/groupPinSync.ts');
    expect(body).toContain("  | 'group_unreadable'");
    expect(body).toContain('const REFUSAL: Record<GroupPinRefusal, string> = {');
    expect(body).toContain('group_unreadable:');
  });
});
