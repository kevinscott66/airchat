/**
 * Отказ зеркала закрепления больше не улетает мимо ответа (v4.32.971).
 *
 * Дефект. Источник правды у закреплений — kv (`group_pinned_list_<id>`), и
 * записывается он проверенно: `scopedKvSetCheckedFor`, а не легло — `ok:
 * false`. Сразу за ним идёт зеркало в строку группы —
 * `setGroupPinnedMessage`, — и вот оно не проверялось ничем: ни `db()`, ни
 * ключ шифрования при записи в try не стояли. Занятый SQLite здесь обычное
 * дело, и отказ уходил ИСКЛЮЧЕНИЕМ мимо всего `GroupPinWrite`.
 *
 * Цена. Ловить его на экране некому: обработчик кнопки — `void (async () =>
 * {…})()` без `.catch`. Ни сообщения, ни баннера, ни повтора; нажатие
 * выглядит как несработавшее. Для «Открепить» последнего это хуже молчания:
 * в kv список уже пуст, в `groups.pinned_message_id` — прежний id, а в
 * GroupsScreen живёт перенос наследия «пустой kv + живой pinned_message_id →
 * закрепить заново». То есть открепление человек увидит ОТМЕНЁННЫМ при
 * следующем открытии группы.
 *
 * Правка. Зеркало под try. Пока в списке кто-то остался, отказ зеркала ни на
 * что не влияет — источник правды записан, экран читает оттуда (та же
 * развязка, что у личных чатов в v4.32.838). Пустой список власть отдаёт
 * обратно строке `groups`, поэтому там отказ называется словом: `write_failed`
 * у `applyLocalPin` и `false` у `clearPinned`.
 *
 * Границы. Личный двойник (`dmPinSync`) уже под try с v4.32.838, и там
 * молчание оправдано: ветки наследия у личных чатов нет.
 */
const mockKv = new Map<string, string>();
/** Своя копия сообщения: строка — прочиталась. */
const mockTexts = new Map<string, string>();
/** Отказ чтения списка из kv. */
let mockKvReadFails = false;
/** Отказ записи списка в kv. */
let mockKvWriteFails = false;
/** Зеркало в строку группы отказывает. */
let mockMirrorFails = false;
/** С чем звали зеркало. */
const mockMirrorCalls: unknown[][] = [];

jest.mock('../../storage/local', () => ({
  setGroupPinnedMessage: async (...a: unknown[]) => {
    mockMirrorCalls.push(a);
    if (mockMirrorFails) throw new Error('database is locked');
  },
  getGroupMessageTexts: async (ids: string[]) =>
    new Map(ids.filter((i) => mockTexts.has(i)).map((i) => [i, mockTexts.get(i) ?? null])),
}));

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: async (_pid: number, key: string) =>
    mockKvReadFails ? null : { value: mockKv.get(key) ?? null },
  scopedKvSetCheckedFor: async (_pid: number, key: string, value: string) => {
    if (mockKvWriteFails) return false;
    mockKv.set(key, value);
    return true;
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 7 }) },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { applyLocalPin, clearPinned } from '../groupPinSync';

const GROUP = 'g-971';
const PID = 7;
const KEY = `group_pinned_list_${GROUP}`;

