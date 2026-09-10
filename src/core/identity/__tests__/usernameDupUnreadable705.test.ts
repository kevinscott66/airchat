/**
 * Нечитаемый хендл соседа — не повод объявить имя свободным.
 *
 * v4.32.705. `isUsernameTakenByAnotherProfile` — единственная преграда перед
 * тем, чтобы два DID на одном устройстве заявили один и тот же `@handle`.
 * Спрашивала она у соседних профилей строку имени (`getOwnUsernameFor` →
 * `ownFieldGetFor` → `cellTextOrNull`), а строка не различает «имени нет» и
 * «ячейка не открылась»: оба случая приходят одним null. Сосед с нечитаемым
 * хендлом молча считался безымянным, совпадения не находилось, и запись имени
 * шла дальше.
 *
 * Цена ошибки не местная. Имя — единственный человекочитаемый адрес в
 * приложении: по нему приходят к незнакомому, на нём строится «я тот самый».
 * Два профиля с одним именем на одном телефоне получатель конверта не
 * различит ничем, а отозвать разошедшееся имя нечем.
 *
 * Тем же путём шёл и второй туман: список профилей брался у снимка
 * (`getProfileIds`), а он умеет молча укорачиваться (v4.32.704) — спрятанный
 * сосед тоже давал «не занято» без оснований.
 *
 * Теперь оба тумана отвечают «занято»: отказ человек переживёт, экран
 * предложит другое имя.
 */
type Cell = { state: 'absent' } | { state: 'plain'; text: string } | { state: 'unreadable' };

jest.mock('../../storage/local', () => {
  const cells: Record<string, Cell> = {};
  return {
    __cells: cells,
    kvGetSecretCellUpgrading: jest.fn(async (key: string) => cells[key] ?? { state: 'absent' }),
    // Прежняя строчная форма оставлена в заглушке нарочно: на дореформенном
    // дереве чтение идёт через неё, и прогон падает на самой ошибке, а не на
    // отсутствующем имени в моке.
    kvGetSecretUpgrading: jest.fn(async (key: string) => {
      const cell = cells[key] ?? { state: 'absent' };
      return cell.state === 'plain' ? cell.text : null;
    }),
    kvGetSecret: jest.fn(async () => null),
    kvSetSecret: jest.fn(async () => true),
    kvSetSecretScoped: jest.fn(async (pid: number, key: string, value: string) => {
      cells[`p${pid}:${key}`] = { state: 'plain', text: value };
      return true;
    }),
    kvDelete: jest.fn(async () => undefined),
  };
});

const mockProfiles = { ids: [1, 2], complete: true };

jest.mock('../profileManager', () => ({
  profileManager: {
    init: jest.fn(async () => undefined),
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getProfileName: () => 'Личный',
    // Оба имени: старое — чтобы дореформенное дерево шло по живому коду,
    // новое — чтобы шло исправленное.
    getProfileIds: () => [...mockProfiles.ids],
    getProfileIdsComplete: () => ({ ids: [...mockProfiles.ids], complete: mockProfiles.complete }),
  },
}));

jest.mock('../../logger', () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { isUsernameTakenByAnotherProfile, setOwnUsername } from '../ownProfile';

const mockLocal = jest.requireMock('../../storage/local') as {
  __cells: Record<string, Cell>;
  kvSetSecretScoped: jest.Mock;
};

const HANDLE_KEY = 'user_handle';
const ownSrc = readFileSync(join(__dirname, '..', 'ownProfile.ts'), 'utf8');
const regSrc = readFileSync(join(__dirname, '..', 'usernameRegistry.ts'), 'utf8');

function dupBody(): string {
  const at = ownSrc.indexOf('export async function isUsernameTakenByAnotherProfile(');
  expect(at).toBeGreaterThan(-1);
  return ownSrc.slice(at, ownSrc.indexOf('\n}\n', at));
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__cells)) delete mockLocal.__cells[k];
  mockProfiles.ids = [1, 2];
  mockProfiles.complete = true;
  jest.clearAllMocks();
});

