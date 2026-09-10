/**
 * Общие для устройства записи (заглушённые авторы ленты, названия папок чатов)
 * читаются целиком и целиком же кладутся обратно. v4.32.699: чтение отвечало
 * одинаковым «пусто» и когда записи нет, и когда база не ответила, — а раз
 * запись идёт набором, «пусто» на входе означало «стереть всё, что там лежало».
 *
 * Одна заминка базы снимала заглушение со всех авторов разом или стирала
 * названия всех папок, кроме только что названной. Здесь проверяется, что при
 * нечитаемом наборе не пишется ничего.
 */
let mockDbFails = false;
let mockWriteFails = false;

jest.mock('../local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  const decode = (v: string) =>
    v.startsWith(PREFIX) ? Buffer.from(v.slice(PREFIX.length), 'base64').toString('utf8') : v;
  return {
    __kv: kv,
    // Так же двузначен, как настоящий kvGet: сбой базы и отсутствие строки — один null.
    kvGet: jest.fn(async (k: string) => (mockDbFails ? null : (kv[k] ?? null))),
    kvTryGet: jest.fn(async (k: string) => (mockDbFails ? null : { value: kv[k] ?? null })),
    kvSet: jest.fn(async (k: string, v: string) => {
      kv[k] = v;
    }),
    kvDelete: jest.fn(async (k: string) => {
      delete kv[k];
    }),
    kvGetSecret: jest.fn(async (k: string) => {
      if (mockDbFails) return null;
      const v = kv[k];
      return v == null ? null : decode(v);
    }),
    kvGetSecretCell: jest.fn(async (k: string) => {
      if (mockDbFails) return { state: 'unreadable' };
      const v = kv[k];
      return v == null ? { state: 'absent' } : { state: 'plain', text: decode(v) };
    }),
    kvSetSecret: jest.fn(async (k: string, v: string) => {
      if (mockWriteFails || mockDbFails) return false;
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

import fs from 'fs';
import path from 'path';

import {
  MUTED_AUTHORS_KEY,
  getMutedAuthors,
  isAuthorMuted,
  resetMutedAuthorsCache,
  toggleMutedAuthor,
} from '../../social/mutedAuthors';
import { FOLDER_NAMES_KEY, loadFolderNames, setFolderName } from '../chatFolders';
import { tryReadProfileSharedSecret } from '../profileSharedKv';

const mockLocal = jest.requireMock('../local') as { __kv: Record<string, string> };

const DID_A = 'did:key:zA';
const DID_B = 'did:key:zB';
const DID_C = 'did:key:zC';
const RED = '#e74c3c';
const BLUE = '#3498db';

const mutedKey = (pid: number) => `p${pid}:${MUTED_AUTHORS_KEY}`;
const foldersKey = (pid: number) => `p${pid}:${FOLDER_NAMES_KEY}`;

function put(key: string, value: unknown): void {
  mockLocal.__kv[key] = `enc2:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;
}
function read(key: string): unknown {
  const raw = mockLocal.__kv[key];
  if (raw == null) return undefined;
  return JSON.parse(Buffer.from(raw.slice('enc2:'.length), 'base64').toString('utf8'));
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockDbFails = false;
  mockWriteFails = false;
  mockProfiles = [{ id: 1 }, { id: 2 }];
  mockActiveId = 1;
  resetMutedAuthorsCache();
});

const SRC = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');

describe('повод для правки жив', () => {
  it('kvGet в local.ts по-прежнему сводит сбой базы и отсутствие строки к одному null', () => {
    const local = SRC('../local.ts');
    expect(local).toContain(
      'export async function kvGet(key: string): Promise<string | null> {\n' +
        '  return (await kvTryGet(key))?.value ?? null;\n' +
        '}',
    );
    expect(local).toContain(
      'export async function kvTryGet(key: string): Promise<{ value: string | null } | null> {',
    );
  });

  it('оба вызывающих по-прежнему кладут набор целиком, а не по одному элементу', () => {
    expect(SRC('../../social/mutedAuthors.ts')).toContain(
      'writeProfileSharedSecret(MUTED_AUTHORS_KEY, JSON.stringify([...next]))',
    );
    expect(SRC('../chatFolders.ts')).toContain(
      'writeProfileSharedSecret(FOLDER_NAMES_KEY, JSON.stringify(next))',
    );
  });
});

describe('проверка не пустая: база отвечает — всё как было', () => {
  it('заглушение переключается и список читается', async () => {
    put(mutedKey(1), [DID_A, DID_B]);
    const next = await toggleMutedAuthor(DID_C);
    expect(next).not.toBeNull();
    expect([...(next ?? [])].sort()).toEqual([DID_A, DID_B, DID_C].sort());
    expect(read(mutedKey(1))).toEqual(expect.arrayContaining([DID_A, DID_B, DID_C]));
  });

  it('папка переименовывается, соседние остаются', async () => {
    put(foldersKey(1), { [RED]: 'Врач', [BLUE]: 'Работа' });
    const next = await setFolderName(RED, 'Клиника');
    expect(next).toEqual({ [RED]: 'Клиника', [BLUE]: 'Работа' });
    expect(read(foldersKey(1))).toEqual({ [RED]: 'Клиника', [BLUE]: 'Работа' });
  });

  it('своей записи нет — читается общая, оставшаяся от версий до разделения', async () => {
    mockLocal.__kv[MUTED_AUTHORS_KEY] = JSON.stringify([DID_A]);
    expect(await isAuthorMuted(DID_A)).toBe(true);
  });
});

describe('набор не прочитался — его не переписывают', () => {
  it('заглушение: прежний список остаётся в базе нетронутым', async () => {
    put(mutedKey(1), [DID_A, DID_B]);
    const before = read(mutedKey(1));
    mockDbFails = true;
    expect(await toggleMutedAuthor(DID_C)).toBeNull();
    mockDbFails = false;
    expect(read(mutedKey(1))).toEqual(before);
  });

  it('названия папок: прежние названия остаются в базе нетронутыми', async () => {
    put(foldersKey(1), { [RED]: 'Врач', [BLUE]: 'Работа' });
    const before = read(foldersKey(1));
    mockDbFails = true;
    expect(await setFolderName(RED, 'Клиника')).toBeNull();
    mockDbFails = false;
    expect(read(foldersKey(1))).toEqual(before);
  });

  it('пустой список из неудачного чтения не оседает в кэше на весь сеанс', async () => {
    put(mutedKey(1), [DID_A, DID_B]);
    mockDbFails = true;
    expect((await getMutedAuthors()).size).toBe(0);
    mockDbFails = false;
    // База ответила — список должен вернуться, а не остаться пустым из кэша.
    expect([...(await getMutedAuthors())].sort()).toEqual([DID_A, DID_B].sort());
  });

  it('чтение общей записи не прочиталось — своей записи это не касается', async () => {
    put(mutedKey(1), [DID_A]);
    const read1 = await tryReadProfileSharedSecret(MUTED_AUTHORS_KEY);
    expect(read1).not.toBeNull();
    expect(JSON.parse(read1?.value ?? 'null')).toEqual([DID_A]);
  });

  it('перенос общей записи не переписывает набор профиля, который не прочитался', async () => {
    // У профиля 2 свой список уже есть, но его чтение сорвалось. Общая запись
    // не должна лечь поверх, и сама общая должна остаться до следующей попытки.
    mockLocal.__kv[MUTED_AUTHORS_KEY] = JSON.stringify([DID_C]);
    put(mutedKey(2), [DID_A, DID_B]);
    const kv = mockLocal.__kv;
    const realKvTryGet = (jest.requireMock('../local') as { kvTryGet: jest.Mock }).kvTryGet;
    realKvTryGet.mockImplementation(async (k: string) =>
      k === mutedKey(2) ? null : { value: kv[k] ?? null },
    );
    await getMutedAuthors();
    realKvTryGet.mockImplementation(async (k: string) => ({ value: kv[k] ?? null }));
    expect(read(mutedKey(2))).toEqual([DID_A, DID_B]);
    expect(mockLocal.__kv[MUTED_AUTHORS_KEY]).toBe(JSON.stringify([DID_C]));
  });
});

describe('исходник: чтение общей записи объявлено двузначным', () => {
  it('profileSharedKv отдаёт трёхзначное чтение и не спрашивает kvGet', () => {
    const src = SRC('../profileSharedKv.ts');
    expect(src).toContain('export async function tryReadProfileSharedSecret(');
    expect(src).toContain('): Promise<{ value: string | null } | null> {');
    expect(src).toContain("if (cell.state === 'unreadable') return null;");
    expect(src).toContain('const existing = await kvTryGet(scoped);');
    expect(src).toContain('if (existing === null) {');
    expect(src).not.toContain('await kvGet(scoped)');
    expect(src).not.toContain('await kvGet(key)');
  });

  it('оба вызывающих объявляют отказ от записи в типе', () => {
    expect(SRC('../../social/mutedAuthors.ts')).toContain(
      'export async function toggleMutedAuthor(did: string): Promise<Set<string> | null> {',
    );
    const folders = SRC('../chatFolders.ts');
    expect(folders).toContain(
      'export async function setFolderName(color: string, rawName: string): Promise<FolderNames | null> {',
    );
    expect(folders).toContain('const current = await readFolderNames();');
    expect(folders).not.toContain('const current = await loadFolderNames();');
  });

  it('экраны различают отказ, а не показывают пустоту', () => {
    const feed = fs.readFileSync(
      path.join(__dirname, '../../../ui/screens/FeedScreen.tsx'),
      'utf8',
    );
    expect(feed).toContain('const next = await toggleMutedAuthor(authorDid);');
    expect(feed).toContain("showError('Не удалось прочитать список заглушённых');");
    expect(feed).not.toContain('setMutedAuthors(await toggleMutedAuthor(authorDid));');
    const list = fs.readFileSync(
      path.join(__dirname, '../../../ui/screens/ChatListScreen.tsx'),
      'utf8',
    );
    expect(list).toContain("showError('Не удалось прочитать названия папок');");
  });
});

describe('загрузка для показа отказ переживает', () => {
  it('названия папок при нечитаемой базе — пустая шапка, а не падение', async () => {
    put(foldersKey(1), { [RED]: 'Врач' });
    mockDbFails = true;
    expect(await loadFolderNames()).toEqual({});
  });
});
