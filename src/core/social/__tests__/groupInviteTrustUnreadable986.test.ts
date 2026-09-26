/**
 * v4.32.986: приглашение в группу не пропадает от занятой базы.
 *
 * Дефект. `isInviteTrusted` отвечала «да/нет», а спрашивала три источника, из
 * которых два отвечали двумя состояниями. Отметка своей заявки читалась
 * `profileKvGet` — та сводит отказ базы и «заявки не было» в один `null`.
 * Справочник контактов читался `listContactsFor` — та отдаёт `?? []`, то есть
 * непрочитанный список выглядит как пустой; а строка, которую не удалось
 * расшифровать этим проходом, из списка просто исчезает (`missing`,
 * v4.32.846). Любой из этих отказов приходил в ответ как «не доверяем».
 *
 * Цена. На «не доверяем» вызывающий отвечает `consumed`. По словарю
 * `EnvelopeIntake` это «разобран»: метка relay перешагивает кадр, и второй
 * подачи не будет — конверт лежит на relay ещё тридцать суток, но не
 * запрашивается больше никогда. Повторной рассылки приглашений в проекте нет
 * (`sendGroupInvite` зовут только из экрана групп и окна создания), так что
 * группа не появляется совсем, а администратор видит «принято». Довод
 * v4.32.474 — «приглашение можно прислать повторно» — не выполняется.
 *
 * Правка. Ответ стал тремя состояниями: `unknown` вместо `no`, когда хоть
 * один источник не прочитался, и `deferred` вместо `consumed` на `unknown`.
 * Ровно так десятью строками выше поступает проверка списка блокировок
 * (v4.32.795). Ничего необратимого при этом не делается: группа не заводится,
 * просто кадр придёт ещё раз.
 *
 * Границы. Отказ ЧТЕНИЯ — не отказ В ПРИЁМЕ: прочитанный запрет («только
 * контакты» включено, отправитель не контакт) по-прежнему `consumed`, иначе
 * незнакомец держал бы метку relay своим кадром сколько угодно.
 */
type FakeGroup = { id: string; ownerProfileId: number; name: string; type: 'group'; archived: boolean };
type FakeContact = { peerPublicKey: string; implicit?: boolean };

const mockGroups: FakeGroup[] = [];
const mockCreated: unknown[][] = [];
const mockUpserts: Array<{ peerPubB64: string; role: string }> = [];

/** Отметка «мы сами попросились» — и признак того, что база её отдала. */
const mockPending = new Map<string, string>();
let mockPendingReadable = true;

/** Справочник контактов: список, признак отказа и число непрочитанных строк. */
const mockContacts: FakeContact[] = [];
let mockContactsReadable = true;
let mockContactsMissing = 0;

let mockOnlyContacts: boolean | null = true;

jest.mock('../../storage/local', () => ({
  getGroupRead: jest.fn(async (id: string, pid: number) => {
    const row = mockGroups.find((g) => g.id === id && g.ownerProfileId === pid);
    return row ? { state: 'found', value: row } : { state: 'missing' };
  }),
  listGroupMembersRead: jest.fn(async () => []),
  getGroupMessageTexts: jest.fn(async () => new Map<string, string>()),
  insertGroupMessageChecked: jest.fn(async () => 'inserted'),
  markGroupMessageSeenChecked: jest.fn(async () => 'recorded'),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  kvDeleteScoped: jest.fn(async () => {}),
  // Прежний вход к той же отметке — тот, что сводил отказ базы и «заявки не
  // было» в один null. Оставлен подменённым нарочно: на нём и проверяется, что
  // до правки набор шёл по тому же сценарию, а отвечал иначе.
  profileKvGet: jest.fn(async (pid: number, key: string) => (
    mockPendingReadable ? mockPending.get(`${pid}|${key}`) ?? null : null
  )),
  // Отметку выхода читает та же пара: здесь её нет, и приглашение свежее.
  kvTryGet: jest.fn(async () => ({ value: null })),
  createGroupWithRoster: jest.fn(async (
    g: { id: string; ownerProfileId: number; name: string; type?: string; isAdmin?: boolean },
    members: Array<{ peerPubB64: string; role: string }>,
  ) => {
    mockCreated.push([g.id, g.ownerProfileId, g.name]);
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

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) => (
    mockPendingReadable ? { value: mockPending.get(`${pid}|${key}`) ?? null } : null
  )),
  scopedKvSetCheckedFor: jest.fn(async () => true),
  scopedKvSetFor: jest.fn(async () => {}),
  scopedKvDeleteFor: jest.fn(async () => {}),
}));

