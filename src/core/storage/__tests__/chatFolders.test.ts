/**
 * Папки списка чатов (v4.32.294).
 *
 * Названия папок лежали одной общей записью открытым текстом, а метки переписок
 * принадлежат профилю: второй аккаунт видел в шапке вкладки первого. Здесь
 * проверяется разделение по профилям, шифрование, перенос старой общей записи и
 * границы разбора — в том числе значение-не-строка, от которого экран списка
 * чатов падал целиком.
 */
let mockWriteFails = false;

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
      if (!v.startsWith(PREFIX)) return v; // не мигрированный открытый текст
      return Buffer.from(v.slice(PREFIX.length), 'base64').toString('utf8');
    }),
    kvSetSecret: jest.fn(async (k: string, v: string) => {
      if (mockWriteFails) return false;
      kv[k] = PREFIX + Buffer.from(v, 'utf8').toString('base64');
      return true;
    }),
  };
});

let mockProfiles: Array<{ id: number }> = [];
let mockActiveId: number | null = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => mockProfiles.find((p) => p.id === mockActiveId) ?? null,
    getAllProfiles: () => mockProfiles,
    getProfileIds: () => mockProfiles.map((p: { id: number }) => p.id),
  },
}));

import {
  FOLDER_NAMES_KEY,
  FOLDER_NAME_MAX_LEN,
  loadFolderNames,
  parseFolderNames,
  removeFolderName,
  setFolderName,
} from '../chatFolders';

const mockLocal = jest.requireMock('../local') as {
  __kv: Record<string, string>;
  kvGet: jest.Mock;
  kvSet: jest.Mock;
};

const RED = '#e74c3c';
const BLUE = '#3498db';
const key1 = `p1:${FOLDER_NAMES_KEY}`;
const key2 = `p2:${FOLDER_NAMES_KEY}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteFails = false;
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockProfiles = [{ id: 1 }, { id: 2 }];
  mockActiveId = 1;
});

describe('названия папок принадлежат профилю', () => {
  it('пишутся шифртекстом под ключ профиля', async () => {
    await setFolderName(RED, 'Врач');
    expect(mockLocal.__kv[key1]).toBeDefined();
    expect(mockLocal.__kv[key1]).not.toContain('Врач');
    expect(mockLocal.__kv[FOLDER_NAMES_KEY]).toBeUndefined();
    expect(mockLocal.kvSet).not.toHaveBeenCalled();
    expect(await loadFolderNames()).toEqual({ [RED]: 'Врач' });
  });

  it('второй профиль не наследует папки первого', async () => {
    await setFolderName(RED, 'Врач');
    mockActiveId = 2;
    expect(await loadFolderNames()).toEqual({});
  });

  it('без активного профиля не пишет ничего', async () => {
    mockActiveId = null;
    expect(await setFolderName(RED, 'Врач')).toEqual({});
    expect(Object.keys(mockLocal.__kv)).toEqual([]);
  });

  it('возвращает прежний набор, если запись не легла', async () => {
    await setFolderName(RED, 'Врач');
    mockWriteFails = true;
    // Иначе вкладка появлялась бы на экране и исчезала после перезапуска.
    expect(await setFolderName(BLUE, 'Работа')).toEqual({ [RED]: 'Врач' });
    expect(await removeFolderName(RED)).toEqual({ [RED]: 'Врач' });
  });
});

describe('общая запись из версий до v4.32.294', () => {
  it('копируется каждому профилю и исчезает', async () => {
    mockLocal.__kv[FOLDER_NAMES_KEY] = JSON.stringify({ [RED]: 'Врач' });
    expect(await loadFolderNames()).toEqual({ [RED]: 'Врач' });
    expect(mockLocal.__kv[FOLDER_NAMES_KEY]).toBeUndefined();
    expect(mockLocal.__kv[key1]).toBeDefined();
    // Вкладки действовали во всех профилях сразу: отдать их одному значило бы
    // для остальных молча стереть названия.
    expect(mockLocal.__kv[key2]).toBeDefined();
    mockActiveId = 2;
    expect(await loadFolderNames()).toEqual({ [RED]: 'Врач' });
  });

  it('не трогается, пока профили неизвестны', async () => {
    mockProfiles = [];
    mockActiveId = null;
    mockLocal.__kv[FOLDER_NAMES_KEY] = JSON.stringify({ [RED]: 'Врач' });
    expect(await loadFolderNames()).toEqual({ [RED]: 'Врач' });
    expect(mockLocal.__kv[FOLDER_NAMES_KEY]).toBeDefined();
  });

  it('остаётся на месте, если копия не легла', async () => {
    mockLocal.__kv[FOLDER_NAMES_KEY] = JSON.stringify({ [RED]: 'Врач' });
    mockWriteFails = true;
    expect(await loadFolderNames()).toEqual({ [RED]: 'Врач' });
    expect(mockLocal.__kv[FOLDER_NAMES_KEY]).toBeDefined();
  });

  it('не затирает уже перенесённое', async () => {
    await setFolderName(RED, 'Врач');
    mockLocal.__kv[FOLDER_NAMES_KEY] = JSON.stringify({ [BLUE]: 'Старое' });
    expect(await loadFolderNames()).toEqual({ [RED]: 'Врач' });
  });
});

describe('разбор записи', () => {
  it('значение-не-строка отбрасывается, а не рисуется', async () => {
    // `{name}` во вкладке роняло весь экран: «Objects are not valid as a React child».
    expect(parseFolderNames(JSON.stringify({ [RED]: { a: 1 }, [BLUE]: 42 }))).toEqual({});
  });

  it('массив, строка и мусор дают пустой набор', () => {
    expect(parseFolderNames(JSON.stringify([RED]))).toEqual({});
    expect(parseFolderNames('"строка"')).toEqual({});
    expect(parseFolderNames('не json')).toEqual({});
    expect(parseFolderNames(null)).toEqual({});
  });

  it('ключом может быть только цвет метки', () => {
    expect(parseFolderNames(JSON.stringify({ 'не цвет': 'Врач', '#zzzzzz': 'Х', [RED]: 'Врач' })))
      .toEqual({ [RED]: 'Врач' });
  });

  it('название обрезается по длине, пустое отбрасывается', () => {
    const long = 'я'.repeat(FOLDER_NAME_MAX_LEN + 20);
    const parsed = parseFolderNames(JSON.stringify({ [RED]: long, [BLUE]: '   ' }));
    expect(parsed[RED]).toHaveLength(FOLDER_NAME_MAX_LEN);
    expect(BLUE in parsed).toBe(false);
  });

  it('число папок ограничено', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`#${i.toString(16).padStart(6, '0')}`] = `Папка ${i}`;
    expect(Object.keys(parseFolderNames(JSON.stringify(many)))).toHaveLength(32);
  });
});

