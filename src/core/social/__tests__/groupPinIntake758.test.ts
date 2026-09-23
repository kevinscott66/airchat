/**
 * Занятая база больше не теряет закрепление в группе (v4.32.758).
 *
 * Та же беда, что в личке (v4.32.757), и здесь она дороже: закрепление в
 * группе — это объявление, ради которого шапку и открывают. Провал записи был
 * немым дважды.
 *
 * Внутри модуля: `scopedKvSetFor` о своей неудаче не сообщает никому, а список
 * строкой ниже перечитывается из kv уже ПОСЛЕ неё — то есть приходит прежним и
 * выглядит как удачно записанный. Единственным отказом считался непрочитанный
 * список (v4.32.643).
 *
 * Снаружи: входящий конверт `pin` объявлял кадр разобранным в любом исходе, а
 * «разобрано» двигает метку докуда прочитано — relay отдаёт накопленное только
 * по ней, и служебный конверт не повторяют. Секунда занятой базы стоила
 * закрепления навсегда, причём у остальных участников оно есть: рассылка
 * прошла. Своя же сторона при том же провале печатала «Сообщение закреплено»
 * ровно о том, чего в шапке нет.
 *
 * Правка: обе записи проверяемые, `applyLocalPin` отвечает `GroupPinWrite` с
 * двумя причинами, `clearPinned` — «легло ли», приёмник откладывает кадр, а
 * экран не стирает баннер, пока список цел.
 */

const mockKv = new Map<string, string>();
/** Что записано в groups.pinned_message_id/text — по порядку. */
const mockGroupPins: { id: string | null; text: string | null }[] = [];
let mockFanouts = 0;
/** Что ответит запись списка закреплений: false — база занята. */
let mockListWriteOk = true;

/** Ключ списка закреплений группы — по нему и ломаем запись. */
const mockIsListKey = (k: string): boolean => k.includes('group_pinned_list_');

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  kvSetChecked: async (k: string, v: string) => {
    if (!mockListWriteOk && mockIsListKey(k)) return false;
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
  setGroupPinnedMessage: async (
    _gid: string,
    _pid: number,
    id: string | null,
    text: string | null
  ) => {
    mockGroupPins.push({ id, text });
  },
  listGroupMembers: async () => [{ peerPubB64: 'my-pub-b64', role: 'owner' }],
  listGroupMembersRead: async () => [{ peerPubB64: 'my-pub-b64', role: 'owner' }],
  getGroup: async () => ({ id: 'g1', type: 'group', adminOnlyPinning: false }),
  getGroupRead: async () => ({
    state: 'found',
    value: { id: 'g1', type: 'group', adminOnlyPinning: false, isAdmin: true },
  }),
  // Все запрошенные id считаем существующими: «чьё это сообщение» здесь не
  // предмет набора.
  getGroupMessageTexts: async (ids: string[]) => new Map(ids.map((id) => [id, `текст ${id}`])),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getActiveIdentity: () => ({ pid: 1, myPubB64: 'my-pub-b64' }),
  },
}));

