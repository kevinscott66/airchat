/**
 * Занятая база больше не выдаёт себя за «группа не наша» (v4.32.749).
 *
 * `getGroup` схлопывает отказ чтения в тот же `null`, что и «такой группы
 * нет» — это её задокументированное свойство, ради которого в v4.32.700
 * завели различающую `getGroupRead`. Два обработчика входящих конвертов
 * читали строку группы схлопывающей формой, и оба на отказе отвечали
 * `'consumed'`:
 *
 *  - приём группового СООБЩЕНИЯ. Обычный текст живого участника объявлялся
 *    мусором из чужой группы. Ответ `'consumed'` двигает метку прочитанного,
 *    relay больше этот кадр не отдаст — а держит он его тридцать суток именно
 *    ради перезапроса. У отправителя при этом стоит «Доставлено».
 *  - приём ЗАЯВКИ на вступление. Заявка съедалась молча: повтора у неё нет,
 *    ответить заявителю нечем (группы у себя он не создавал), а ему уже
 *    сказано «Запрос отправлен».
 *
 * В обоих местах правку начали и не довели: строкой ниже состав уже читался
 * различающим `listGroupMembersRead`, и отказ там честно уходил в `'deferred'`
 * (v4.32.648 и v4.32.738). Не хватало ровно чтения самой группы.
 *
 * Отложить можно только то, что пройдёт само. Незнакомая группа таким не
 * является: знакомой она от перезапроса не станет, а вечный перезапрос запер
 * бы метку чтения навсегда. Это проверяется отдельно и в обоих обработчиках.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number };

/** Строка группы или отказ базы — как у настоящей getGroupRead. */
let mockGroupRow: FakeGroup | null = null;
let mockGroupFails = false;
/** Состав группы. null — «состав не прочитался», как у listGroupMembersRead. */
let mockMembers: FakeMember[] | null = [];

const mockInserted: unknown[][] = [];
const mockRequests: unknown[][] = [];

jest.mock('../../storage/local', () => ({
  // Копия настоящей пары: схлопывающая форма и форма с третьим исходом. Обе на
  // месте, чтобы прогон ДО правки шёл по настоящему коду, а не по
  // отсутствующему имени.
  getGroup: jest.fn(async () => (mockGroupFails ? null : mockGroupRow)),
  getGroupRead: jest.fn(async () =>
    mockGroupFails
      ? { state: 'failed' }
      : mockGroupRow
        ? { state: 'found', value: mockGroupRow }
        : { state: 'missing' }),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessage: jest.fn(async (...a: unknown[]) => { mockInserted.push(a); return true; }),
  // v4.32.765: приём группового сообщения пишет различающей формой. Запись
  // считаем по ней — предмет этого набора в том, дошло ли дело до записи.
  insertGroupMessageChecked: jest.fn(async (...a: unknown[]) => { mockInserted.push(a); return 'inserted'; }),
  // v4.32.775: приёмник кладёт строку и след одной операцией.
  insertGroupMessageWithTouch: jest.fn(async (...a: unknown[]) => { mockInserted.push(a); return 'inserted'; }),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async (...a: unknown[]) => {
    mockRequests.push(a);
    return { created: true };
  }),
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

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => 'Я',
  // v4.32.779: приём группы читает своё имя различающей формой.
  getOwnDisplayNameTryFor: async () => ({ name: 'Я' }),
  getOwnDisplayName: async () => 'Я',
  // v4.32.605: упоминание сверяется и с username; без него приём падал бы на
  // чтении своих имён.
  getOwnUsernameFor: async () => 'ya',
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: async () => {}, groupRecipient: async () => null }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [{ peerPublicKey: 'P'.repeat(43) }] }));
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
import {
  encodeGroupMsgEnvelope,
  handleIncomingGroupEnvelope,
  handleIncomingGroupJoinRequest,
  GROUP_JOIN_REQUEST_PREFIX,
} from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-749';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, которую мы знаем; я в ней администратор. */
function known(): FakeGroup {
  return {
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group',
    archived: false, isAdmin: true, adminOnlyPosting: false,
  };
}

/** Обычное сообщение участника PEER. */
function message(msgId = 'm-1'): string {
  return encodeGroupMsgEnvelope({
    groupId: GID,
    msgId,
    senderName: 'Пётр',
    senderPubB64: PEER,
    text: 'привет',
    ts: Date.now(),
  });
}

