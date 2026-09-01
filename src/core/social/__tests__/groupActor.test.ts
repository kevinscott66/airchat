/**
 * groupActor — кто отправитель в группе (v4.32.429).
 *
 * Подготовка данных для canInteractInGroup была написана от руки пять раз, и
 * копии уже расходились однажды (комментарий v4.32.273 в pollVoteSync). Здесь
 * проверяется единственный оставшийся экземпляр: что незнакомая группа не
 * стоит второго запроса, что чужая роль не подставляется вместо своей и что
 * строка роли из базы превращается в SendRole ровно в одном месте.
 *
 * v4.32.511: строка группы берётся по идентификатору. Прежний `listGroups`
 * отдаёт только `archived = 0`, и своя группа, убранная в архив, приходила
 * сюда как чужая — реакции, голоса, завершение опроса и отметки о прочтении
 * в ней переставали приниматься у всех пятерых вызывающих сразу.
 */
const groups: Array<{ id: string; ownerProfileId: number; type: string; archived?: boolean }> = [];
const members: Record<string, Array<{ peerPubB64: string; role: string }>> = {};
const calls = { getGroup: 0, listGroupMembers: 0 };

jest.mock('../../storage/local', () => ({
  // Копия настоящего запроса: составной ключ и ни слова про архив —
  // `SELECT * FROM groups WHERE id = ? AND owner_profile_id = ?`.
  getGroup: jest.fn(async (id: string, pid: number) => {
    calls.getGroup += 1;
    return groups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null;
  }),
  listGroupMembers: jest.fn(async (gid: string) => {
    calls.listGroupMembers += 1;
    return members[gid] ?? [];
  }),
}));

import { lookupGroupActor, roleOf } from '../groupActor';

const ALICE = 'alice-pub';
const BOB = 'bob-pub';

beforeEach(() => {
  groups.length = 0;
  for (const k of Object.keys(members)) delete members[k];
  calls.getGroup = 0;
  calls.listGroupMembers = 0;
});

describe('roleOf', () => {
  it('возвращает роль участника', () => {
    expect(roleOf([{ peerPubB64: ALICE, role: 'admin' }] as never, ALICE)).toBe('admin');
  });

  it('null, когда такого участника нет — именно null, а не undefined', () => {
    const r = roleOf([{ peerPubB64: ALICE, role: 'admin' }] as never, BOB);
    expect(r).toBeNull();
  });

  it('null на пустом списке участников', () => {
    expect(roleOf([], ALICE)).toBeNull();
  });

  it('не путает участников с похожими ключами', () => {
    const ms = [
      { peerPubB64: `${ALICE}x`, role: 'owner' },
      { peerPubB64: ALICE, role: 'restricted' },
    ] as never;
    expect(roleOf(ms, ALICE)).toBe('restricted');
  });
});

describe('lookupGroupActor', () => {
  it('незнакомая группа: group=null, участники не запрашиваются', async () => {
    const actor = await lookupGroupActor('g-unknown', ALICE, 1);
    expect(actor.group).toBeNull();
    expect(actor.role).toBeNull();
    expect(actor.members).toEqual([]);
    expect(calls.listGroupMembers).toBe(0);
  });

  it('группа чужого профиля своей не считается', async () => {
    groups.push({ id: 'g1', ownerProfileId: 2, type: 'group' });
    members.g1 = [{ peerPubB64: ALICE, role: 'owner' }];
    const actor = await lookupGroupActor('g1', ALICE, 1);
    expect(actor.group).toBeNull();
    expect(calls.listGroupMembers).toBe(0);
  });

  it('известная группа: строка группы, участники и роль', async () => {
    groups.push({ id: 'g1', ownerProfileId: 1, type: 'channel' });
    members.g1 = [
      { peerPubB64: ALICE, role: 'owner' },
      { peerPubB64: BOB, role: 'restricted' },
    ];
    const actor = await lookupGroupActor('g1', BOB, 1);
    expect(actor.group?.type).toBe('channel');
    expect(actor.role).toBe('restricted');
    expect(actor.members).toHaveLength(2);
  });

  it('отправитель не в списке участников — роль null при известной группе', async () => {
    groups.push({ id: 'g1', ownerProfileId: 1, type: 'group' });
    members.g1 = [{ peerPubB64: ALICE, role: 'owner' }];
    const actor = await lookupGroupActor('g1', BOB, 1);
    expect(actor.group).not.toBeNull();
    expect(actor.role).toBeNull();
  });

  it('по одному запросу к каждой таблице — не больше', async () => {
    groups.push({ id: 'g1', ownerProfileId: 1, type: 'group' });
    members.g1 = [{ peerPubB64: ALICE, role: 'member' }];
    await lookupGroupActor('g1', ALICE, 1);
    expect(calls.getGroup).toBe(1);
    expect(calls.listGroupMembers).toBe(1);
  });

  it('группа, убранная в архив, остаётся своей (v4.32.511)', async () => {
    // Архив прячет строку из списка, а не выводит из группы: выход и удаление
    // строку удаляют. До этой версии здесь спрашивался список активных групп,
    // и всё время, пока группа скрыта, её участники были друг для друга
    // чужими — реакции и голоса не доезжали ни в одну сторону.
    groups.push({ id: 'g1', ownerProfileId: 1, type: 'group', archived: true });
    members.g1 = [{ peerPubB64: ALICE, role: 'admin' }];
    const actor = await lookupGroupActor('g1', ALICE, 1);
    expect(actor.group?.id).toBe('g1');
    expect(actor.role).toBe('admin');
  });
});
