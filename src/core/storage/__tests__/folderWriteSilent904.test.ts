/**
 * Дефект: неудачная запись названия папки была неотличима от удачной.
 *
 * v4.32.904. `setFolderName` отвечал набором названий и при удаче, и при
 * отказе — при отказе тем, что лежало в базе до попытки. Экран отличал от него
 * только `null` («названия не прочитались»), а проверка была написана как
 * `if (!next)`: объект её проходил. Значит запись, не легшая в базу,
 * переполнение сверх предела в 32 папки и вовсе отсутствующий активный
 * профиль закрывали окно переименования молча.
 *
 * Цена: человек назвал папку, окно закрылось, вкладка не появилась — и никто
 * не сказал почему. Он повторяет то же самое, получает то же молчание и
 * решает, что промахивается мимо кнопки.
 *
 * Правка: у записи появился исход с причиной, и экран каждую причину называет
 * вслух.
 */
let mockWriteFails = false;
let mockReadFails = false;

jest.mock('../local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  return {
    __kv: kv,
    kvGet: jest.fn(async (k: string) => kv[k] ?? null),
    kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecret: jest.fn(async (k: string) => {
      const v = kv[k];
      if (v == null) return null;
      return v.startsWith(PREFIX) ? Buffer.from(v.slice(PREFIX.length), 'base64').toString('utf8') : v;
    }),
    kvSetSecret: jest.fn(async (k: string, v: string) => {
      if (mockWriteFails) return false;
      kv[k] = PREFIX + Buffer.from(v, 'utf8').toString('base64');
      return true;
    }),
    kvTryGet: jest.fn(async (k: string) => (mockReadFails ? null : { value: kv[k] ?? null })),
    kvGetSecretCell: jest.fn(async (k: string) => {
      if (mockReadFails) return { state: 'unreadable' };
      const v = kv[k];
      if (v == null) return { state: 'absent' };
      return {
        state: 'plain',
        text: v.startsWith(PREFIX) ? Buffer.from(v.slice(PREFIX.length), 'base64').toString('utf8') : v,
      };
    }),
  };
});

let mockActiveId: number | null = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => (mockActiveId === null ? null : { id: mockActiveId }),
    getAllProfiles: () => [{ id: 1 }, { id: 2 }],
    getProfileIds: () => [1, 2],
    getProfileIdsComplete: () => ({ ids: [1, 2], complete: true }),
  },
}));

jest.mock('../../logger', () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { FOLDER_NAMES_KEY, loadFolderNames, removeFolderName, setFolderName } from '../chatFolders';

const mockLocal = jest.requireMock('../local') as { __kv: Record<string, string> };

const RED = '#e74c3c';
const BLUE = '#3498db';
const key1 = `p1:${FOLDER_NAMES_KEY}`;

const screen = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatListScreen.tsx'), 'utf8');

/** Что в базе на самом деле — мимо всякого возвращаемого значения. */
function stored(): Record<string, string> {
  const v = mockLocal.__kv[key1];
  if (v == null) return {};
  return JSON.parse(Buffer.from(v.slice('enc2:'.length), 'base64').toString('utf8')) as Record<string, string>;
}

function put(names: Record<string, string>): void {
  mockLocal.__kv[key1] = `enc2:${Buffer.from(JSON.stringify(names), 'utf8').toString('base64')}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteFails = false;
  mockReadFails = false;
  mockActiveId = 1;
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
});

describe('отказ записи называет себя отказом', () => {
  it('не легшая запись — это ok: false, а не прежний набор', async () => {
    put({ [RED]: 'Врач' });
    mockWriteFails = true;
    const res = await setFolderName(BLUE, 'Работа');
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('write_failed');
  });

  it('удаление, которое не легло, тоже отказ', async () => {
    put({ [RED]: 'Врач' });
    mockWriteFails = true;
    const res = await removeFolderName(RED);
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('write_failed');
  });

  it('упёрлись в предел — говорим об этом отдельно', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 32; i++) many[`#${i.toString(16).padStart(6, '0')}`] = `Папка ${i}`;
    put(many);
    const res = await setFolderName(RED, 'Ещё одна');
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('limit');
  });

  it('нечитаемый набор отличается от неудавшейся записи', async () => {
    mockReadFails = true;
    const res = await setFolderName(RED, 'Врач');
    expect(res).toEqual({ ok: false, why: 'unreadable', names: null });
  });

  it('удача так и говорит и несёт новый набор', async () => {
    put({ [RED]: 'Врач' });
    expect(await setFolderName(BLUE, 'Работа')).toEqual({
      ok: true,
      names: { [RED]: 'Врач', [BLUE]: 'Работа' },
    });
  });

  it('экран смотрит на исход, а не на «пришёл ли объект»', () => {
    expect(screen).toContain('if (!res.ok) {');
    expect(screen).not.toContain('const next = name.trim() ? await setFolderName(color, name) : await removeFolderName(color);');
  });

  it('у каждой причины свои слова, и про удаление — свои', () => {
    expect(screen).toContain("res.why === 'unreadable' ? 'Не удалось прочитать названия папок'");
    expect(screen).toContain("res.why === 'limit' ? `Папок уже ${MAX_FOLDERS} — это предел`");
    expect(screen).toContain("removing ? 'Не удалось удалить папку'");
    expect(screen).toContain("'Не удалось сохранить название папки'");
  });
});

describe('до правки было верно и осталось верно', () => {
  it('неудавшаяся запись не трогает базу', async () => {
    put({ [RED]: 'Врач' });
    mockWriteFails = true;
    await setFolderName(BLUE, 'Работа');
    await removeFolderName(RED);
    expect(stored()).toEqual({ [RED]: 'Врач' });
  });

  it('удавшаяся запись кладёт название в базу', async () => {
    await setFolderName(RED, 'Врач');
    expect(stored()).toEqual({ [RED]: 'Врач' });
  });

  it('нечитаемый набор оставляет базу нетронутой', async () => {
    put({ [RED]: 'Врач' });
    mockReadFails = true;
    await setFolderName(BLUE, 'Работа');
    mockReadFails = false;
    expect(stored()).toEqual({ [RED]: 'Врач' });
  });

  it('для показа отказ чтения — пустая шапка, а не падение', async () => {
    put({ [RED]: 'Врач' });
    mockReadFails = true;
    await expect(loadFolderNames()).resolves.toEqual({});
  });

  it('экран по-прежнему отпускает вкладку удалённой папки и закрывает окно', () => {
    expect(screen).toContain("setFilterTab((t) => (t === color ? 'all' : t));");
    expect(screen).toContain('setRenameFolderColor(null);');
  });
});
