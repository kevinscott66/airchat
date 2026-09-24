/**
 * Ответ обработчика группы выбрасывался приёмником (v4.32.748).
 *
 * Два конверта из пяти отвечали `boolean` со смыслом «это мой конверт», и
 * приёмник (messaging.ts) этот ответ не читал вовсе — писал `'consumed'`
 * всегда. То есть отметка о прочтении в группе и управляющий конверт (бан,
 * кик, смена роли, переименование, приглашение) считались разобранными и в
 * тот момент, когда база не ответила. Метка чтения на relay при этом
 * сдвигается, и конверт больше не перезапрашивается никогда.
 *
 * Внутри обоих обработчиков та же ошибка этажом ниже: отказ чтения выдавался
 * за факт.
 *
 * 1. `getGroup` схлопывает «не смогли прочитать» в тот же `null`, что и «нет
 *    такой группы». В управляющем конверте на этом `null` держится вся защита
 *    ветки 'invite': незнакомая группа — единственная, которую приглашение
 *    вправе завести целиком, вместе с составом и ролями. Занятая база снимала
 *    эту защиту ровно так же, как её снимал архив до v4.32.511.
 * 2. `listGroupMembers` на сбое отдаёт пустой список — тот самый дефект,
 *    который чинили в v4.32.738 у заявки на вступление, но не здесь.
 * 3. У отметки о прочтении по нечитаемому составу роль выходит `null`, и
 *    настоящий участник объявлялся посторонним («накручивает просмотры»).
 *    Отказ записи там же уходил в `log.debug` и наружу шло «разобрано».
 *
 * Отложить (`'deferred'`) здесь можно только то, что пройдёт само: отказ
 * чтения и отказ записи. Незнакомая группа — не тот случай: она не станет
 * знакомой оттого, что конверт перезапросят, и вечный перезапрос запер бы
 * метку чтения навсегда. Это и проверяется отдельно.
 */
type FakeGroup = { id: string; ownerProfileId: number; name: string; type: 'group'; archived: boolean; isAdmin: boolean };
type FakeMember = { peerPubB64: string; role: string; ownerProfileId: number };

/** Строка группы или отказ базы — как у настоящей getGroupRead. */
let mockGroupRow: FakeGroup | null = null;
let mockGroupFails = false;
/** Состав группы. null — «состав не прочитался», как у listGroupMembersRead. */
let mockMembers: FakeMember[] | null = [];
/** Чем отвечает запись отметки о прочтении (v4.32.769). */
let mockSeenWrite: 'recorded' | 'noop' | 'failed' = 'recorded';

const mockCreated: unknown[][] = [];
const mockSeen: unknown[][] = [];
const mockUpserts: Array<{ peerPubB64: string; role: string }> = [];

jest.mock('../../storage/local', () => ({
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
  insertGroupMessage: jest.fn(async () => true),
  // v4.32.765: приёмник группы пишет различающей формой — она отличает
  // настоящий повтор от отказа базы. Предмет этого набора другой.
  insertGroupMessageChecked: jest.fn(async () => 'inserted'),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  // v4.32.769: отметка отвечает словом, а не бросает. Прежний мок бросал —
  // настоящая функция гасила свой отказ сама, и ветка отсрочки была мёртвой.
  markGroupMessageSeenChecked: jest.fn(async (...a: unknown[]) => {
    if (mockSeenWrite === 'recorded') mockSeen.push(a);
    return mockSeenWrite;
  }),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  createGroup: jest.fn(async (...a: unknown[]) => { mockCreated.push(a); }),
  // v4.32.816: группа и её состав теперь ложатся одной записью. Подмена
  // наполняет те же ручки, что и прежняя пара вызовов: первый аргумент —
  // заведение группы, второй — состав целиком.
  createGroupWithRoster: jest.fn(async (
    g: { id: string; ownerProfileId: number; name: string; type?: string; isAdmin?: boolean },
    members: Array<{ peerPubB64: string; role: string }>,
  ) => {
    mockCreated.push([g.id, g.ownerProfileId, g.name, g.type, undefined, g.isAdmin]);
    for (const m of members) mockUpserts.push(m);
    return true;
  }),
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
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async () => {},
    // v4.32.795: «список прочитан» — предмет отдельного вопроса, а не
    // молчаливого «не заблокирован». Здесь база открыта.
    blockedListReadable: () => true,
    isBlocked: () => false,
  },
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
  handleIncomingGroupControl,
  handleIncomingGroupReadReceipt,
  GROUP_READ_RECEIPT_PREFIX,
} from '../groupMessaging';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-748';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);
const MSG = 'm-1';

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

/** Группа, которую мы знаем и в которой состоим. */
function known(): FakeGroup {
  return { id: GID, ownerProfileId: 1, name: 'Двор', type: 'group', archived: false, isAdmin: true };
}

/** Приглашение — единственная операция, применимая к незнакомой группе. */
function invite(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID,
    ts: Date.now(),
    op: 'invite',
    groupName: 'Двор',
    groupType: 'group',
    actorName: 'Пётр',
    members: [{ pub: PEER, name: 'Пётр', role: 'admin' }],
  } as never);
}