jest.mock('../groupMessaging', () => ({
  fanoutGroupControl: async () => {
    mockFanouts += 1;
    return { sent: true, recipients: 2 };
  },
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  applyLocalPin,
  clearPinned,
  groupPinRefusalText,
  loadPinnedIds,
  togglePinAndSync,
} from '../groupPinSync';

const GROUP = 'g1';
const PID = 1;
const LIST_KEY = `p${PID}:group_pinned_list_${GROUP}`;

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

beforeEach(() => {
  mockKv.clear();
  mockKv.set(LIST_KEY, JSON.stringify(['m1']));
  mockGroupPins.length = 0;
  mockFanouts = 0;
  mockListWriteOk = true;
});

describe('провал записи назван провалом', () => {
  it('закрепление не легло — отказ, а не прежний список под видом нового', async () => {
    mockListWriteOk = false;

    const write = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    expect(write).toEqual({ ok: false, reason: 'write_failed' });
    // Прежде сюда возвращался перечитанный из kv список — тот же самый, что и
    // до неудачи, то есть внешне совершенно исправный.
    expect(await loadPinnedIds(GROUP, PID)).toEqual(['m1']);
    // И в шапку группы ничего не записано.
    expect(mockGroupPins).toEqual([]);
  });

  it('«открепить все» не легло — тоже отказ, и шапка не тронута', async () => {
    mockListWriteOk = false;

    expect(await clearPinned(GROUP, PID)).toBe(false);
    expect(await loadPinnedIds(GROUP, PID)).toEqual(['m1']);
    expect(mockGroupPins).toEqual([]);
  });

  it('своё закрепление не записалось — рассылки нет и причина своя', async () => {
    mockListWriteOk = false;

    const res = await togglePinAndSync({ groupId: GROUP, msgId: 'm2', on: true });
    expect(res).toEqual({ ok: false, reason: 'write_failed' });
    // Разослать значило бы дать остальным закрепление, которого нет у себя.
    expect(mockFanouts).toBe(0);

    const text = groupPinRefusalText('write_failed');
    expect(text).not.toBe(groupPinRefusalText('read_failed'));
    expect(text).not.toBe(groupPinRefusalText('denied'));
    expect(/[А-Яа-я]/.test(text)).toBe(true);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ: всё выше держится на одном переключателе mockListWriteOk.
 * Модуль, который отказывает всегда, прошёл бы эти проверки целиком.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: исправная база работает по-прежнему', () => {
  it('закрепление легло — список и шапка обновлены', async () => {
    const write = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    expect(write.ok && write.entries.map((e) => e.id)).toEqual(['m2', 'm1']);
    expect(await loadPinnedIds(GROUP, PID)).toEqual(['m2', 'm1']);
    expect(mockGroupPins).toEqual([{ id: 'm2', text: 'текст m2' }]);
  });

  it('«открепить все» легло — список пуст, шапка снята', async () => {
    expect(await clearPinned(GROUP, PID)).toBe(true);
    expect(await loadPinnedIds(GROUP, PID)).toEqual([]);
    expect(mockGroupPins).toEqual([{ id: null, text: null }]);
  });

  it('своё закрепление разослано и вернуло список', async () => {
    const res = await togglePinAndSync({ groupId: GROUP, msgId: 'm2', on: true });
    expect(res.ok).toBe(true);
    expect(mockFanouts).toBe(1);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Вне модуля отказ обязан дойти до двух мест, а поведением их не проверить:
 * входящий конверт живёт в groupMessaging (тянет SQLite и службу переписки
 * целиком), экран под jest не собирается. Поэтому форма.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('входящий конверт откладывает кадр, а не объявляет его разобранным', () => {
    const body = codeOnly(read('core/social/groupMessaging.ts'));
    const guard = body.indexOf("if (!write.ok) {\n      log.warn('group_ctl_pin_not_applied'");
    expect(guard).toBeGreaterThan(0);
    // Ровно после отказа — отсрочка, а не 'consumed'.
    expect(body.slice(guard, guard + 320)).toContain("return 'deferred';");
    // И строка «Сообщение закреплено» — после проверки, а не до неё.
    const row = body.indexOf("insertCtlSysMessage(env, pid, env.on ? 'Сообщение закреплено'");
    expect(row).toBeGreaterThan(guard);
  });

  it('экран не стирает баннер, пока список цел', () => {
    const body = codeOnly(read('ui/screens/GroupsScreen.tsx'));
    expect(body).toContain('if (!(await clearPinned(group.id, pid))) {');
    expect(body).toContain("groupPinRefusalText('write_failed')");
    // Разовый перенос старых закреплений — тоже по исходу, а не по `?? list`.
    expect(body).toContain('if (moved.ok) list = moved.entries;');
  });

  it('немых записей закрепления не осталось ни в личке, ни в группе', () => {
    for (const f of ['core/social/dmPinSync.ts', 'core/social/groupPinSync.ts']) {
      const body = codeOnly(read(f));
      expect(body).not.toContain('scopedKvSetFor(');
      expect(body).toContain('scopedKvSetCheckedFor(ownerProfileId, pinListKey(');
    }
  });
});
