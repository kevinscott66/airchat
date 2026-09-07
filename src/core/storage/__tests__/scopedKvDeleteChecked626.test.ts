/**
 * Проверенное удаление в namespace профиля (v4.32.626).
 *
 * `scopedKvDelete` глотает отказ базы — этого хватает ленивым уборкам, но не
 * снятию глушения: там отказ означает, что человек остался заглушённым, а
 * экран об этом уже отчитался успехом. Готовое `kvDeleteScopedChecked` из
 * local сюда не годится: оно сносит запись без префикса для КАЖДОГО номера
 * профиля, тогда как правило этого модуля — запись без префикса принадлежит
 * первому. Поэтому проверенная форма написана здесь и правило в ней то же.
 */
const mockKv = new Map<string, string>();
const mockFail = new Set<string>();
let mockActiveId = 1;

jest.mock('../local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => {
    if (mockFail.has(k)) throw new Error('db is locked');
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));

import { scopedKvDeleteChecked, scopedKvDeleteCheckedFor } from '../profileScopedKv';

beforeEach(() => {
  mockKv.clear();
  mockFail.clear();
  mockActiveId = 1;
});

it('первый профиль наследует запись без префикса — сносятся обе', async () => {
  mockKv.set('p1:note', 'a');
  mockKv.set('note', 'b');
  await scopedKvDeleteChecked('note');
  expect(mockKv.size).toBe(0);
});

it('второму профилю общая запись не принадлежит — её не трогают', async () => {
  mockActiveId = 2;
  mockKv.set('p2:note', 'a');
  mockKv.set('note', 'b');
  await scopedKvDeleteChecked('note');
  expect([...mockKv.keys()]).toEqual(['note']);
});

it('отказ базы доходит до вызывающего, а не гасится', async () => {
  mockKv.set('p1:note', 'a');
  mockFail.add('p1:note');
  await expect(scopedKvDeleteCheckedFor(1, 'note')).rejects.toThrow('db is locked');
  expect(mockKv.get('p1:note')).toBe('a');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: тихая форма рядом жива и правда молчит', async () => {
  const { scopedKvDelete } = await import('../profileScopedKv');
  mockKv.set('p1:note', 'a');
  await expect(scopedKvDelete('note')).resolves.toBeUndefined();
  expect(mockKv.has('p1:note')).toBe(false);
});
