/**
 * Автоудаление по умолчанию — настройка профиля, а не установки (v4.32.483).
 *
 * Дефект: ключ `default_auto_delete_ms` лежал без имени профиля. Это
 * единственная настройка, по которой переписка УДАЛЯЕТСЯ, и она молча
 * служила всем аккаунтам сразу: включённое в отдельном аккаунте автоудаление
 * ставило таймер на новые разговоры основного, а выключенное в основном
 * оставляло навсегда те, что человек заводил как временные. Уборка удалённого
 * профиля сметает `p<id>:%` — под общее имя запись не подпадала и доставалась
 * следующему профилю с тем же номером.
 *
 * Второй дефект того же места: кэш запоминал ПРОВАЛ чтения. Одна ошибка
 * SQLite на старте означала «автоудаление выключено» до конца запуска
 * приложения — настройку отменяла случайность.
 */
const mockKv: Record<string, string> = {};
let mockReadFails = false;

jest.mock('../local', () => ({
  kvTryGet: jest.fn(async (k: string) => (mockReadFails ? null : { value: mockKv[k] ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv[k] = v; }),
  kvDelete: jest.fn(async (k: string) => { delete mockKv[k]; }),
}));

let mockActiveProfileId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveProfileId }) },
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  forgetDefaultDisappear,
  getDefaultDisappearMs,
  getDefaultDisappearMsFor,
  setDefaultDisappearMs,
  setDefaultDisappearMsFor,
} from '../defaultDisappear';
import { DEFAULT_AUTO_DELETE_KEY } from '../autoDeletePolicy';

const KEY = DEFAULT_AUTO_DELETE_KEY;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Кэш живёт весь файл, поэтому каждой проверке достаётся свежий номер. */
let lastPid = 100;
const pid = (): number => ++lastPid;

beforeEach(() => {
  for (const k of Object.keys(mockKv)) delete mockKv[k];
  mockReadFails = false;
  mockActiveProfileId = 1;
});

describe('значение принадлежит профилю', () => {
  it('пишется под именем своего профиля, без общей записи', async () => {
    const p = pid();
    await setDefaultDisappearMsFor(p, HOUR);
    expect(mockKv[`p${p}:${KEY}`]).toBe(String(HOUR));
    expect(mockKv[KEY]).toBeUndefined();
  });

  it('соседний профиль чужого таймера не получает', async () => {
    const mine = pid();
    const other = pid();
    await setDefaultDisappearMsFor(mine, DAY);
    expect(await getDefaultDisappearMsFor(other)).toBeNull();
    expect(await getDefaultDisappearMsFor(mine)).toBe(DAY);
  });

  it('у каждого профиля свой ответ, и чтение подряд их не путает', async () => {
    const first = pid();
    const second = pid();
    await setDefaultDisappearMsFor(first, HOUR);
    await setDefaultDisappearMsFor(second, null);
    expect(await getDefaultDisappearMsFor(first)).toBe(HOUR);
    expect(await getDefaultDisappearMsFor(second)).toBeNull();
    expect(await getDefaultDisappearMsFor(first)).toBe(HOUR);
  });

  it('запись, сделанная когда профиль был один, достаётся первому', async () => {
    mockKv[KEY] = String(DAY);
    expect(await getDefaultDisappearMsFor(1)).toBe(DAY);
    // Переехала под префикс — иначе снова досталась бы всем.
    expect(mockKv[`p1:${KEY}`]).toBe(String(DAY));
    expect(mockKv[KEY]).toBeUndefined();
    forgetDefaultDisappear(1);
  });

  it('без номера — у активного профиля', async () => {
    const p = pid();
    mockActiveProfileId = p;
    await setDefaultDisappearMs(HOUR);
    expect(mockKv[`p${p}:${KEY}`]).toBe(String(HOUR));
    expect(await getDefaultDisappearMs()).toBe(HOUR);
  });
});

describe('границы значения', () => {
  it('мусор в базе таймером не становится', async () => {
    const p = pid();
    // Миллисекунда стёрла бы переписку сразу после первого сообщения.
    mockKv[`p${p}:${KEY}`] = '1';
    expect(await getDefaultDisappearMsFor(p)).toBeNull();
  });

  it('«Выкл» записывается нулём и читается как null', async () => {
    const p = pid();
    await setDefaultDisappearMsFor(p, null);
    expect(mockKv[`p${p}:${KEY}`]).toBe('0');
    expect(await getDefaultDisappearMsFor(p)).toBeNull();
  });
});

describe('память профиля не переживает его удаление', () => {
  it('после уборки номер отвечает заново, а не из кэша', async () => {
    const p = pid();
    await setDefaultDisappearMsFor(p, DAY);
    // Уборка удаляет строки в базе; кэш обязан уйти вместе с ними.
    delete mockKv[`p${p}:${KEY}`];
    forgetDefaultDisappear(p);
    expect(await getDefaultDisappearMsFor(p)).toBeNull();
  });
});

describe('провал чтения не отменяет настройку', () => {
  it('ошибка базы не запоминается как «выключено»', async () => {
    const p = pid();
    mockKv[`p${p}:${KEY}`] = String(DAY);
    mockReadFails = true;
    expect(await getDefaultDisappearMsFor(p)).toBeNull();
    mockReadFails = false;
    expect(await getDefaultDisappearMsFor(p)).toBe(DAY);
  });
});

describe('форма исходников', () => {
  const src = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

  it('разговор берёт значение у своего владельца, а не у экрана', () => {
    expect(src('core/storage/local.ts')).toContain(
      'const defaultDisappear = await getDefaultDisappearMsFor(ownerProfileId);'
    );
  });

  it('уборка профиля снимает и кэш в памяти', () => {
    expect(src('core/storage/local.ts')).toContain('forgetDefaultDisappear(profileId);');
  });

  it('экран настроек не читает ключ голым именем', () => {
    const s = src('ui/screens/SettingsScreen.tsx');
    expect(s).not.toContain("kvGet('default_auto_delete_ms')");
    expect(s).toContain('getDefaultDisappearMs()');
  });

  it('имя ключа набрано один раз', () => {
    // Строка `default_auto_delete_ms` в коде живёт только в autoDeletePolicy.
    const offenders = ['core/storage/local.ts', 'ui/screens/SettingsScreen.tsx'].filter((f) =>
      src(f).includes("'default_auto_delete_ms'")
    );
    expect(offenders).toEqual([]);
    expect(src('core/storage/autoDeletePolicy.ts')).toContain(
      "export const DEFAULT_AUTO_DELETE_KEY = 'default_auto_delete_ms';"
    );
  });

  it('проверка не пустая', () => {
    expect(src('core/storage/local.ts')).toContain('getDefaultDisappearMsFor');
  });
});
