/**
 * Порядок «проверить — применить — отметить» в управляющих конвертах группы
 * и честный счёт разосланного (v4.32.620).
 *
 * Четыре независимых изъяна, у всех одна общая черта: наружу они выглядели
 * как успех.
 *
 *   G3. Рассылка в группу считала отправку удавшейся по отсутствию исключения.
 *       `sendMessage` отвечает null и НЕ бросает, когда отправки не было:
 *       адресат заблокирован либо исчерпан часовой лимит управляющих
 *       конвертов. Конверт группы начинается с \x02, то есть считается
 *       управляющим и тратит тот же лимит, что квитанции и реакции. В
 *       оживлённой группе сообщение могло не уйти НИКОМУ, а рассылка
 *       возвращала { sent: N, failed: 0 } — и единственная проверка честности
 *       (groupSendProblem ищет sent === 0) не срабатывала.
 *
 *   G1. `join` был единственной операцией состава без водяного знака. Повтор
 *       здесь не идемпотентен, а разрушителен: добровольный выход отметки об
 *       удалении не пишет, поэтому для ушедшего decideJoin снова отвечает
 *       'add'. Кадр из темы relay живёт тридцать суток.
 *
 *   G4. Отметки полей `meta:` двигались ДО записи — а сама запись шла
 *       десятками строк ниже. Сбой между ними оставлял знак впереди
 *       неприменённого изменения, и повторная доставка отвергалась как повтор:
 *       название расходилось с группой навсегда.
 *
 *   G8. Отказ чтения списка контактов СНИМАЛ фильтр «только контакты» —
 *       строкой ниже того места, где отказ чтения самой настройки трактуется
 *       ровно наоборот.
 *
 * У каждой проверки здесь есть парная «BEFORE»: она показывает, что прежнее
 * поведение действительно давало другой ответ.
 */
type FakeGroup = {
  id: string;
  ownerProfileId: number;
  name: string;
  type: 'group' | 'channel' | 'supergroup';
  archived: boolean;
  isAdmin?: boolean;
  requireApproval?: boolean;
  inviteToken?: string | null;
};

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, Array<{ peerPubB64: string; role: string; ownerProfileId: number }>> = {};
const mockUpserts: Array<{ peerPubB64: string; role: string }> = [];
const mockMetaPatches: Array<Record<string, unknown>> = [];
const mockJoinRequests: unknown[][] = [];
/** Ключ — `${pid}|${key}`. Пустое значение отличается от «не прочиталось». */
const mockKv = new Map<string, string>();
/** Что отвечает служба обмена на каждую отправку: id эха либо null «не ушло». */
let mockSendReply: (peer: string) => string | null = () => 'echo';
/** Читается ли список контактов и что в нём. */
let mockContacts: () => Array<{ peerPublicKey: string }> = () => [];
/** Разрешено ли записать настройки группы (для проверки порядка G4). */
let mockMetaWriteFails = false;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) => ({
    value: mockKv.get(`${pid}|${key}`) ?? null,
  })),
  scopedKvSetFor: jest.fn(async (pid: number, key: string, value: string) => {
    mockKv.set(`${pid}|${key}`, value);
  }),
  // v4.32.655: сдвиг знака пишет проверенной формой — иначе отказ базы молчал.
  scopedKvSetCheckedFor: jest.fn(async (pid: number, key: string, value: string) => {
    mockKv.set(`${pid}|${key}`, value);
    return true;
  }),
  scopedKvDeleteFor: jest.fn(async (pid: number, key: string) => {
    mockKv.delete(`${pid}|${key}`);
  }),
}));

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async (id: string, pid: number) =>
    mockGroups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null),
  listGroups: jest.fn(async (pid: number) => mockGroups.filter((g) => g.ownerProfileId === pid)),
  listGroupMembers: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  // v4.32.700: та же выборка, но формой с третьим исходом — отправляющая
  // сторона перешла на неё. Здесь чтение всегда удаётся, поэтому null не
  // возвращается никогда: G3 проверяет счёт доставок, а не сбой базы.
  listGroupMembersRead: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessage: jest.fn(async () => true),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  insertGroupJoinRequest: jest.fn(async (...a: unknown[]) => {
    mockJoinRequests.push(a);
    return { created: true };
  }),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  createGroup: jest.fn(async () => {}),
  upsertGroupMember: jest.fn(async (m: { peerPubB64: string; role: string }) => { mockUpserts.push(m); }),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async (_gid: string, _pid: number, patch: Record<string, unknown>) => {
    if (mockMetaWriteFails) throw new Error('database is locked');
    mockMetaPatches.push(patch);
  }),
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
  getMessagingService: () => ({
    sendMessage: jest.fn(async (peer: string) => mockSendReply(peer)),
    groupRecipient: async () => ({ pid: 1, myPub: 'M'.repeat(43) }),
  }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: 0, failed: 0, skipped: 0 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => mockContacts() }));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async (_pid: number, key: string) =>
    (key === 'privacy_only_contacts_group' ? true : false),
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';