/** Любая операция, которая требует уже известной группы и состава. */
function ban(): string {
  return encodeGroupCtlEnvelope({
    groupId: GID,
    ts: Date.now(),
    op: 'ban',
    target: PEER,
    targetName: 'Пётр',
    actorName: 'Пётр',
  } as never);
}

/** Отметка «прочитано» от собеседника PEER. */
function receipt(): string {
  return GROUP_READ_RECEIPT_PREFIX + JSON.stringify({
    groupId: GID,
    lastSeenMsgId: MSG,
    viewerPubB64: PEER,
    ts: Date.now(),
  });
}

beforeEach(() => {
  mockGroupRow = null;
  mockGroupFails = false;
  mockMembers = [];
  mockSeenWrite = 'recorded';
  mockCreated.length = 0;
  mockSeen.length = 0;
  mockUpserts.length = 0;
  jest.clearAllMocks();
});

describe('управляющий конверт: нечитаемая группа', () => {
  it('отказ чтения группы откладывает конверт, а не считает его разобранным', async () => {
    mockGroupFails = true;
    expect(await handleIncomingGroupControl(ban(), RCPT, PEER)).toBe('deferred');
  });

  it('и приглашение на отказе чтения НЕ применяется', async () => {
    // Здесь цена ошибки выше всего: незнакомая группа — единственная, которую
    // приглашение вправе завести вместе с составом и ролями. Прочитав отказ
    // базы как «группы нет», обработчик переписывал бы состав собственной
    // группы по чужому конверту.
    mockGroupRow = known();
    mockGroupFails = true;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('deferred');
    expect(mockCreated).toEqual([]);
    expect(mockUpserts).toEqual([]);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: та же группа, прочитанная как незнакомая, приглашение применяет', async () => {
    mockGroupRow = null;
    mockGroupFails = false;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated.length).toBe(1);
  });

  it('незнакомая группа разобрана, а не отложена', async () => {
    // Отложить её значило бы запереть метку чтения на relay навсегда:
    // перезапрос вернёт тот же конверт про ту же неизвестную группу.
    mockGroupRow = null;
    expect(await handleIncomingGroupControl(ban(), RCPT, PEER)).toBe('consumed');
  });
});

describe('управляющий конверт: нечитаемый состав', () => {
  it('отказ чтения состава откладывает конверт', async () => {
    mockGroupRow = known();
    mockMembers = null;
    expect(await handleIncomingGroupControl(ban(), RCPT, PEER)).toBe('deferred');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: пустой (но прочитанный) состав конверт не откладывает', async () => {
    // Пустой список — это «в группе никого не записано», законный ответ базы.
    // Разница между ним и `null` и есть всё содержание правки.
    mockGroupRow = known();
    mockMembers = [];
    expect(await handleIncomingGroupControl(ban(), RCPT, PEER)).not.toBe('deferred');
  });
});

