/**
 * Сбой чтения не стирает закрепления (v4.32.643).
 *
 * Дефект. Список закреплённых читался через scopedKvGetFor, а тот отвечает
 * одним null и на «ничего не закреплено», и на «база не ответила». Список при
 * этом читается перед КАЖДОЙ записью и пишется целиком: заминка базы приходила
 * в applyLocalDmPin/applyLocalPin пустым массивом, и одно новое закрепление
 * ложилось поверх полусотни настоящих. Человек всего лишь добавил ещё одно —
 * а увёл весь список, и ни одной ошибки на экране при этом не было.
 *
 * То же приходило и с чужим конвертом: входящее закрепление собеседника
 * стирало мои. Правка одна на обоих близнецов — читает read*PinnedIds, null
 * значит «не знаем», и по нему не пишут; отказ доходит до человека отдельной
 * причиной read_failed.
 */

const mockKv = new Map<string, string>();
/** Записи, чтение которых «не удалось»: kvTryGet отвечает на них null. */
let mockFailPinList = false;
const mockConvPins: (string | null)[] = [];
const mockGroupPins: (string | null)[] = [];
let mockDmFanouts = 0;
let mockGroupFanouts = 0;
let mockNotifies = 0;

function mockIsPinList(k: string): boolean {
  return k.includes('pinned_list_');
}

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => {
    if (mockFailPinList && mockIsPinList(k)) return null;
    return { value: mockKv.get(k) ?? null };
  },
  kvSet: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  kvSetChecked: async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvDeleteChecked: async (k: string) => {
    mockKv.delete(k);
    return true;
  },
  kvListKeysByPrefix: async () => [],
  setConversationPinnedMessage: async (_peer: string, _pid: number, id: string | null) => {
    mockConvPins.push(id);
  },
  setGroupPinnedMessage: async (_gid: string, _pid: number, id: string | null) => {
    mockGroupPins.push(id);
  },
  // Все запрошенные id считаем существующими: проверка «сообщение есть у
  // получателя» здесь не предмет теста.
  getChatMessageTexts: async (ids: string[]) => new Map(ids.map((id) => [id, `текст ${id}`])),
  getGroupMessageTexts: async (ids: string[]) => new Map(ids.map((id) => [id, `текст ${id}`])),
  listGroupMembers: async () => [{ peerPubB64: 'me-pub', role: 'owner' }],
  getGroup: async () => ({ id: 'g1', adminOnlyPinning: false, type: 'group' }),
  notifyChatStorageChanged: () => {
    mockNotifies += 1;
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 7, name: 'Рабочий' }),
    getActiveIdentity: () => ({ pid: 7, myPubB64: 'me-pub' }),
  },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => {
    mockDmFanouts += 1;
    return { sent: true, recipients: 1 };
  },
  fanoutReasonText: () => '',
}));

