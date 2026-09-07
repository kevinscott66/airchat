/**
 * Переезд старых записей «без звука» не теряет и не воскрешает глушение
 * (v4.32.628).
 *
 * Уборка на каждом выходе приложения на передний план переносит записи,
 * сделанные до появления канонического имени (см. muteChatId): читает запись
 * под новым именем, и если её нет — копирует туда старую, а старую снимает.
 * Обе половины этой проверки были слепы к отказу базы.
 *
 * Первое. «Прочитать не удалось» приходило тем же null, что и «записи нет»:
 * человек снял глушение ЭТОЙ сборкой, база на секунду занята — и уборка
 * ставила поверх старое значение. Собеседник снова заглушён, причём если
 * старая запись была бессрочной, то навсегда.
 *
 * Второе. Копия делалась `scopedKvSet`, который гасит свою ошибку и отдаёт
 * void: «не влезло» и «легло» приходили одинаково, а снятие старой записи шло
 * следом безусловно. Значит неудачная копия стирала глушение совсем — молча.
 *
 * Здесь проверяется поведение на живом модуле: при отказе чтения и при отказе
 * записи старая запись обязана остаться на месте.
 */
const mockKv = new Map<string, string>();
/** Ключи, чтение которых обязано сорваться (kvTryGet отдаёт null). */
const mockReadFail = new Set<string>();
/** Ключи, запись в которые обязана не состояться (kvSetChecked отдаёт false). */
const mockWriteFail = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockReadFail.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => {
    if (mockWriteFail.has(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => { mockKv.delete(k); },
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { isMuted, sweepExpiredMutes } from '../muteStore';
import { canonicalMuteId } from '../muteChatId';

/** Открытый ключ собеседника — под таким именем запись делали прежние сборки. */
const PEER = 'Q'.repeat(43);
const DID = canonicalMuteId('chat', PEER);

/** Физические имена: активный профиль здесь всегда первый. */
const LEGACY = `p1:mute:chat:${PEER}`;
const CANON = `p1:mute:chat:${DID}`;

beforeEach(() => {
  mockKv.clear();
  mockReadFail.clear();
  mockWriteFail.clear();
  mockKv.set(LEGACY, '1');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: при исправной базе запись переезжает и старое имя уходит', async () => {
  expect(DID).not.toBe(PEER);
  expect(await isMuted('chat', PEER)).toBe(false);

  expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 1 });

  expect(mockKv.get(CANON)).toBe('1');
  expect(mockKv.has(LEGACY)).toBe(false);
  // Ради чего переезд и делается: заглушение наконец начинает работать.
  expect(await isMuted('chat', PEER)).toBe(true);
});

it('сбой чтения нового имени не даёт права переносить старое значение', async () => {
  mockReadFail.add(CANON);

  expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 0 });

  // Ничего не записано поверх и ничего не потеряно: следующая уборка повторит.
  expect(mockKv.has(CANON)).toBe(false);
  expect(mockKv.get(LEGACY)).toBe('1');
});

it('несостоявшаяся копия не влечёт за собой снятия старой записи', async () => {
  mockWriteFail.add(CANON);

  expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 0 });

  expect(mockKv.has(CANON)).toBe(false);
  expect(mockKv.get(LEGACY)).toBe('1');
});

it('свежая запись под новым именем главнее старой и не переписывается', async () => {
  const until = `until:${Date.now() + 60 * 60 * 1000}`;
  mockKv.set(CANON, until);

  expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 1 });

  expect(mockKv.get(CANON)).toBe(until);
  expect(mockKv.has(LEGACY)).toBe(false);
});

it('истёкшая старая запись просто убирается, а не переезжает', async () => {
  mockKv.set(LEGACY, `until:${Date.now() - 1000}`);

  expect(await sweepExpiredMutes()).toEqual({ removed: 1, migrated: 0 });

  expect(mockKv.has(CANON)).toBe(false);
  expect(mockKv.has(LEGACY)).toBe(false);
});
