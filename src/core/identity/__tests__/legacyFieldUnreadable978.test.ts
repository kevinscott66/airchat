/**
 * Нечитаемая общая запись выдавала себя за «поля нет» (v4.32.977 → 978).
 *
 * Дефект. Своё поле карточки читается тремя состояниями с v4.32.701: не
 * прочитав запись, переписывать её нельзя. Но сразу за этой проверкой стоит
 * перенос общей записи — той, что до v4.32.288 лежала под голым ключом, — и
 * читался он строчной формой `kvGetSecret`. Она сводит «записи нет» и «не
 * открылась» к одному null (`return cellTextOrNull(await kvGetSecretCell(key));`),
 * и на нечитаемой общей записи `ownFieldTryGetFor` отвечал `{ text: null }`.
 *
 * Цена. `{ text: null }` — не умолчание, а утверждение «поля нет». На нём
 * стоит `isUsernameTakenByAnotherProfile`: из «у соседа этого имени нет» она
 * выводит разрешение занять `@имя`. Первый профиль, чья общая запись не
 * открылась, считался безымянным — и второй аккаунт на том же устройстве
 * занимал имя первого. Имя — единственный человекочитаемый адрес в
 * приложении; двух одноимённых получателю конверта не различить ничем, а
 * отозвать разошедшееся имя нечем. Ровно этот вывод уже сделан в v4.32.705,
 * до переноса он просто не дошёл.
 *
 * Правка. Общая запись читается `kvGetSecretCell`, и `'unreadable'` даёт
 * `null` — «не прочитали», тот же ответ, что и у своей записи строкой выше.
 *
 * Границы. Поверх непрочитанного ничего не пишется и общая запись не
 * удаляется: иначе перенос уничтожил бы последнюю копию карточки. Пустая
 * общая запись переносится как прежде — пустая строка законна.
 */
type Cell = { state: 'absent' } | { state: 'plain'; text: string } | { state: 'unreadable' };