describe('отметка о прочтении', () => {
  it('нечитаемый состав откладывает отметку, а не объявляет участника посторонним', async () => {
    mockGroupRow = known();
    mockMembers = null;
    expect(await handleIncomingGroupReadReceipt(receipt(), RCPT, PEER)).toBe('deferred');
    expect(mockSeen).toEqual([]);
  });

  it('настоящий посторонний по-прежнему отбивается насовсем', async () => {
    // Состав прочитан, и отправителя в нём нет — это ответ, а не отказ.
    // Перезапрашивать такой конверт незачем.
    mockGroupRow = known();
    mockMembers = [{ peerPubB64: ME, role: 'owner', ownerProfileId: 1 }];
    expect(await handleIncomingGroupReadReceipt(receipt(), RCPT, PEER)).toBe('consumed');
    expect(mockSeen).toEqual([]);
  });

  it('отказ записи откладывает отметку', async () => {
    // Повтора у отметки нет: следующая расскажет уже про следующее сообщение,
    // а про это не напомнит никто.
    mockGroupRow = known();
    mockMembers = [{ peerPubB64: PEER, role: 'member', ownerProfileId: 1 }];
    mockSeenWrite = 'failed';
    expect(await handleIncomingGroupReadReceipt(receipt(), RCPT, PEER)).toBe('deferred');
    expect(mockSeen).toEqual([]);
  });

  it('писать было нечего — это не отказ, конверт разобран', async () => {
    // v4.32.769: читатель уже в списке, строки нет, список упёрся в тысячу.
    // Повтор кадра ни одного из трёх не изменит.
    mockGroupRow = known();
    mockMembers = [{ peerPubB64: PEER, role: 'member', ownerProfileId: 1 }];
    mockSeenWrite = 'noop';
    expect(await handleIncomingGroupReadReceipt(receipt(), RCPT, PEER)).toBe('consumed');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: обычная отметка доезжает и записывается', async () => {
    mockGroupRow = known();
    mockMembers = [{ peerPubB64: PEER, role: 'member', ownerProfileId: 1 }];
    expect(await handleIncomingGroupReadReceipt(receipt(), RCPT, PEER)).toBe('consumed');
    expect(mockSeen.length).toBe(1);
  });

  it('мусор вместо конверта разобран, а не отложен', async () => {
    // Испорченное тело перезапросом не починится — отложить его значит
    // запереть метку чтения навсегда.
    expect(await handleIncomingGroupReadReceipt(GROUP_READ_RECEIPT_PREFIX + '{не json', RCPT, PEER))
      .toBe('consumed');
  });

  it('подлог отбивается насовсем', async () => {
    // Подписал один, а в конверте другой: перезапрос вернёт тот же подлог.
    mockGroupRow = known();
    mockMembers = [{ peerPubB64: PEER, role: 'member', ownerProfileId: 1 }];
    expect(await handleIncomingGroupReadReceipt(receipt(), RCPT, ME)).toBe('consumed');
    expect(mockSeen).toEqual([]);
  });
});

describe('приёмник читает ответ обработчика', () => {
  const MESSAGING = readFileSync(join(__dirname, '..', 'messaging.ts'), 'utf8');

  /** Кусок приёмника от префикса конверта до конца ветки. */
  function branch(prefixConst: string): string {
    const at = MESSAGING.indexOf(`textPayload.text?.startsWith(${prefixConst})`);
    if (at < 0) throw new Error(`в приёмнике нет ветки ${prefixConst}`);
    return MESSAGING.slice(at).split('\n').slice(0, 12).join('\n');
  }

  it('отметка о прочтении: ответ обработчика уходит наружу', () => {
    const b = branch('GROUP_READ_RECEIPT_PREFIX');
    expect(b).toContain('return await handleIncomingGroupReadReceipt(');
    // Своё эхо разбирать нечего — оно уже сохранено путём отправки.
    expect(b).toContain("if (!inbound) return 'consumed';");
  });

  it('управляющий конверт: ответ обработчика уходит наружу', () => {
    const b = branch('GROUP_CTL_PREFIX');
    expect(b).toContain('return await handleIncomingGroupControl(');
    expect(b).toContain("if (!inbound) return 'consumed';");
  });

  it('прежней формы «позвать и забыть ответ» в этих ветках не осталось', () => {
    expect(MESSAGING).not.toContain('if (inbound) await handleIncomingGroupReadReceipt(');
    expect(MESSAGING).not.toContain('if (inbound) await handleIncomingGroupControl(');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: обе ветки в приёмнике вообще есть', () => {
    expect(MESSAGING).toContain('handleIncomingGroupReadReceipt(');
    expect(MESSAGING).toContain('handleIncomingGroupControl(');
  });
});

describe('обработчики отвечают вердиктом, а не «да»', () => {
  const GM = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8');

  it('оба объявлены с EnvelopeIntake', () => {
    expect(GM).toContain('export async function handleIncomingGroupControl(text: string, rcpt: GroupRecipient, senderPubB64?: string): Promise<EnvelopeIntake>');
    expect(GM).toMatch(/export async function handleIncomingGroupReadReceipt\([^)]*\n\): Promise<EnvelopeIntake>/);
  });

  it('голого true из них больше не выходит', () => {
    for (const name of ['handleIncomingGroupControl', 'handleIncomingGroupReadReceipt']) {
      const at = GM.indexOf(`export async function ${name}`);
      expect(at).toBeGreaterThan(0);
      const body = GM.slice(at, GM.indexOf('\n}\n', at));
      expect(body).not.toMatch(/return (true|false);/);
    }
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: оба слова вердикта в них и правда встречаются', () => {
    for (const name of ['handleIncomingGroupControl', 'handleIncomingGroupReadReceipt']) {
      const at = GM.indexOf(`export async function ${name}`);
      const body = GM.slice(at, GM.indexOf('\n}\n', at));
      expect(body).toContain("return 'consumed';");
      expect(body).toContain("return 'deferred';");
    }
  });
});