jest.mock('../contacts', () => ({
  listContactsFor: async () => (mockContactsReadable ? mockContacts : []),
  listContactsReadDetailed: async () => (
    mockContactsReadable ? { contacts: mockContacts, missing: mockContactsMissing } : null
  ),
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
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async () => {},
    blockedListReadable: () => true,
    isBlocked: () => false,
  },
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async () => mockOnlyContacts,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { handleIncomingGroupControl } from '../groupMessaging';
import { encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { INVITE_PENDING_KEY_PREFIX } from '../groupMessaging';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-new-986';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);

const RCPT = {
  pid: 1,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

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

beforeEach(() => {
  mockGroups.length = 0;
  mockCreated.length = 0;
  mockUpserts.length = 0;
  mockPending.clear();
  mockPendingReadable = true;
  mockContacts.length = 0;
  mockContactsReadable = true;
  mockContactsMissing = 0;
  // «Добавление в группы — только контакты» включено: именно при нём отказ
  // чтения и решал судьбу приглашения.
  mockOnlyContacts = true;
  jest.clearAllMocks();
});

describe('не прочитали — не значит «нельзя»: кадр откладывается', () => {
  it('отметка своей заявки не поднялась — приглашение придёт ещё раз', async () => {
    mockPending.set(`1|${INVITE_PENDING_KEY_PREFIX}${GID}`, PEER);
    mockPendingReadable = false;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('deferred');
    expect(mockCreated).toEqual([]);
  });

  it('справочник контактов не поднялся — тоже', async () => {
    mockContacts.push({ peerPublicKey: PEER });
    mockContactsReadable = false;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('deferred');
    expect(mockCreated).toEqual([]);
  });

  it('справочник короче себя: одна строка не открылась — этого хватает', async () => {
    // Отправителя в списке нет, но нет и уверенности, что его там нет:
    // пропавшая строка могла быть его.
    mockContactsMissing = 1;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('deferred');
    expect(mockCreated).toEqual([]);
  });

  it('сама настройка не прочиталась — решать нечем', async () => {
    mockOnlyContacts = null;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('deferred');
    expect(mockCreated).toEqual([]);
  });

  it('база освободилась — тот же кадр заводит группу', async () => {
    mockContactsReadable = false;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('deferred');
    mockContactsReadable = true;
    mockContacts.push({ peerPublicKey: PEER });
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated).toHaveLength(1);
    expect(mockUpserts.some((m) => m.peerPubB64 === PEER && m.role === 'admin')).toBe(true);
  });
});

describe('ГРАНИЦА: прочитанный отказ остаётся отказом', () => {
  it('незнакомец при включённом «только контакты» — кадр разобран, группы нет', async () => {
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated).toEqual([]);
  });

  it('неявная строка доверием не считается и кадр не держит', async () => {
    mockContacts.push({ peerPublicKey: PEER, implicit: true });
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычное приглашение принимается как прежде', () => {
  it('от явного контакта', async () => {
    mockContacts.push({ peerPublicKey: PEER });
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated).toHaveLength(1);
  });

  it('по своей заявке — даже если отправителя нет в контактах', async () => {
    mockPending.set(`1|${INVITE_PENDING_KEY_PREFIX}${GID}`, PEER);
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated).toHaveLength(1);
  });

  it('от незнакомца, когда «только контакты» выключено', async () => {
    mockOnlyContacts = false;
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated).toHaveLength(1);
  });

  it('ГРАНИЦА: отметка не прочиталась, но отправитель — контакт: одного «да» хватает', async () => {
    mockPendingReadable = false;
    mockContacts.push({ peerPublicKey: PEER });
    expect(await handleIncomingGroupControl(invite(), RCPT, PEER)).toBe('consumed');
    expect(mockCreated).toHaveLength(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const read = (p: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('path') as typeof import('path');
    return readFileSync(join(__dirname, '..', '..', p), 'utf8');
  };

  it('`consumed` по-прежнему означает «перезапрашивать нечего»', () => {
    const intake = read('transport/envelopeIntake.ts');
    expect(intake).toContain('`consumed` — разобран или признан мусором. Перезапрашивать нечего');
    expect(intake).toContain("export type EnvelopeIntake = 'consumed' | 'deferred';");
  });

  it('соседняя проверка — блок-лист — откладывает ровно так же', () => {
    const gm = read('social/groupMessaging.ts');
    expect(gm).toContain('if (!rateLimiter.blockedListReadable()) {');
    expect(gm).toContain("return 'deferred';");
  });

  it('повторной рассылки приглашений по-прежнему нет: второй подачи ждать неоткуда', () => {
    const gm = read('social/groupMessaging.ts');
    expect(gm).toContain('export async function sendGroupInvite(');
  });
});
