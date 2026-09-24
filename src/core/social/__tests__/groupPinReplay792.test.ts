/**
 * Закрепление в группе получило знак свежести (v4.32.792).
 *
 * Дефект. Управляющие конверты группы сторожит водяной знак: состав и роли
 * (`grp:m:`), поля настроек (`grp:meta:`), правка и удаление сообщения
 * (`grp:msg:`). Закрепление было единственным состоянием без него, и это стояло
 * в коде обработчика как данность — соседний комментарий на неё же и опирался.
 *
 * Цена. Состояние скалярное: у пары «группа + сообщение» два положения, `on` и
 * `off`, и кадр переключает их своим полем. Темы relay выводятся из открытых
 * DID, писать в них может любой, а кадр живёт тридцать суток — значит
 * перехваченное «закрепить» возвращает в шапку снятый баннер, а перехваченное
 * «открепить» снимает нынешний. Право проверяется по ТЕКУЩЕМУ составу и
 * подписанту оригинала: участник, у которого закрепление отобрали настройкой
 * adminOnlyPinning, проходит по-прежнему. Бьёт по каждому получателю отдельно —
 * у остальных шапка остаётся правильной, и рассогласование никто не видит.
 *
 * Правка. Своя ячейка `grp:pin:<сообщение>` — отдельная от правки того же
 * сообщения, потому что спорят они за разные значения, а порядок доставки relay
 * не держит. Проверка идёт ДО чтения цели: повтор не должен стоить даже
 * обращения к таблице. Сдвиг — последним шагом, после того как закрепление
 * записано И строка о нём рассказана: оба отказа по-прежнему уводят кадр в
 * перезапрос, и знак не должен хоронить тот самый повтор, которого мы просим.
 */
type FakeGroup = {
  id: string;
  ownerProfileId: number;
  name: string;
  type: 'group';
  archived: boolean;
  isAdmin: boolean;
  adminOnlyPosting: boolean;
  adminOnlyPinning: boolean;
  requireApproval: boolean;
  anonymousPosting: boolean;
  slowModeSeconds: number;
};
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number; displayName?: string };

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, FakeMember[]> = {};
/** Ключ — `p<pid>:<ключ>`: так же, как складывает profileScopedKv. */
const mockKv = new Map<string, string>();
/** Что сделала каждая удавшаяся запись закрепления. */
const mockPins: Array<{ msgId: string; on: boolean }> = [];
/** Тексты записанных системных строк. */
const mockSaid: string[] = [];
/** Что отвечает запись закрепления. */
let mockPinOk = true;
/** Что отвечает запись системной строки. */
let mockSysWrite: 'inserted' | 'duplicate' | 'failed' = 'inserted';
/** Есть ли у нас строка закрепляемого сообщения. */
let mockTargetKnown = true;
/** Строка закрепляемого сообщения. Имя с mock — иначе фабрика её не увидит. */
const mockTarget = { groupId: 'g-792', senderPubB64: 'A'.repeat(43), text: 'закрепляемое' };

const GID = mockTarget.groupId;
const ME = 'M'.repeat(43);
const ADMIN = mockTarget.senderPubB64;
const MSG = 'm-792';
const OTHER_MSG = 'm-792-второе';
const TS = 1_700_000_000_000;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) => ({
    value: mockKv.get(`p${pid}:${key}`) ?? null,
  })),
  scopedKvSetCheckedFor: jest.fn(async (pid: number, key: string, value: string) => {
    mockKv.set(`p${pid}:${key}`, value);
    return true;
  }),
  scopedKvSetFor: jest.fn(async (pid: number, key: string, value: string) => {
    mockKv.set(`p${pid}:${key}`, value);
  }),
  scopedKvDeleteFor: jest.fn(async (pid: number, key: string) => {
    mockKv.delete(`p${pid}:${key}`);
  }),
}));

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async (id: string, pid: number) =>
    mockGroups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null),
  getGroupRead: jest.fn(async (id: string, pid: number) => {
    const row = mockGroups.find((g) => g.id === id && g.ownerProfileId === pid);
    return row ? { state: 'found', value: row } : { state: 'missing' };
  }),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  listGroupMembersRead: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  getGroupMessageTarget: jest.fn(async () => null),
  getGroupMessageTargetRead: jest.fn(async () =>
    mockTargetKnown
      ? { state: 'found', value: { ...mockTarget } }
      : { state: 'missing' }),
  insertGroupMessage: jest.fn(async () => true),
  insertGroupMessageChecked: jest.fn(async (row: { text: string }) => {
    if (mockSysWrite !== 'failed') mockSaid.push(row.text);
    return mockSysWrite;
  }),
  updateGroupMessageText: jest.fn(async () => true),
  deleteGroupMessage: jest.fn(async () => {}),
  deleteGroupMessageChecked: jest.fn(async () => 'deleted'),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  createGroup: jest.fn(async () => {}),
  upsertGroupMember: jest.fn(async () => {}),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  kvTryGet: jest.fn(async () => ({ value: null })),
  kvSetChecked: jest.fn(async () => true),
  kvSet: jest.fn(async () => {}),
  kvDelete: jest.fn(async () => {}),
}));

