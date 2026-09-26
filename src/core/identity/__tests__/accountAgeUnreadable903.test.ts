/**
 * Дефект: не прочитав дату заведения аккаунта, экран профиля записывал поверх
 * неё сегодняшнюю.
 *
 * v4.32.903. `ownFieldGet('account_created_at')` сводит «поля нет» и «поле не
 * прочиталось» к одному null, а ProfileScreen отвечал на null записью:
 *
 *   let createdAt = await ownFieldGet('account_created_at');
 *   if (!createdAt) { createdAt = String(Date.now()); await ownFieldSet(...); }
 *
 * Цена: база не ответила один раз — и настоящая дата затёрта навсегда. «В
 * AirChat 2 года» превращается в «В AirChat Сегодня», и восстановить прежнее
 * значение неоткуда: другой копии этой даты в приложении нет. Отказ базы тут
 * не выдумка — то же самое чтение уже разводят по трём состояниям соседние
 * поля карточки (v4.32.701, v4.32.705).
 *
 * Правка: у активного профиля появилась трёхсостоянная форма чтения, а экран
 * пишет только тогда, когда точно знает, что записи нет.
 */
type Cell = { state: 'absent' } | { state: 'plain'; text: string } | { state: 'unreadable' };

jest.mock('../../storage/local', () => {
  const cells: Record<string, Cell> = {};
  const legacy: Record<string, string> = {};
  const state = { setSecretOk: true };
  return {
    __cells: cells,
    __legacy: legacy,
    __state: state,
    kvGetSecretCellUpgrading: jest.fn(async (key: string) => cells[key] ?? { state: 'absent' }),
    // Прежняя строчная форма живёт в моке нарочно: без неё дореформенный
    // ownFieldGet упал бы на отсутствующем имени, и контрольные проверки
    // ничего бы не подтвердили.
    kvGetSecretUpgrading: jest.fn(async (key: string) => {
      const cell = cells[key] ?? { state: 'absent' };
      return cell.state === 'plain' ? cell.text : null;
    }),
    kvGetSecret: jest.fn(async (key: string) => legacy[key] ?? null),
    // v4.32.978: та же общая запись, но тремя состояниями. Обе формы стоят
    // поверх одного хранилища, как в `local.ts`, где строчная и написана
    // поверх ячейки; строчная оставлена, чтобы прогон на дореформенном
    // дереве шёл по живому коду.
    kvGetSecretCell: jest.fn(async (key: string) =>
      (key in legacy ? { state: 'plain', text: legacy[key] } : { state: 'absent' })),
    kvSetSecret: jest.fn(async (key: string, value: string) => {
      if (!state.setSecretOk) return false;
      cells[key] = { state: 'plain', text: value };
      return true;
    }),
    kvSetSecretScoped: jest.fn(async (pid: number, key: string, value: string) => {
      if (!state.setSecretOk) return false;
      cells[`p${pid}:${key}`] = { state: 'plain', text: value };
      return true;
    }),
    kvDelete: jest.fn(async (key: string) => { delete legacy[key]; }),
  };
});

const mockActive = { id: 1 };
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: mockActive.id, name: 'Личный' }),
    getProfileName: () => 'Личный',
  },
}));

jest.mock('../../logger', () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from 'fs';
import { join } from 'path';

// Пространством имён, а не поимённо: до правки трёхсостоянной формы у
// активного профиля нет вовсе, и поимённый импорт уронил бы весь файл —
// вместе с контрольными проверками, которые обязаны идти зелёными и там.
import * as ownProfile from '../ownProfile';

const mockLocal = jest.requireMock('../../storage/local') as {
  __cells: Record<string, Cell>;
  __legacy: Record<string, string>;
  __state: { setSecretOk: boolean };
};

const KEY = 'account_created_at' as const;
const SCOPED = `p1:${KEY}`;

const screen = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'screens', 'ProfileScreen.tsx'), 'utf8');
const ownSrc = readFileSync(join(__dirname, '..', 'ownProfile.ts'), 'utf8');

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__cells)) delete mockLocal.__cells[k];
  for (const k of Object.keys(mockLocal.__legacy)) delete mockLocal.__legacy[k];
  mockLocal.__state.setSecretOk = true;
  mockActive.id = 1;
  jest.clearAllMocks();
});

describe('нечитаемая дата заведения аккаунта не выдаётся за отсутствующую', () => {
  it('отказ базы у активного профиля — это null, а не «поля нет»', async () => {
    mockLocal.__cells[SCOPED] = { state: 'unreadable' };
    await expect(ownProfile.ownFieldTryGet(KEY)).resolves.toBeNull();
  });

  it('пустая ячейка так и говорит: записи нет', async () => {
    await expect(ownProfile.ownFieldTryGet(KEY)).resolves.toEqual({ text: null });
  });

  it('записанная дата возвращается как есть', async () => {
    mockLocal.__cells[SCOPED] = { state: 'plain', text: '1700000000000' };
    await expect(ownProfile.ownFieldTryGet(KEY)).resolves.toEqual({ text: '1700000000000' });
  });

  it('читается активный профиль, а не первый', async () => {
    mockActive.id = 2;
    mockLocal.__cells['p2:account_created_at'] = { state: 'plain', text: '1800000000000' };
    mockLocal.__cells[SCOPED] = { state: 'plain', text: 'дата первого профиля' };
    await expect(ownProfile.ownFieldTryGet(KEY)).resolves.toEqual({ text: '1800000000000' });
  });

  it('экран профиля читает дату трёхсостоянной формой', () => {
    expect(screen).toContain("const created = await ownFieldTryGet('account_created_at');");
    expect(screen).not.toContain("let createdAt = await ownFieldGet('account_created_at');");
  });

  it('запись идёт только на «записи нет», а не на любой null', () => {
    expect(screen).toContain('} else if (created) {');
    expect(screen).toContain("if ((await ownFieldSet('account_created_at', String(now))) && alive) setAccountCreatedAt(now);");
  });
});

describe('прежние формы чтения не изменились', () => {
  it('строчная форма по-прежнему сводит отказ к null', async () => {
    mockLocal.__cells[SCOPED] = { state: 'unreadable' };
    await expect(ownProfile.ownFieldGet(KEY)).resolves.toBeNull();
  });

  it('строчная форма отдаёт записанное значение', async () => {
    mockLocal.__cells[SCOPED] = { state: 'plain', text: '1700000000000' };
    await expect(ownProfile.ownFieldGet(KEY)).resolves.toBe('1700000000000');
  });

  it('трёхсостоянная форма названного профиля осталась на месте', async () => {
    expect(ownSrc).toContain('export async function ownFieldTryGetFor(');
    mockLocal.__cells['p3:account_created_at'] = { state: 'unreadable' };
    await expect(ownProfile.ownFieldTryGetFor(3, KEY)).resolves.toBeNull();
  });

  it('строка про возраст показывается только когда есть что показать', () => {
    expect(screen).toContain('if (!accountCreatedAt) return null;');
    expect(screen).toContain('{accountAgeLabel ? (');
    expect(screen).toContain('В AirChat {accountAgeLabel}');
  });
});