describe('туман у соседа означает «занято», а не «свободно»', () => {
  it('нечитаемый хендл соседа не пускает записать имя', async () => {
    mockLocal.__cells[`p2:${HANDLE_KEY}`] = { state: 'unreadable' };
    expect(await isUsernameTakenByAnotherProfile('durov')).toBe(true);
  });

  it('и запись имени на этом останавливается', async () => {
    mockLocal.__cells[`p2:${HANDLE_KEY}`] = { state: 'unreadable' };
    expect(await setOwnUsername('durov')).toBe(false);
    expect(mockLocal.kvSetSecretScoped).not.toHaveBeenCalled();
  });

  it('укоротившийся список профилей — тоже «занято»', async () => {
    mockProfiles.complete = false;
    expect(await isUsernameTakenByAnotherProfile('durov')).toBe(true);
  });

  it('и записать имя при неполном списке нельзя', async () => {
    mockProfiles.complete = false;
    expect(await setOwnUsername('durov')).toBe(false);
    expect(mockLocal.kvSetSecretScoped).not.toHaveBeenCalled();
  });

  it('нечитаемое поле СВОЕГО профиля проверке не мешает', async () => {
    // Свой профиль в обходе пропускается: занять имя у самого себя нельзя.
    mockLocal.__cells[`p1:${HANDLE_KEY}`] = { state: 'unreadable' };
    expect(await isUsernameTakenByAnotherProfile('durov')).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные исходы остались прежними', () => {
  it('у соседа нет хендла — имя свободно', async () => {
    expect(await isUsernameTakenByAnotherProfile('durov')).toBe(false);
  });

  it('у соседа другое имя — тоже свободно', async () => {
    mockLocal.__cells[`p2:${HANDLE_KEY}`] = { state: 'plain', text: 'pavel' };
    expect(await isUsernameTakenByAnotherProfile('durov')).toBe(false);
  });

  it('у соседа ровно это имя — занято', async () => {
    mockLocal.__cells[`p2:${HANDLE_KEY}`] = { state: 'plain', text: 'durov' };
    expect(await isUsernameTakenByAnotherProfile('durov')).toBe(true);
  });

  it('регистр и решётка перед именем ничего не меняют', async () => {
    mockLocal.__cells[`p2:${HANDLE_KEY}`] = { state: 'plain', text: 'DUROV' };
    expect(await isUsernameTakenByAnotherProfile('@Durov')).toBe(true);
  });

  it('негодное имя проверку не проходит и соседей не тревожит', async () => {
    mockLocal.__cells[`p2:${HANDLE_KEY}`] = { state: 'unreadable' };
    expect(await isUsernameTakenByAnotherProfile('..')).toBe(false);
  });

  it('свободное имя записывается', async () => {
    expect(await setOwnUsername('durov')).toBe(true);
    expect(mockLocal.kvSetSecretScoped).toHaveBeenCalledWith(1, HANDLE_KEY, 'durov');
  });

  it('один профиль на устройстве — соседей нет вовсе', async () => {
    mockProfiles.ids = [1];
    expect(await isUsernameTakenByAnotherProfile('durov')).toBe(false);
  });
});

describe('форма правки закреплена', () => {
  it('имя соседа спрашивается формой с отдельным «не прочиталось»', () => {
    expect(ownSrc).toContain(
      'export async function getOwnUsernameTryFor(pid: number): Promise<{ username: string | null } | null> {'
    );
    expect(ownSrc).toContain('const cell = await ownFieldTryGetFor(pid, OWN_USERNAME_KEY);');
    expect(ownSrc).toContain("return cell === null ? null : { username: normalizeUsername(cell.text) };");
  });

  it('обход соседей отказывается и на тумане, и на неполном списке', () => {
    const body = dupBody();
    expect(body).toContain('const { ids, complete } = profileManager.getProfileIdsComplete();');
    expect(body).toContain('if (!complete) {');
    expect(body).toContain('const read = await getOwnUsernameTryFor(candidatePid);');
    expect(body).toContain('if (read === null) {');
    expect(body).toContain('if (read.username === normalized) return true;');
  });

  it('строчная форма из обхода соседей убрана', () => {
    const body = dupBody();
    expect(body).not.toContain('getOwnUsernameFor(');
    expect(body).not.toContain('profileManager.getProfileIds()');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строчное чтение поля по-прежнему сливает туман с пустотой', () => {
    expect(ownSrc).toContain('return (await ownFieldTryGetFor(pid, key))?.text ?? null;');
    expect(ownSrc).toContain('return normalizeUsername(await ownFieldGetFor(pid, OWN_USERNAME_KEY));');
  });

  it('запись имени по-прежнему идёт единственной точкой через эту проверку', () => {
    expect(ownSrc).toContain(
      'if (!normalized || await isUsernameTakenByAnotherProfile(normalized)) return false;'
    );
  });

  it('реестр имён по-прежнему спрашивает местную проверку первой', () => {
    expect(regSrc).toContain(
      "if (await isUsernameTakenByAnotherProfile(username)) return { ok: false, reason: 'local' };"
    );
  });

  it('исходники прочитаны', () => {
    expect(ownSrc.length).toBeGreaterThan(2000);
    expect(regSrc.length).toBeGreaterThan(2000);
  });
});
