/**
 * Глушение считается поставленным, только если оно записалось (v4.32.630).
 *
 * Зеркало к v4.32.626: там ответ появился у `unmute`, здесь — у `setMuted`.
 * `scopedKvSet` гасит свою ошибку, функция не возвращала ничего, и экраны
 * безусловно рисовали «Без звука на 8 часов». Записи при этом могло не быть:
 * уведомления продолжали приходить, а список «Заглушённые» оставался пустым —
 * узнать о расхождении человеку было неоткуда, и повторить попытку он не
 * догадывался, ведь ему уже сказали, что получилось.
 */
const mockKv = new Map<string, string>();
const mockWriteFail = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  kvSetChecked: async (k: string, v: string) => {
    if (mockWriteFail.has(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvDeleteChecked: async (k: string) => {
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async () => [],
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { isMuted, setMuted } from '../muteStore';
import { canonicalMuteId } from '../muteChatId';

const PEER = 'Q'.repeat(43);
const KEY = `p1:mute:chat:${canonicalMuteId('chat', PEER)}`;
const HOUR = 3_600_000;

beforeEach(() => {
  mockKv.clear();
  mockWriteFail.clear();
});

it('ПРОВЕРКА НЕ ПУСТАЯ: при исправной базе глушение ставится и признаётся', async () => {
  expect(await isMuted('chat', PEER)).toBe(false);
  expect(await setMuted('chat', PEER)).toBe(true);
  expect(mockKv.get(KEY)).toBe('1');
  expect(await isMuted('chat', PEER)).toBe(true);
});

it('отказ записи не выдаётся за поставленное глушение', async () => {
  mockWriteFail.add(KEY);
  expect(await setMuted('chat', PEER)).toBe(false);
  expect(mockKv.has(KEY)).toBe(false);
  expect(await isMuted('chat', PEER)).toBe(false);
});

it('отказ записи со сроком — тоже отказ', async () => {
  mockWriteFail.add(KEY);
  expect(await setMuted('chat', PEER, { untilMs: Date.now() + HOUR })).toBe(false);
  expect(await isMuted('chat', PEER)).toBe(false);
});

it('срок, который ничего не глушит, успехом не называется', async () => {
  // v4.32.490: порченый и прошедший срок снимают глушение вместо того, чтобы
  // сделать его бессрочным. Человек просил тишины до утра — и не получил её.
  expect(await setMuted('chat', PEER, { untilMs: Number.NaN })).toBe(false);
  expect(await setMuted('chat', PEER, { untilMs: Date.now() - HOUR })).toBe(false);
  expect(await isMuted('chat', PEER)).toBe(false);
});

it('пустой идентификатор — отказ, а не тихое «сделано»', async () => {
  expect(await setMuted('chat', '')).toBe(false);
});

it('срок записывается и признаётся', async () => {
  const until = Date.now() + HOUR;
  expect(await setMuted('chat', PEER, { untilMs: until })).toBe(true);
  expect(mockKv.get(KEY)).toBe(`until:${until}`);
  expect(await isMuted('chat', PEER)).toBe(true);
});