/** Только код: пояснения не должны сами удовлетворять закрепку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SOC = join(__dirname, '..');
const SRC = codeOnly(readFileSync(join(SOC, 'groupPinSync.ts'), 'utf8'));
const SCREEN = codeOnly(
  readFileSync(join(SOC, '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8'),
);

beforeEach(() => {
  mockKv.clear();
  mockTexts.clear();
  mockTexts.set('m1', 'первое объявление');
  mockTexts.set('m2', 'второе объявление');
  mockKvReadFails = false;
  mockKvWriteFails = false;
  mockMirrorFails = false;
  mockMirrorCalls.length = 0;
});

describe('отказ зеркала возвращается ответом, а не исключением', () => {
  it('открепление последнего: назван write_failed', async () => {
    expect(await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true })).toEqual({
      ok: true,
      entries: [{ id: 'm1', text: 'первое объявление', unreadable: false }],
    });

    mockMirrorFails = true;
    const off = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: false });
    expect(off).toEqual({ ok: false, reason: 'write_failed' });
  });

  it('«Открепить все»: ответ false, а не брошенное исключение', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });

    mockMirrorFails = true;
    await expect(clearPinned(GROUP, PID)).resolves.toBe(false);
  });

  it('пока в списке кто-то остался, отказ зеркала закрепление не отменяет', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });

    mockMirrorFails = true;
    const off = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: false });
    expect(off.ok).toBe(true);
    expect(off.ok && off.entries.map((e) => e.id)).toEqual(['m1']);
  });

  it('закрепление при отказавшем зеркале тоже состоялось', async () => {
    mockMirrorFails = true;
    const on = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    expect(on.ok).toBe(true);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отказ, названный там, где его нет, стоит не меньше проглоченного: «не легло»
 * на состоявшемся закреплении заставит человека нажать второй раз, а конверт
 * остальным участникам уже ушёл и повторной отправки у него нет.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: исправное зеркало отвечает как прежде', () => {
  it('закрепление ложится и в kv, и в строку группы', async () => {
    const on = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    expect(on).toEqual({
      ok: true,
      entries: [{ id: 'm1', text: 'первое объявление', unreadable: false }],
    });
    expect(JSON.parse(mockKv.get(KEY) as string)).toEqual(['m1']);
    expect(mockMirrorCalls).toEqual([[GROUP, PID, 'm1', 'первое объявление']]);
  });

  it('«Открепить все» при исправном зеркале по-прежнему отвечает true', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    await expect(clearPinned(GROUP, PID)).resolves.toBe(true);
    expect(mockKv.get(KEY)).toBe('[]');
    expect(mockMirrorCalls.at(-1)).toEqual([GROUP, PID, null, null]);
  });

  it('ГРАНИЦА: список не прочитался — read_failed, до зеркала не доходим', async () => {
    mockKvReadFails = true;
    expect(await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true })).toEqual({
      ok: false,
      reason: 'read_failed',
    });
    expect(mockMirrorCalls).toEqual([]);
  });

  it('ГРАНИЦА: kv не записался — write_failed, зеркала не трогаем', async () => {
    mockKvWriteFails = true;
    expect(await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true })).toEqual({
      ok: false,
      reason: 'write_failed',
    });
    expect(await clearPinned(GROUP, PID)).toBe(false);
    expect(mockMirrorCalls).toEqual([]);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Три довода: зеркало зовут ПОСЛЕ записи источника правды; при пустом kv
 * власть переходит строке группы; поймать исключение на экране некому.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('к моменту зеркала kv уже переписан', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });

    mockMirrorFails = true;
    await clearPinned(GROUP, PID).catch(() => undefined);

    // Источник правды говорит «откреплено» независимо от исхода зеркала.
    expect(mockKv.get(KEY)).toBe('[]');
  });

  it('пустой kv возвращает власть строке группы — экран закрепляет заново', () => {
    expect(SCREEN).toContain('if (!list.length && group.pinnedMessageId) {');
    const at = SCREEN.indexOf('if (!list.length && group.pinnedMessageId) {');
    expect(SCREEN.slice(at, at + 320)).toContain('msgId: group.pinnedMessageId, on: true');
  });

  it('обработчик кнопки исключения не ловит', () => {
    const at = SCREEN.indexOf("accessibilityLabel={total > 1 ? 'Все закреплённые' : 'Открепить'}");
    expect(at).toBeGreaterThan(0);
    const handler = SCREEN.slice(at, at + 1600);
    expect(handler).toContain('void (async () => {');
    // Ни `.catch`, ни try внутри: всё, что бросит ядро, уходит в никуда.
    expect(handler).not.toContain('})().catch');
  });
});

describe('форма исходников: зеркало под присмотром', () => {
  it('отказ зеркала записан в журнал обоими путями', () => {
    expect(SRC).toContain("log.warn('group_pin_mirror_write_failed'");
    expect(SRC).toContain("log.warn('group_pin_clear_mirror_failed'");
  });

  it('пустой список — единственный случай, когда зеркало решает исход', () => {
    expect(SRC).toContain("if (!top) return { ok: false, reason: 'write_failed' };");
  });

  it('голого вызова зеркала не осталось ни в одном из двух путей', () => {
    expect(SRC).not.toContain('  await setGroupPinnedMessage(groupId, ownerProfileId, null, null);\n    return true;');
    const at = SRC.indexOf('export async function clearPinned(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, at + 900);
    expect(body).toContain('try {');
    expect(body).toContain('return false;');
  });
});