jest.mock('../../storage/local', () => {
  const cells: Record<string, Cell> = {};
  const legacy: Record<string, Cell> = {};
  const state = { setSecretOk: true };
  return {
    __cells: cells,
    __legacy: legacy,
    __state: state,
    kvGetSecretCellUpgrading: jest.fn(async (key: string) => cells[key] ?? { state: 'absent' }),
    // Обе формы чтения общей записи стоят поверх одного хранилища — как в
    // `local.ts`, где строчная написана поверх ячейки. Строчная оставлена
    // нарочно: на дореформенном дереве перенос идёт через неё, и прогон
    // падает на самой ошибке, а не на отсутствующем имени в заглушке.
    kvGetSecretCell: jest.fn(async (key: string) => legacy[key] ?? { state: 'absent' }),
    kvGetSecret: jest.fn(async (key: string) => {
      const cell = legacy[key] ?? { state: 'absent' };
      return cell.state === 'plain' ? cell.text : null;
    }),
    kvGetSecretUpgrading: jest.fn(async (key: string) => {
      const cell = cells[key] ?? { state: 'absent' };
      return cell.state === 'plain' ? cell.text : null;
    }),
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

const mockProfiles = { ids: [1, 2], complete: true };

jest.mock('../profileManager', () => ({
  profileManager: {
    init: jest.fn(async () => undefined),
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getProfileName: () => 'Личный',
    getProfileIds: () => [...mockProfiles.ids],
    getProfileIdsComplete: () => ({ ids: [...mockProfiles.ids], complete: mockProfiles.complete }),
  },
}));

jest.mock('../../logger', () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  OWN_USERNAME_KEY,
  isUsernameTakenByAnotherProfile,
  ownFieldTryGetFor,
} from '../ownProfile';

const mockLocal = jest.requireMock('../../storage/local') as {
  __cells: Record<string, Cell>;
  __legacy: Record<string, Cell>;
  __state: { setSecretOk: boolean };
  kvGetSecret: jest.Mock;
  kvGetSecretCell: jest.Mock;
  kvSetSecret: jest.Mock;
  kvSetSecretScoped: jest.Mock;
  kvDelete: jest.Mock;
};

const SCOPED = `p1:${OWN_USERNAME_KEY}`;

const SRC = join(__dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8');

/** Только код: пересказ в комментарии не должен закрывать закрепку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__cells)) delete mockLocal.__cells[k];
  for (const k of Object.keys(mockLocal.__legacy)) delete mockLocal.__legacy[k];
  mockLocal.__state.setSecretOk = true;
  mockProfiles.ids = [1, 2];
  mockProfiles.complete = true;
  jest.clearAllMocks();
});

describe('общая запись не открылась', () => {
  it('это «не прочитали», а не «поля нет»', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'unreadable' };
    expect(await ownFieldTryGetFor(1, OWN_USERNAME_KEY)).toBeNull();
  });

  it('имя соседа, которого не прочитали, считается занятым', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'unreadable' };
    expect(await isUsernameTakenByAnotherProfile('anya', 2)).toBe(true);
  });

  it('ГРАНИЦА: поверх непрочитанного не пишут и общую запись не удаляют', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'unreadable' };
    await ownFieldTryGetFor(1, OWN_USERNAME_KEY);
    expect(mockLocal.kvSetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvDelete).not.toHaveBeenCalled();
    expect(mockLocal.__legacy[OWN_USERNAME_KEY]).toEqual({ state: 'unreadable' });
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('общей записи нет — «поля нет», и это по-прежнему утверждение', async () => {
    expect(await ownFieldTryGetFor(1, OWN_USERNAME_KEY)).toEqual({ text: null });
    expect(await isUsernameTakenByAnotherProfile('anya', 2)).toBe(false);
  });

  it('общая запись прочиталась — переносится и убирается', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'plain', text: 'anya' };
    expect(await ownFieldTryGetFor(1, OWN_USERNAME_KEY)).toEqual({ text: 'anya' });
    expect(mockLocal.__cells[SCOPED]).toEqual({ state: 'plain', text: 'anya' });
    expect(mockLocal.kvDelete).toHaveBeenCalledWith(OWN_USERNAME_KEY);
  });

  it('прочитанное имя соседа занимает имя', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'plain', text: 'anya' };
    expect(await isUsernameTakenByAnotherProfile('anya', 2)).toBe(true);
  });

  it('копия не легла — общую запись не удаляем', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'plain', text: 'anya' };
    mockLocal.__state.setSecretOk = false;
    expect(await ownFieldTryGetFor(1, OWN_USERNAME_KEY)).toEqual({ text: 'anya' });
    expect(mockLocal.kvDelete).not.toHaveBeenCalled();
  });

  it('пустая общая запись законна и переносится как есть', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'plain', text: '' };
    expect(await ownFieldTryGetFor(1, OWN_USERNAME_KEY)).toEqual({ text: '' });
    expect(mockLocal.kvDelete).toHaveBeenCalledWith(OWN_USERNAME_KEY);
  });

  it('ГРАНИЦА: своя запись прочиталась — к общей не ходят вовсе', async () => {
    mockLocal.__cells[SCOPED] = { state: 'plain', text: 'своё' };
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'unreadable' };
    expect(await ownFieldTryGetFor(1, OWN_USERNAME_KEY)).toEqual({ text: 'своё' });
    expect(mockLocal.kvGetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvGetSecretCell).not.toHaveBeenCalled();
  });

  it('ГРАНИЦА: второму профилю общая запись не наследуется и не читается', async () => {
    mockLocal.__legacy[OWN_USERNAME_KEY] = { state: 'unreadable' };
    expect(await ownFieldTryGetFor(2, OWN_USERNAME_KEY)).toEqual({ text: null });
    expect(mockLocal.kvGetSecret).not.toHaveBeenCalled();
    expect(mockLocal.kvGetSecretCell).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строчная форма по-прежнему складывает три состояния в два', () => {
    expect(codeOnly(read('storage', 'local.ts'))).toContain(
      'return cellTextOrNull(await kvGetSecretCell(key));',
    );
  });

  it('своя запись и без того читается тремя состояниями', () => {
    expect(codeOnly(read('identity', 'ownProfile.ts'))).toContain(
      "if (own.state === 'unreadable') return null;",
    );
  });

  it('из «не прочитали» проверка имени выводит «занято», а не «свободно»', () => {
    const own = codeOnly(read('identity', 'ownProfile.ts'));
    expect(own).toContain('if (read === null) {');
    expect(own).toContain("log.warn('username_local_check_unreadable', { pid: candidatePid });");
  });

  it('занятое имя — единственная преграда перед записью своего', () => {
    expect(codeOnly(read('identity', 'ownProfile.ts'))).toContain(
      'if (!normalized || await isUsernameTakenByAnotherProfile(normalized)) return false;',
    );
  });
});

describe('ЗАКРЕПКА', () => {
  it('перенос читает общую запись формой, которая различает нечитаемость', () => {
    const own = codeOnly(read('identity', 'ownProfile.ts'));
    expect(own).toContain('const legacy = await kvGetSecretCell(key);');
    expect(own).toContain("if (legacy.state === 'unreadable') return null;");
    expect(own).not.toContain('kvGetSecret(key)');
  });
});