/** Заявка на вступление от PEER. */
function joinRequest(): string {
  return GROUP_JOIN_REQUEST_PREFIX + JSON.stringify({
    groupId: GID,
    groupName: 'Двор',
    requesterPubB64: PEER,
    requesterName: 'Пётр',
    ts: Date.now(),
  });
}

beforeEach(() => {
  mockGroupRow = null;
  mockGroupFails = false;
  mockMembers = [
    { peerPubB64: ME, role: 'owner', ownerProfileId: 1 },
    { peerPubB64: PEER, role: 'member', ownerProfileId: 1 },
  ];
  mockInserted.length = 0;
  mockRequests.length = 0;
  jest.clearAllMocks();
});

describe('групповое сообщение: строка группы не прочиталась', () => {
  it('конверт откладывается, а не съедается', async () => {
    mockGroupRow = known();
    mockGroupFails = true;
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('deferred');
  });

  it('и сообщение при этом никуда не записывается', async () => {
    mockGroupRow = known();
    mockGroupFails = true;
    await handleIncomingGroupEnvelope(message(), RCPT, PEER);
    expect(mockInserted).toEqual([]);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: с прочитанной группой сообщение ложится как прежде', async () => {
    mockGroupRow = known();
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('consumed');
    expect(mockInserted).toHaveLength(1);
  });

  it('незнакомая группа — по-прежнему «разобрано», а не «перезапросить»', async () => {
    // Знакомой она от перезапроса не станет: откладывать её значит запереть
    // метку чтения на relay навсегда.
    mockGroupRow = null;
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });
});

describe('заявка на вступление: строка группы не прочиталась', () => {
  it('заявка откладывается, а не съедается', async () => {
    mockGroupRow = known();
    mockGroupFails = true;
    expect(await handleIncomingGroupJoinRequest(joinRequest(), RCPT, PEER)).toBe('deferred');
  });

  it('и в список заявок при этом ничего не кладётся', async () => {
    mockGroupRow = known();
    mockGroupFails = true;
    await handleIncomingGroupJoinRequest(joinRequest(), RCPT, PEER);
    expect(mockRequests).toEqual([]);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: с прочитанной группой заявка доходит до администратора', async () => {
    mockGroupRow = known();
    // Заявитель ещё не в составе — иначе заявка и не нужна.
    mockMembers = [{ peerPubB64: ME, role: 'owner', ownerProfileId: 1 }];
    expect(await handleIncomingGroupJoinRequest(joinRequest(), RCPT, PEER)).toBe('consumed');
    expect(mockRequests).toHaveLength(1);
  });

  it('чужая группа — по-прежнему «разобрано»', async () => {
    mockGroupRow = null;
    expect(await handleIncomingGroupJoinRequest(joinRequest(), RCPT, PEER)).toBe('consumed');
    expect(mockRequests).toEqual([]);
  });
});

describe('форма правки закреплена', () => {
  const src = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8');
  /** Только код: в комментариях прежняя форма упомянута нарочно. */
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('оба приёма читают группу различающей формой', () => {
    expect(code).toContain('const groupRead = await getGroupRead(env.groupId, pid);');
    expect(code).toContain('const grpRead = await getGroupRead(env.groupId, pid);');
    expect(code).toContain("log.warn('group_msg_group_unreadable', { groupId: env.groupId.slice(0, 8) });");
    expect(code).toContain("log.warn('group_join_request_group_unreadable', { groupId: env.groupId.slice(0, 8) });");
    // Отказ чтения — и только он — уходит в отложенные.
    expect(code).toContain("  if (groupRead.state === 'failed') {");
    expect(code).toContain("    if (grpRead.state === 'failed') {");
  });

  it('схлопывающая форма на приёме конвертов не осталась', () => {
    // На отправляющей стороне она законна и живёт дальше — там отказ чтения
    // виден вызывающему сразу, а не превращается в вердикт о чужом конверте.
    expect(code).not.toContain('const group = await getGroup(env.groupId, pid);');
    expect(code).not.toContain('const grp = await getGroup(env.groupId, pid);');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: getGroup по-прежнему схлопывает отказ в null', () => {
    const local = readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
    expect(local).toContain('export async function getGroup(');
    expect(local).toContain('lookupValue(await getGroupRead(');
  });
});