jest.mock('../groupMessaging', () => ({
  fanoutGroupControl: async () => {
    mockGroupFanouts += 1;
    return { sent: true, recipients: 1 };
  },
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  applyLocalDmPin,
  clearDmPinnedAndSync,
  dmPinRefusalText,
  encodeDmPinEnvelope,
  handleIncomingDmPin,
  loadDmPinnedIds,
  toggleDmPinAndSync,
} from '../dmPinSync';
import {
  applyLocalPin,
  groupPinRefusalText,
  loadPinnedIds,
  togglePinAndSync,
} from '../groupPinSync';
import { scopedKvGetFor, scopedKvTryGetFor } from '../../storage/profileScopedKv';
import * as fs from 'fs';
import * as path from 'path';

const PEER = 'peer-pub-b64-aaaa';
const GROUP = 'g1';
const PID = 7;
const DM_KEY = `p${PID}:pinned_list_${PEER}`;
const GRP_KEY = `p${PID}:group_pinned_list_${GROUP}`;

beforeEach(() => {
  mockKv.clear();
  mockFailPinList = false;
  mockConvPins.length = 0;
  mockGroupPins.length = 0;
  mockDmFanouts = 0;
  mockGroupFanouts = 0;
  mockNotifies = 0;
  // Два настоящих закрепления, накопленных до сбоя.
  mockKv.set(DM_KEY, JSON.stringify(['m1', 'm2']));
  mockKv.set(GRP_KEY, JSON.stringify(['m1', 'm2']));
});

describe('повод для правки жив', () => {
  it('scopedKvGetFor отвечает одним null и на пустоту, и на сбой', async () => {
    // Пустота.
    mockKv.delete(DM_KEY);
    expect(await scopedKvGetFor(PID, `pinned_list_${PEER}`)).toBeNull();
    // Сбой — при живой записи.
    mockKv.set(DM_KEY, JSON.stringify(['m1', 'm2']));
    mockFailPinList = true;
    expect(await scopedKvGetFor(PID, `pinned_list_${PEER}`)).toBeNull();
  });

  it('а scopedKvTryGetFor их различает — на нём и держится правка', async () => {
    mockKv.delete(DM_KEY);
    expect(await scopedKvTryGetFor(PID, `pinned_list_${PEER}`)).toEqual({ value: null });
    mockKv.set(DM_KEY, JSON.stringify(['m1', 'm2']));
    mockFailPinList = true;
    expect(await scopedKvTryGetFor(PID, `pinned_list_${PEER}`)).toBeNull();
  });
});

describe('проверка не пустая: при читаемом списке всё как было', () => {
  it('личка: третье закрепление добавляется к двум, а не заменяет их', async () => {
    const res = await toggleDmPinAndSync({ peerPubB64: PEER, msgId: 'm3', on: true });
    expect(res.ok).toBe(true);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m3', 'm1', 'm2']);
    expect(mockDmFanouts).toBe(1);
  });

  it('группа: третье закрепление добавляется к двум, а не заменяет их', async () => {
    const res = await togglePinAndSync({ groupId: GROUP, msgId: 'm3', on: true });
    expect(res.ok).toBe(true);
    expect(await loadPinnedIds(GROUP, PID)).toEqual(['m3', 'm1', 'm2']);
    expect(mockGroupFanouts).toBe(1);
  });

  it('входящий конверт собеседника ложится поверх своих, ничего не стирая', async () => {
    const applied = await handleIncomingDmPin(
      encodeDmPinEnvelope({ msgId: 'm3', on: true, ts: Date.now() }),
      PEER,
      PID
    );
    expect(applied).toBe(true);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m3', 'm1', 'm2']);
    expect(mockNotifies).toBe(1);
  });
});

describe('список не прочитался', () => {
  it('личка: два закрепления не сводятся к одному', async () => {
    const before = mockKv.get(DM_KEY);
    mockFailPinList = true;
    expect(
      await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm3', on: true })
    ).toBeNull();
    // Запись не тронута — ни своим значением, ни пустым списком.
    expect(mockKv.get(DM_KEY)).toBe(before);
    mockFailPinList = false;
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1', 'm2']);
  });

  it('личка: шапка переписки тоже не переписывается', async () => {
    mockFailPinList = true;
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm3', on: true });
    expect(mockConvPins).toEqual([]);
  });

  it('личка: toggleDmPinAndSync отказывает и НЕ рассылает', async () => {
    mockFailPinList = true;
    const res = await toggleDmPinAndSync({ peerPubB64: PEER, msgId: 'm3', on: true });
    expect(res).toEqual({ ok: false, reason: 'read_failed' });
    // У собеседника закрепление появилось бы, а у себя нет.
    expect(mockDmFanouts).toBe(0);
  });

  it('личка: у отказа есть фраза для человека, а не молчание', () => {
    const text = dmPinRefusalText('read_failed');
    expect(text.length).toBeGreaterThan(10);
    expect(/[А-Яа-я]/.test(text)).toBe(true);
  });

  it('личка: входящий конверт съеден, но ничего не записал', async () => {
    const before = mockKv.get(DM_KEY);
    mockFailPinList = true;
    const applied = await handleIncomingDmPin(
      encodeDmPinEnvelope({ msgId: 'm3', on: true, ts: Date.now() }),
      PEER,
      PID
    );
    // Служебную строку обычным сообщением сохранять нельзя в любом случае.
    expect(applied).toBe(true);
    expect(mockKv.get(DM_KEY)).toBe(before);
    // И «закреплено» экрану не объявляем: в шапке этого нет.
    expect(mockNotifies).toBe(0);
  });

  it('личка: «открепить всё» читать список не обязано и работает', async () => {
    mockFailPinList = true;
    const res = await clearDmPinnedAndSync(PEER);
    expect(res.ok).toBe(true);
    expect(mockKv.get(DM_KEY)).toBe('[]');
    expect(mockDmFanouts).toBe(1);
  });

  it('группа: два закрепления не сводятся к одному', async () => {
    const before = mockKv.get(GRP_KEY);
    mockFailPinList = true;
    expect(
      await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm3', on: true })
    ).toBeNull();
    expect(mockKv.get(GRP_KEY)).toBe(before);
    expect(mockGroupPins).toEqual([]);
    mockFailPinList = false;
    expect(await loadPinnedIds(GROUP, PID)).toEqual(['m1', 'm2']);
  });

  it('группа: togglePinAndSync отказывает и НЕ рассылает', async () => {
    mockFailPinList = true;
    const res = await togglePinAndSync({ groupId: GROUP, msgId: 'm3', on: true });
    expect(res).toEqual({ ok: false, reason: 'read_failed' });
    expect(mockGroupFanouts).toBe(0);
  });

  it('группа: причина названа своя — не «нет прав» и не «нет группы»', () => {
    // Права есть, группа на месте, а записи не было: совет «попросите
    // администратора» здесь был бы неправдой.
    const text = groupPinRefusalText('read_failed');
    expect(text).not.toBe(groupPinRefusalText('denied'));
    expect(text).not.toBe(groupPinRefusalText('no_group'));
    expect(text).not.toBe(groupPinRefusalText('no_identity'));
    expect(/[А-Яа-я]/.test(text)).toBe(true);
  });
});

/**
 * Отказ записи должен доходить до трёх мест вне самих модулей закрепления:
 * входящего конверта группы, разового переноса старых закреплений и трёх
 * кнопок в личке. Проверить их поведением здесь нечем — экран под jest не
 * собирается, — поэтому форма.
 */
describe('форма исходников: отказ доходит до вызывающих', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

  it('входящий конверт группы не объявляет о том, чего не записал', () => {
    const s = read('core/social/groupMessaging.ts');
    const guard = s.indexOf("if (applied === null) {\n      log.warn('group_ctl_pin_not_applied'");
    expect(guard).toBeGreaterThan(0);
    const row = s.indexOf("insertCtlSysMessage(env, pid, env.on ? 'Сообщение закреплено'");
    // Строка «Сообщение закреплено» — после отказа, а не до него.
    expect(row).toBeGreaterThan(guard);
  });

  it('разовый перенос старых закреплений оставляет список как был', () => {
    const s = read('ui/screens/GroupsScreen.tsx');
    expect(s).toContain(
      'list = (await applyLocalPin({ groupId: group.id, ownerProfileId: pid, msgId: group.pinnedMessageId, on: true })) ?? list;'
    );
  });

  it('все три кнопки закрепления в личке показывают отказ, а не молчат', () => {
    const s = read('ui/screens/ChatScreen.tsx');
    const guard = 'if (!res.ok) { showError(dmPinRefusalText(res.reason)); return; }';
    expect(s.split(guard).length - 1).toBe(3);
    // И каждая — перед объявлением исхода рассылки.
    expect(s.split('announceDmPin(res.sync);').length - 1).toBe(3);
  });
});