describe('одна дорога записи', () => {
  it('пустое название удаляет папку — как и «Удалить папку»', async () => {
    await setFolderName(RED, 'Врач');
    expect(await setFolderName(RED, '   ')).toEqual({});
    await setFolderName(RED, 'Врач');
    expect(await removeFolderName(RED)).toEqual({});
  });

  it('удаление несуществующей папки ничего не пишет', async () => {
    const before = await removeFolderName(RED);
    expect(before).toEqual({});
    expect(mockLocal.__kv[key1]).toBeUndefined();
  });

  it('пробелы по краям названия не сохраняются', async () => {
    expect(await setFolderName(RED, '  Работа  ')).toEqual({ [RED]: 'Работа' });
  });

  it('название длиннее предела обрезается при записи', async () => {
    const names = await setFolderName(RED, 'я'.repeat(FOLDER_NAME_MAX_LEN + 5));
    expect(names[RED]).toHaveLength(FOLDER_NAME_MAX_LEN);
  });

  it('цвет неправильного вида не попадает в запись', async () => {
    expect(await setFolderName('DROP TABLE', 'Врач')).toEqual({});
    expect(mockLocal.__kv[key1]).toBeUndefined();
  });

  it('переполнение не выкидывает существующие папки', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 32; i++) many[`#${i.toString(16).padStart(6, '0')}`] = `Папка ${i}`;
    mockLocal.__kv[key1] = `enc2:${Buffer.from(JSON.stringify(many), 'utf8').toString('base64')}`;
    const after = await setFolderName(RED, 'Ещё одна');
    expect(Object.keys(after)).toHaveLength(32);
    expect(RED in after).toBe(false);
    // Переименовать уже существующую переполнение не мешает.
    const renamed = await setFolderName('#000000', 'Переименована');
    expect(renamed['#000000']).toBe('Переименована');
  });
});