import { fanoutGroupMessage, handleIncomingGroupControl } from '../groupMessaging';
import { groupSendProblem } from '../groupSendOutcome';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { acceptGroupControlTs, groupWatermarkKey } from '../controlWatermark';
import { acceptJoinRequest } from '../groupJoinPolicy';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-order-1';
const ME = 'M'.repeat(43);
const A = 'A'.repeat(43);
const B = 'B'.repeat(43);
const STRANGER = 'S'.repeat(43);
const PID = 1;

const RCPT = {
  pid: PID,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

function ownGroup(extra: Partial<FakeGroup> = {}): void {
  mockGroups.push({
    id: GID,
    ownerProfileId: PID,
    name: 'Двор',
    type: 'group',
    archived: false,
    isAdmin: true,
    ...extra,
  });
  mockMembers[GID] = [
    { peerPubB64: ME, role: 'owner', ownerProfileId: PID },
    { peerPubB64: A, role: 'member', ownerProfileId: PID },
  ];
}

function joinEnv(from: string, ts: number): string {
  return encodeGroupCtlEnvelope({
    op: 'join',
    groupId: GID,
    target: from,
    targetName: 'Гость',
    ts,
    actorName: 'Гость',
  });
}

function metaEnv(name: string, ts: number): string {
  return encodeGroupCtlEnvelope({ op: 'meta', groupId: GID, name, ts, actorName: 'Админ' });
}

beforeEach(() => {
  mockGroups.length = 0;
  mockUpserts.length = 0;
  mockMetaPatches.length = 0;
  mockJoinRequests.length = 0;
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  mockKv.clear();
  mockSendReply = () => 'echo';
  mockContacts = () => [];
  mockMetaWriteFails = false;
  jest.clearAllMocks();
});

describe('G3: рассылка в группу считает только состоявшиеся отправки', () => {
  beforeEach(() => {
    mockMembers[GID] = [
      { peerPubB64: ME, role: 'owner', ownerProfileId: PID },
      { peerPubB64: A, role: 'member', ownerProfileId: PID },
      { peerPubB64: B, role: 'member', ownerProfileId: PID },
    ];
  });

  it('отказ без исключения считается неудачей, и это видно снаружи', async () => {
    mockSendReply = () => null; // заблокирован либо исчерпан лимит \x02
    const res = await fanoutGroupMessage(GID, 'привет', 'Я', ME, 'm1');
    expect(res).toEqual({ ok: true, members: 2, sent: 0, failed: 2 });
    expect(groupSendProblem(res)).toEqual({ kind: 'undelivered', reason: 'all_failed' });
  });

  it('частичная доставка остаётся доставкой', async () => {
    // Ратчет с другой стороны: правка не должна объявлять сбоем то, что ушло
    // хотя бы одному.
    mockSendReply = (peer) => (peer === A ? 'echo' : null);
    const res = await fanoutGroupMessage(GID, 'привет', 'Я', ME, 'm2');
    expect(res).toEqual({ ok: true, members: 2, sent: 1, failed: 1 });
    expect(groupSendProblem(res)).toBeNull();
  });

  it('успех остаётся успехом', async () => {
    const res = await fanoutGroupMessage(GID, 'привет', 'Я', ME, 'm3');
    expect(res).toEqual({ ok: true, members: 2, sent: 2, failed: 0 });
    expect(groupSendProblem(res)).toBeNull();
  });

  it('BEFORE: прежний счёт объявлял полный провал полным успехом', () => {
    // Ровно прежнее тело цикла: исключения нет — значит «отправлено».
    let sent = 0;
    let failed = 0;
    for (const _m of [A, B]) {
      try {
        const echo: string | null = null; // то, что вернул бы sendMessage
        void echo;
        sent += 1;
      } catch { failed += 1; }
    }
    const asBefore = { ok: true as const, members: 2, sent, failed };
    expect(asBefore).toEqual({ ok: true, members: 2, sent: 2, failed: 0 });
    expect(groupSendProblem(asBefore)).toBeNull();
  });
});

describe('G1: повторный «вступил» не возвращает ушедшего', () => {
  it('первый конверт применяется и оставляет отметку', async () => {
    ownGroup();
    const ts = Date.now() - 1000;
    expect(await handleIncomingGroupControl(joinEnv(B, ts), RCPT, B)).toBe(true);
    expect(mockUpserts.map((m) => m.peerPubB64)).toEqual([B]);
    // Отметка ДОЛЖНА появиться — иначе следующая проверка была бы пустой.
    expect(mockKv.get(`${PID}|${groupWatermarkKey(`m:${B}`, GID)}`)).toBe(String(ts));
  });

  it('тот же конверт, присланный второй раз, отбивается', async () => {
    ownGroup();
    const ts = Date.now() - 1000;
    await handleIncomingGroupControl(joinEnv(B, ts), RCPT, B);
    mockUpserts.length = 0;
    // Человек с тех пор вышел: строки в составе нет, отметки об исключении
    // тоже нет — прежде decideJoin отвечал бы 'add' и вернул его.
    expect(await handleIncomingGroupControl(joinEnv(B, ts), RCPT, B)).toBe(true);
    expect(mockUpserts).toEqual([]);
  });

  it('честное повторное вступление позже — проходит', async () => {
    // Ратчет с другой стороны: знак не должен запирать группу навсегда.
    ownGroup();
    const ts = Date.now() - 5000;
    await handleIncomingGroupControl(joinEnv(B, ts), RCPT, B);
    mockUpserts.length = 0;
    expect(await handleIncomingGroupControl(joinEnv(B, ts + 1000), RCPT, B)).toBe(true);
    expect(mockUpserts.map((m) => m.peerPubB64)).toEqual([B]);
  });

  it('BEFORE: без отметки тот же кадр применялся снова', async () => {
    ownGroup();
    const ts = Date.now() - 1000;
    await handleIncomingGroupControl(joinEnv(B, ts), RCPT, B);
    mockUpserts.length = 0;
    // Стереть отметку — это и есть прежнее состояние кода: её не писали вовсе.
    mockKv.delete(`${PID}|${groupWatermarkKey(`m:${B}`, GID)}`);
    await handleIncomingGroupControl(joinEnv(B, ts), RCPT, B);
    expect(mockUpserts.map((m) => m.peerPubB64)).toEqual([B]);
  });
});

describe('G4: отметка поля meta сдвигается только после записи', () => {
  it('сбой записи не оставляет отметку впереди состояния', async () => {
    ownGroup();
    const ts = Date.now() - 1000;
    mockMetaWriteFails = true;
    await expect(handleIncomingGroupControl(metaEnv('Соседи', ts), RCPT, ME)).rejects.toThrow();
    expect(mockMetaPatches).toEqual([]);
    expect(mockKv.get(`${PID}|${groupWatermarkKey('meta:name', GID)}`)).toBeUndefined();
  });

  it('и повторная доставка того же конверта чинит расхождение', async () => {
    ownGroup();
    const ts = Date.now() - 1000;
    mockMetaWriteFails = true;
    await expect(handleIncomingGroupControl(metaEnv('Соседи', ts), RCPT, ME)).rejects.toThrow();
    mockMetaWriteFails = false;
    expect(await handleIncomingGroupControl(metaEnv('Соседи', ts), RCPT, ME)).toBe(true);
    expect(mockMetaPatches).toEqual([{ name: 'Соседи' }]);
    expect(mockKv.get(`${PID}|${groupWatermarkKey('meta:name', GID)}`)).toBe(String(ts));
  });

  it('удавшаяся запись по-прежнему запирает повтор', async () => {
    ownGroup();
    const ts = Date.now() - 1000;
    expect(await handleIncomingGroupControl(metaEnv('Соседи', ts), RCPT, ME)).toBe(true);
    mockMetaPatches.length = 0;
    // Название в группе не меняем: decideMetaField сравнивает с mockGroups, а
    // повтор должен отбиться именно водяным знаком.
    await handleIncomingGroupControl(metaEnv('Соседи-2', ts), RCPT, ME);
    expect(mockMetaPatches).toEqual([]);
  });

  it('BEFORE: прежний accept ставил отметку до записи', async () => {
    ownGroup();
    const ts = Date.now() - 1000;
    // Ровно то, что делал код до правки: проверка и сдвиг одним действием, а
    // запись — десятками строк ниже, где её и срывал сбой базы.
    expect(await acceptGroupControlTs('meta:name', GID, PID, ts)).toBe(true);
    expect(mockKv.get(`${PID}|${groupWatermarkKey('meta:name', GID)}`)).toBe(String(ts));
    // Изменение при этом не применено, а повтор уже не примут.
    expect(await handleIncomingGroupControl(metaEnv('Соседи', ts), RCPT, ME)).toBe(true);
    expect(mockMetaPatches).toEqual([]);
  });
});

describe('G7: настоящий сбой применения не выдаётся за дубль', () => {
  // Повтор разбирается ВЫШЕ, по ответу insertGroupMessage (`stored === false`),
  // и до внешнего catch не доходит. Значит туда попадает настоящий сбой —
  // записывать его уровнем debug под подписью «похоже, дубль» означало прятать
  // потерю сообщения от самого себя.
  const src = fs.readFileSync(path.join(__dirname, '..', 'groupMessaging.ts'), 'utf8');

  it('в журнале — ошибка, а не отладочная строка про дубль', () => {
    expect(src).toContain("log.error('group_msg_apply_failed'");
    expect(src).not.toContain("group_msg_insert_skip");
  });

  it('BEFORE: прежняя строка действительно была отладочной', () => {
    const before = "log.debug('group_msg_insert_skip', { gid: env.groupId.slice(0, 8) });";
    expect(before).toContain('log.debug(');
    expect(before).toContain('group_msg_insert_skip');
  });
});

describe('G8: нечитаемые контакты не снимают фильтр «только контакты»', () => {
  beforeEach(() => { ownGroup({ requireApproval: true }); });

  it('незнакомец не попадает в заявки, пока список контактов не читается', async () => {
    mockContacts = () => { throw new Error('database is locked'); };
    expect(await handleIncomingGroupControl(joinEnv(STRANGER, Date.now() - 1000), RCPT, STRANGER)).toBe(true);
    expect(mockJoinRequests).toEqual([]);
    expect(mockUpserts).toEqual([]);
  });

  it('контакт в заявки попадает — проверка не «отвергать всех»', async () => {
    mockContacts = () => [{ peerPublicKey: STRANGER }];
    await handleIncomingGroupControl(joinEnv(STRANGER, Date.now() - 1000), RCPT, STRANGER);
    expect(mockJoinRequests).toHaveLength(1);
  });

  it('BEFORE: прежнее значение по отказу пускало незнакомца', () => {
    // Отказ чтения выставлял onlyContactsMayRequest = false.
    expect(acceptJoinRequest({
      knownRole: undefined,
      requesterIsContact: false,
      onlyContactsMayRequest: false,
    })).toBe(true);
    // Осторожная сторона даёт обратный ответ.
    expect(acceptJoinRequest({
      knownRole: undefined,
      requesterIsContact: false,
      onlyContactsMayRequest: true,
    })).toBe(false);
  });
});
