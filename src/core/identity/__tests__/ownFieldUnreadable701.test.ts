/**
 * Не прочитав своё поле карточки, переписывать его чужим нельзя.
 *
 * v4.32.701. `ownFieldGetFor` читал свою запись строчной формой
 * `kvGetSecretUpgrading`, а та сводит «поля нет» и «поле не прочиталось» к
 * одному null. На этом стоял перенос общей записи (до v4.32.288 карточка
 * лежала под голым ключом, открытым текстом): своя не открылась — значит, её
 * нет — значит, берём общую. Дальше по цепочке `kvSetSecret` кладёт общую
 * ПОВЕРХ живого шифртекста (проверки `mayOverwrite` там нет), а `kvDelete`
 * убирает последнюю другую копию. Карточка откатывалась на давнее содержимое
 * необратимо, и уходило это не только в свою базу: profileSync собирает
 * конверт из этих же чтений и рассылает его контактам.
 *
 * Ровно это правило уже вынесено рядом — в `kvGetSecretCellScoped`
 * (v4.32.552). Здесь перенос написан по месту, и правило до него не дошло.
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
    // Прежняя, строчная форма — с той самой семантикой, из-за которой правка и
    // понадобилась: нечитаемое поле она отдаёт как null, ровно как отсутствующее.
    // Стоит здесь затем, чтобы прогон на дореформенном дереве шёл по живому
    // коду и падал на самой ошибке, а не на отсутствующем имени в заглушке.
    kvGetSecretUpgrading: jest.fn(async (key: string) => {
      const cell = cells[key] ?? { state: 'absent' };
      return cell.state === 'plain' ? cell.text : null;
    }),
    kvGetSecret: jest.fn(async (key: string) => legacy[key] ?? null),
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

jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getProfileName: () => 'Личный',
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { ownFieldGetFor } from '../ownProfile';

const mockLocal = jest.requireMock('../../storage/local') as {
  __cells: Record<string, Cell>;
  __legacy: Record<string, string>;
  __state: { setSecretOk: boolean };
  kvGetSecretCellUpgrading: jest.Mock;
  kvGetSecret: jest.Mock;
  kvSetSecret: jest.Mock;
  kvDelete: jest.Mock;
};

const KEY = 'user_username' as const;
const SCOPED = `p1:${KEY}`;

const ownSrc = readFileSync(join(__dirname, '..', 'ownProfile.ts'), 'utf8');
const localSrc = readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const encSrc = readFileSync(join(__dirname, '..', '..', 'storage', 'localEncryption.ts'), 'utf8');

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__cells)) delete mockLocal.__cells[k];
  for (const k of Object.keys(mockLocal.__legacy)) delete mockLocal.__legacy[k];
  mockLocal.__state.setSecretOk = true;
  jest.clearAllMocks();
});

describe('нечитаемое своё поле не подменяется общим', () => {
  it('сбой расшифровки своей записи не пускает в ход общую', async () => {
    mockLocal.__cells[SCOPED] = { state: 'unreadable' };
    mockLocal.__legacy[KEY] = 'Имя из общей записи';
    expect(await ownFieldGetFor(1, KEY)).toBeNull();
    expect(mockLocal.kvGetSecret).not.toHaveBeenCalled();
  });

  it('и живой шифртекст остаётся на месте — ни записи поверх, ни удаления', async () => {
    mockLocal.__cells[SCOPED] = { state: 'unreadable' };
    mockLocal.__legacy[KEY] = 'Имя из общей записи';
    await ownFieldGetFor(1, KEY);
    expect(mockLocal.kvSetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvDelete).not.toHaveBeenCalled();
    expect(mockLocal.__cells[SCOPED]).toEqual({ state: 'unreadable' });
    expect(mockLocal.__legacy[KEY]).toBe('Имя из общей записи');
  });

  it('правило не зависит от того, чей это профиль', async () => {
    mockLocal.__cells[`p2:${KEY}`] = { state: 'unreadable' };
    mockLocal.__legacy[KEY] = 'Имя из общей записи';
    expect(await ownFieldGetFor(2, KEY)).toBeNull();
    expect(mockLocal.kvSetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvDelete).not.toHaveBeenCalled();
  });
});

describe('остальные исходы разбираются как прежде', () => {
  it('своей записи действительно нет — перенос общей идёт', async () => {
    mockLocal.__legacy[KEY] = 'Имя из общей записи';
    expect(await ownFieldGetFor(1, KEY)).toBe('Имя из общей записи');
    expect(mockLocal.kvSetSecret).toHaveBeenCalledWith(SCOPED, 'Имя из общей записи');
    expect(mockLocal.kvDelete).toHaveBeenCalledWith(KEY);
  });

  it('копия не легла — общую запись не удаляем', async () => {
    mockLocal.__legacy[KEY] = 'Имя из общей записи';
    mockLocal.__state.setSecretOk = false;
    expect(await ownFieldGetFor(1, KEY)).toBe('Имя из общей записи');
    expect(mockLocal.kvDelete).not.toHaveBeenCalled();
    expect(mockLocal.__legacy[KEY]).toBe('Имя из общей записи');
  });

  it('своя запись читается — она и возвращается, общую не трогаем', async () => {
    mockLocal.__cells[SCOPED] = { state: 'plain', text: 'Своё имя' };
    mockLocal.__legacy[KEY] = 'Имя из общей записи';
    expect(await ownFieldGetFor(1, KEY)).toBe('Своё имя');
    expect(mockLocal.kvGetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvDelete).not.toHaveBeenCalled();
  });

  it('общая запись не наследуется второму профилю', async () => {
    mockLocal.__legacy[KEY] = 'Имя из общей записи';
    expect(await ownFieldGetFor(2, KEY)).toBeNull();
    expect(mockLocal.kvGetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvSetSecret).not.toHaveBeenCalled();
  });

  it('ни своей, ни общей — просто пусто', async () => {
    expect(await ownFieldGetFor(1, KEY)).toBeNull();
    expect(mockLocal.kvSetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvDelete).not.toHaveBeenCalled();
  });
});

describe('форма правки закреплена', () => {
  it('поле карточки читается формой с тремя исходами', () => {
    expect(ownSrc).toContain('const own = await kvGetSecretCellUpgrading(profileScopedKey(pid, key));');
    expect(ownSrc).toContain("if (own.state !== 'absent') return cellTextOrNull(own);");
  });

  it('и строчная форма из чтения карточки убрана целиком', () => {
    expect(ownSrc).not.toContain('kvGetSecretUpgrading(');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строчная форма по-прежнему сливает отсутствие с нечитаемостью', () => {
    expect(localSrc).toContain('return cellTextOrNull(await kvGetSecretCellUpgrading(key));');
  });

  it('запись секрета по-прежнему кладёт поверх чего угодно', () => {
    const at = localSrc.indexOf('export async function kvSetSecret(key: string, value: string)');
    expect(at).toBeGreaterThan(0);
    expect(localSrc.slice(at, at + 600)).not.toContain('mayOverwrite');
  });

  it('старая запись открытым текстом читается как есть — ветка переноса не мертва', () => {
    expect(encSrc).toContain('if (!stored.startsWith(AT_REST_PREFIX)) return stored;');
  });

  it('образец правила стоит рядом, в области профиля', () => {
    const at = localSrc.indexOf('export async function kvGetSecretCellScoped(');
    expect(at).toBeGreaterThan(0);
    expect(localSrc.slice(at, at + 600)).toContain("if (own.state !== 'absent') return own;");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитаны', () => {
    expect(ownSrc.length).toBeGreaterThan(2000);
    expect(localSrc.length).toBeGreaterThan(2000);
    expect(encSrc.length).toBeGreaterThan(2000);
  });

  it('заглушка действительно различает три исхода', async () => {
    mockLocal.__cells['a'] = { state: 'unreadable' };
    mockLocal.__cells['b'] = { state: 'plain', text: 'x' };
    const local = await import('../../storage/local');
    const read = local.kvGetSecretCellUpgrading as unknown as (k: string) => Promise<Cell>;
    expect(await read('a')).toEqual({ state: 'unreadable' });
    expect(await read('b')).toEqual({ state: 'plain', text: 'x' });
    expect(await read('c')).toEqual({ state: 'absent' });
  });
});
