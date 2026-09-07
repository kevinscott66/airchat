/**
 * Снятие глушения отвечает за свой исход (v4.32.626).
 *
 * `unmute` возвращала `Promise<void>` и удаляла запись непроверенной формой:
 * отказ базы пропадал целиком. Экран «Заглушённые» на это отвечал бодрым
 * «Уведомления включены», убирал строку из списка — а запись оставалась, и
 * собеседник продолжал молчать до следующего открытия экрана, где он снова
 * оказывался заглушённым без объяснений. Здесь проверяется поведение: при
 * отказе удаления `unmute` отдаёт `false`, а запись честно остаётся на месте.
 */
const mockKv = new Map<string, string>();
/** Ключи, на которых проверенное удаление обязано сорваться. */
const mockFail = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => {
    if (mockFail.has(k)) throw new Error('db is locked');
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { isMuted, setMuted, unmute } from '../muteStore';

const PEER = 'Q'.repeat(43);

beforeEach(() => {
  mockKv.clear();
  mockFail.clear();
});

it('ПРОВЕРКА НЕ ПУСТАЯ: при исправной базе снятие удаётся и запись уходит', async () => {
  await setMuted('chat', PEER);
  expect(await isMuted('chat', PEER)).toBe(true);
  expect(await unmute('chat', PEER)).toBe(true);
  expect(await isMuted('chat', PEER)).toBe(false);
  expect(mockKv.size).toBe(0);
});

it('отказ базы виден вызывающему, и запись остаётся заглушённой', async () => {
  await setMuted('chat', PEER);
  // Срываем удаление ровно того ключа, под которым запись и лежит.
  for (const k of mockKv.keys()) mockFail.add(k);

  expect(await unmute('chat', PEER)).toBe(false);
  // Не «показали успех и убрали строку»: собеседник всё ещё заглушён.
  expect(await isMuted('chat', PEER)).toBe(true);
});

it('пустой id — не отказ базы, но и не успех', async () => {
  expect(await unmute('chat', '')).toBe(false);
});
