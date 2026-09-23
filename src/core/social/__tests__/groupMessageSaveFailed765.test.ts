/**
 * Занятая база больше не выдаёт себя за повтор конверта (v4.32.765).
 *
 * `insertGroupMessage` отвечала одним `boolean`, и `false` значил сразу две
 * разные вещи: `INSERT OR IGNORE` не изменил ни строки — то есть сообщение с
 * таким `msgId` уже лежит, — и любой отказ SQLite из блока `catch`: секунда
 * занятой базы, переполненный диск, неоткрывшийся ключ шифрования данных.
 *
 * Приёмник группы трактовал `false` как повтор: писал в журнал
 * `group_msg_duplicate_skip` уровнем debug и отвечал `'consumed'`. Это слово
 * двигает метку «докуда прочитано» у ретранслятора, а накопленное он отдаёт
 * только по ней. Строки при этом не появилось нигде, и второго конверта не
 * будет — сообщение терялось безвозвратно. Хуже всего, что и разобраться по
 * журналу было нельзя: потеря записана как дубликат.
 *
 * Ориентир того, как надо, лежит в этом же файле с v4.32.748:
 * `handleIncomingGroupReadReceipt` на точно таком же отказе записи отвечает
 * `'deferred'` — «перезапросить», а не «разобрано».
 *
 * Настоящий повтор при этом обязан остаться `'consumed'`: он приходит штатно
 * (пуш и транспорт приносят один msgId дважды), и откладывать его значило бы
 * запереть метку чтения навсегда.
 */
type FakeGroup = {
  id: string; ownerProfileId: number; name: string; type: 'group';
  archived: boolean; isAdmin: boolean; adminOnlyPosting: boolean;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number };

/** Что ответит запись строки: как настоящая insertGroupMessageChecked. */
let mockWrite: 'inserted' | 'duplicate' | 'failed' = 'inserted';
/** Строки, дошедшие до записи. */
const mockInserted: Array<{ id: string }> = [];
/** Что легло в список чатов: счётчик непрочитанного, превью, баннер. */
const mockTouched: unknown[][] = [];

let mockGroupRow: FakeGroup | null = null;
let mockMembers: FakeMember[] | null = [];

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async () => mockGroupRow),
  getGroupRead: jest.fn(async () =>
    mockGroupRow ? { state: 'found', value: mockGroupRow } : { state: 'missing' }),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  // Сплющивающая форма осталась на месте: ею пишут экраны своё только что
  // составленное сообщение, и третий исход им не нужен.
  insertGroupMessage: jest.fn(async () => mockWrite === 'inserted'),
  insertGroupMessageChecked: jest.fn(async (row: { id: string }) => {
    if (mockWrite === 'inserted') mockInserted.push(row);
    return mockWrite;
  }),
  // v4.32.775: приёмник пишет строку и след в списке чатов одной операцией —
  // иначе отказ следа терялся между двумя записями. Исходы у неё те же три.
  insertGroupMessageWithTouch: jest.fn(async (row: { id: string }, touch: unknown) => {
    if (mockWrite === 'inserted') { mockInserted.push(row); mockTouched.push([touch]); }
    return mockWrite;
  }),
  touchGroupConversation: jest.fn(async (...a: unknown[]) => { mockTouched.push(a); }),
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

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => 'Я',
  // v4.32.779: приём группы читает своё имя различающей формой.
  getOwnDisplayNameTryFor: async () => ({ name: 'Я' }),
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
import { encodeGroupMsgEnvelope, handleIncomingGroupEnvelope } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';

const mockLog = (jest.requireMock('../../logger') as {
  log: { warn: jest.Mock; debug: jest.Mock; info: jest.Mock };
}).log;

const GID = 'g-765';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, которую мы знаем; отправитель в ней состоит. */
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
    text: 'встречаемся в семь',
    ts: Date.now(),
  });
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
    { peerPubB64: ME, role: 'owner', ownerProfileId: 1 },
    { peerPubB64: PEER, role: 'member', ownerProfileId: 1 },
  ];
  mockWrite = 'inserted';
  mockInserted.length = 0;
  mockTouched.length = 0;
  jest.clearAllMocks();
});