jest.mock('../groupPinSync', () => ({
  applyLocalPin: jest.fn(async (p: { msgId: string; on: boolean }) => {
    if (!mockPinOk) return { ok: false, reason: 'write_failed' };
    mockPins.push({ msgId: p.msgId, on: p.on });
    return { ok: true, entries: [] };
  }),
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
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
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
import { join as pathJoin } from 'path';

import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { handleIncomingGroupControl } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';
import {
  commitGroupMessageTs,
  groupMessageTsFresh,
  groupMessageWatermarkKey,
  groupPinWatermarkKey,
  resetControlTsMirrorForTests,
} from '../controlWatermark';

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, которую мы знаем: ADMIN — владелец, я обычный участник. */
function known(adminOnlyPinning = false): void {
  mockGroups.push({
    id: GID, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false,
    isAdmin: false, adminOnlyPosting: false, adminOnlyPinning,
    requireApproval: false, anonymousPosting: false, slowModeSeconds: 0,
  });
  mockMembers[GID] = [
    { peerPubB64: ADMIN, role: 'owner', ownerProfileId: 1, displayName: 'Хозяин' },
    { peerPubB64: ME, role: 'member', ownerProfileId: 1, displayName: 'Я' },
  ];
}

const pin = (ts = TS, on = true, msgId = MSG) =>
  encodeGroupCtlEnvelope({
    op: 'pin', groupId: GID, ts, msgId, on, actorName: 'Хозяин',
  } as never);

beforeEach(() => {
  resetControlTsMirrorForTests();
  mockGroups.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  mockKv.clear();
  mockPins.length = 0;
  mockSaid.length = 0;
  mockPinOk = true;
  mockSysWrite = 'inserted';
  mockTargetKnown = true;
});

describe('перехваченный кадр закрепления больше не переключает шапку', () => {
  it('тот же кадр, присланный второй раз, не применяется', async () => {
    known();
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([{ msgId: MSG, on: true }]);
    mockPins.length = 0;
    mockSaid.length = 0;
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([]);
    // И строки «Сообщение закреплено» второй раз тоже нет.
    expect(mockSaid).toEqual([]);
  });

  it('сохранённое «закрепить» не возвращает снятый баннер', async () => {
    known();
    await handleIncomingGroupControl(pin(TS, true), RCPT, ADMIN);
    await handleIncomingGroupControl(pin(TS + 1000, false), RCPT, ADMIN);
    mockPins.length = 0;
    // Вот он, перехваченный месяц назад кадр.
    expect(await handleIncomingGroupControl(pin(TS, true), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([]);
  });

  it('сохранённое «открепить» не снимает нынешнее закрепление', async () => {
    known();
    await handleIncomingGroupControl(pin(TS, false), RCPT, ADMIN);
    await handleIncomingGroupControl(pin(TS + 1000, true), RCPT, ADMIN);
    mockPins.length = 0;
    expect(await handleIncomingGroupControl(pin(TS, false), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([]);
  });

  it('повтор не стоит даже обращения к таблице сообщений', async () => {
    known();
    await handleIncomingGroupControl(pin(TS), RCPT, ADMIN);
    const { getGroupMessageTargetRead } = jest.requireMock('../../storage/local') as {
      getGroupMessageTargetRead: jest.Mock;
    };
    getGroupMessageTargetRead.mockClear();
    await handleIncomingGroupControl(pin(TS), RCPT, ADMIN);
    expect(getGroupMessageTargetRead).not.toHaveBeenCalled();
  });
});

describe('честная работа с закреплениями не задета', () => {
  it('более поздний кадр применяется, сколько бы их ни было', async () => {
    known();
    await handleIncomingGroupControl(pin(TS, true), RCPT, ADMIN);
    await handleIncomingGroupControl(pin(TS + 1, false), RCPT, ADMIN);
    await handleIncomingGroupControl(pin(TS + 2, true), RCPT, ADMIN);
    expect(mockPins).toEqual([
      { msgId: MSG, on: true },
      { msgId: MSG, on: false },
      { msgId: MSG, on: true },
    ]);
  });

  it('у каждого сообщения своя ячейка', async () => {
    known();
    await handleIncomingGroupControl(pin(TS + 5000, true, MSG), RCPT, ADMIN);
    mockPins.length = 0;
    // Более ранний кадр про ДРУГОЕ сообщение — законный: relay отдаёт
    // накопленное пачкой и порядка не держит.
    expect(await handleIncomingGroupControl(pin(TS, true, OTHER_MSG), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([{ msgId: OTHER_MSG, on: true }]);
  });

  it('закрепление и правка того же сообщения не спорят за одну ячейку', async () => {
    // Иначе общий знак выбросил бы законную правку, пришедшую следом за более
    // поздним закреплением.
    expect(groupPinWatermarkKey(MSG)).not.toBe(groupMessageWatermarkKey(MSG));
    known();
    await handleIncomingGroupControl(pin(TS + 5000, true), RCPT, ADMIN);
    expect(await groupMessageTsFresh(MSG, 1, TS)).toBe(true);
    await commitGroupMessageTs(MSG, 1, TS + 9000);
    mockPins.length = 0;
    expect(await handleIncomingGroupControl(pin(TS + 6000, false), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([{ msgId: MSG, on: false }]);
  });

  it('двоеточие внутри msgId не даёт подобрать чужую ячейку', () => {
    expect(groupPinWatermarkKey('a:b')).not.toBe(groupPinWatermarkKey('a'));
    expect(groupPinWatermarkKey('a:b')).not.toBe(groupPinWatermarkKey('b'));
    expect(groupPinWatermarkKey('msg:x')).not.toBe(groupMessageWatermarkKey('pin:msg:x'));
  });
});

describe('знак не хоронит повтор, которого мы сами просим', () => {
  it('отказ записи закрепления откладывает кадр и знака не ставит', async () => {
    known();
    mockPinOk = false;
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('deferred');
    mockPinOk = true;
    // Перезапрос тот же кадр и приносит — он обязан примениться.
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([{ msgId: MSG, on: true }]);
  });

  it('отказ записи системной строки — тоже', async () => {
    known();
    mockSysWrite = 'failed';
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('deferred');
    mockSysWrite = 'inserted';
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockSaid).toEqual([expect.stringContaining('Сообщение закреплено')]);
  });

  it('незнакомое сообщение знака не ставит: строка может ещё прийти', async () => {
    known();
    mockTargetKnown = false;
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([]);
    mockTargetKnown = true;
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([{ msgId: MSG, on: true }]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние отказы ветки целы', () => {
  it('не участник закрепить не может', async () => {
    known();
    const STRANGER = 'S'.repeat(43);
    expect(await handleIncomingGroupControl(pin(TS), RCPT, STRANGER)).toBe('consumed');
    expect(mockPins).toEqual([]);
  });

  it('настройка «закрепляют только администраторы» соблюдается', async () => {
    known(true);
    // Обычный участник — у него права нет, сколько бы кадр ни был свеж.
    mockMembers[GID] = [{ peerPubB64: ADMIN, role: 'member', ownerProfileId: 1 }];
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([]);
  });

  it('и знак при отказе в праве не ставится', async () => {
    known(true);
    mockMembers[GID] = [{ peerPubB64: ADMIN, role: 'member', ownerProfileId: 1 }];
    await handleIncomingGroupControl(pin(TS), RCPT, ADMIN);
    // Настройку сняли — тот же кадр обязан примениться.
    mockGroups[0].adminOnlyPinning = false;
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([{ msgId: MSG, on: true }]);
  });

  it('обычное закрепление применяется и рассказывается', async () => {
    known();
    expect(await handleIncomingGroupControl(pin(TS), RCPT, ADMIN)).toBe('consumed');
    expect(mockPins).toEqual([{ msgId: MSG, on: true }]);
    expect(mockSaid).toEqual([expect.stringContaining('Сообщение закреплено')]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const src = (name: string): string => readFileSync(pathJoin(__dirname, '..', name), 'utf8');

  it('кадр сам называет положение — потому повтор и переключает', () => {
    // Будь в кадре «переключить», ячейка на сообщение ничего бы не спасла.
    expect(src('groupMessaging.ts')).toContain('msgId: env.msgId, on: env.on });');
  });

  it('право берётся у подписанта оригинала по текущему составу', () => {
    // Вот почему разжалованный проходит: конверт применяется от его имени.
    const GRP = src('groupMessaging.ts');
    expect(GRP).toContain('canPinInGroup({ role: actor.role,');
  });

  it('конверт живёт достаточно долго, чтобы повтор был не теорией', () => {
    expect(src('messaging.ts')).toContain('const ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;');
    const WIN = readFileSync(
      pathJoin(__dirname, '..', '..', 'transport', 'retentionWindow.ts'),
      'utf8',
    );
    expect(WIN).toContain('export const RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;');
  });

  it('соседние управляющие состояния знак имеют давно', () => {
    const GRP = src('groupMessaging.ts');
    expect(GRP).toContain('groupControlTsFresh(');
    expect(GRP).toContain('groupMessageTsFresh(');
  });
});