describe('запись сообщения не удалась', () => {
  it('кадр откладывается, а не съедается', async () => {
    mockWrite = 'failed';
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('deferred');
  });

  it('отказ записан в журнал как отказ, а не как «похоже, дубль»', async () => {
    mockWrite = 'failed';
    await handleIncomingGroupEnvelope(message(), RCPT, PEER);
    expect(mockLog.warn).toHaveBeenCalledWith('group_msg_save_failed_defer', expect.any(Object));
    expect(mockLog.debug).not.toHaveBeenCalledWith('group_msg_duplicate_skip', expect.anything());
  });

  it('несостоявшаяся запись не двигает список чатов и счётчик непрочитанного', async () => {
    mockWrite = 'failed';
    await handleIncomingGroupEnvelope(message(), RCPT, PEER);
    expect(mockTouched).toEqual([]);
    expect(mockLog.info).not.toHaveBeenCalledWith('group_msg_received', expect.anything());
  });
});

describe('настоящий повтор конверта', () => {
  it('остаётся разобранным: откладывать его — запереть метку чтения навсегда', async () => {
    mockWrite = 'duplicate';
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('consumed');
  });

  it('и по-прежнему не поднимает счётчик со вчерашним текстом', async () => {
    mockWrite = 'duplicate';
    await handleIncomingGroupEnvelope(message(), RCPT, PEER);
    expect(mockTouched).toEqual([]);
    expect(mockLog.debug).toHaveBeenCalledWith('group_msg_duplicate_skip', expect.any(Object));
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удачная запись идёт прежней дорогой', () => {
  it('сообщение ложится в базу и поднимает список чатов', async () => {
    expect(await handleIncomingGroupEnvelope(message(), RCPT, PEER)).toBe('consumed');
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0].id).toBe('m-1');
    expect(mockTouched).toHaveLength(1);
    expect(mockLog.info).toHaveBeenCalledWith('group_msg_received', expect.any(Object));
  });

  it('три разных исхода дают три разных ответа, а не два', async () => {
    const verdicts: string[] = [];
    for (const w of ['inserted', 'duplicate', 'failed'] as const) {
      mockWrite = w;
      verdicts.push(await handleIncomingGroupEnvelope(message('m-' + w), RCPT, PEER));
    }
    expect(verdicts).toEqual(['consumed', 'consumed', 'deferred']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('различающая форма и вправду отвечает словом, а не «да»', () => {
    expect(LOCAL).toContain('export type GroupMessageWrite =');
    expect(LOCAL).toContain('export async function insertGroupMessageChecked(msg: GroupMessageRow): Promise<GroupMessageWrite> {');
    // Оба исхода отказа названы своими именами в самой записи.
    expect(LOCAL).toContain("return (res.changes ?? 0) > 0 ? 'inserted' : 'duplicate';");
    expect(LOCAL).toContain("return 'failed';");
  });

  it('сплющивающая форма осталась — и осталась ровно обёрткой', () => {
    expect(LOCAL).toContain("return (await insertGroupMessageChecked(msg)) === 'inserted';");
    // Своей записи у обёртки быть не должно: две копии разъедутся. Запрос на
    // восстановление из резервной копии живёт отдельно и сюда не относится.
    const a = LOCAL.indexOf('export async function insertGroupMessage(');
    const b = LOCAL.indexOf('export async function insertGroupMessageChecked(');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(LOCAL.slice(a, b)).not.toContain('INSERT OR IGNORE INTO group_messages');
  });

  it('приёмник спрашивает различающей формой, а не прежней', () => {
    // v4.32.775: та же различающая форма, но теперь пишущая строку и след
    // одной операцией — см. groupMessageTouchAtomic775.
    expect(GRP).toContain('const stored = await insertGroupMessageWithTouch(row, {');
    expect(GRP).not.toContain('const stored = await insertGroupMessage(row);');
    expect(GRP).not.toContain('if (!stored) {');
  });

  it('системная строка тоже пишется различающей формой (v4.32.773)', () => {
    // Здесь она была оставлена на прежней: её отказ казался безобидным. Оказался
    // не безобиден — см. groupCtlSysRowFailed773. Слепой записи в приёмнике не
    // осталось нигде.
    expect(GRP).toContain('return await insertGroupMessageChecked({');
    expect(GRP).not.toContain('await insertGroupMessage({');
  });

  it('ориентир на месте: отметка «прочитано» откладывает такой же отказ', () => {
    const at = GRP.indexOf('export async function handleIncomingGroupReadReceipt(');
    expect(at).toBeGreaterThan(0);
    expect(GRP.slice(at, at + 3000)).toContain("return 'deferred';");
  });
});
