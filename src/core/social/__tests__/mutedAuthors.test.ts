/**
 * Заглушённые авторы ленты (v4.32.293).
 *
 * Список был один на устройство и открытым текстом: заглушить кого-то во
 * втором профиле значило заглушить его и в первом, а сам перечень читался в
 * базе как есть. Здесь проверяется разделение по профилям, шифрование, перенос
 * старой общей записи и границы разбора — читателей у списка два, правило
 * теперь одно.
 */
let mockWriteFails = false;

jest.mock('../../storage/local', () => {
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

let mockProfiles: Array<{ id: number; did: string }> = [];
let mockActiveId: number | null = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => mockProfiles.find((p) => p.id === mockActiveId) ?? null,
    getAllProfiles: () => mockProfiles,
    getProfileIds: () => mockProfiles.map((p: { id: number }) => p.id),
  },
}));

import {
  MUTED_AUTHORS_KEY,
  getMutedAuthors,
  isAuthorMuted,
  resetMutedAuthorsCache,
  toggleMutedAuthor,
} from '../mutedAuthors';

const mockLocal = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  kvGet: jest.Mock;
  kvSet: jest.Mock;
};

const DID_A = 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DID_B = 'did:key:zBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const NOISY = 'did:key:zNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN';
const OTHER = 'did:key:zOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO';

const key1 = `p1:${MUTED_AUTHORS_KEY}`;
const key2 = `p2:${MUTED_AUTHORS_KEY}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteFails = false;
  resetMutedAuthorsCache();
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockProfiles = [{ id: 1, did: DID_A }, { id: 2, did: DID_B }];
  mockActiveId = 1;
});

describe('заглушённые принадлежат профилю', () => {
  it('пишутся шифртекстом под ключ профиля', async () => {
    await toggleMutedAuthor(NOISY);
    expect(mockLocal.__kv[key1]).toBeDefined();
    expect(mockLocal.__kv[key1]).not.toContain(NOISY);
    expect(mockLocal.__kv[MUTED_AUTHORS_KEY]).toBeUndefined();
    expect(mockLocal.kvSet).not.toHaveBeenCalled();
  });

  it('второй профиль не наследует заглушения первого', async () => {
    await toggleMutedAuthor(NOISY);
    mockActiveId = 2;
    resetMutedAuthorsCache();
    expect(await isAuthorMuted(NOISY)).toBe(false);
  });

  it('повторное переключение снимает', async () => {
    await toggleMutedAuthor(NOISY);
    const after = await toggleMutedAuthor(NOISY);
    expect(after.has(NOISY)).toBe(false);
    resetMutedAuthorsCache();
    expect(await isAuthorMuted(NOISY)).toBe(false);
  });

  it('без активного профиля не пишет ничего', async () => {
    mockActiveId = null;
    const set = await toggleMutedAuthor(NOISY);
    expect(set.size).toBe(0);
    expect(Object.keys(mockLocal.__kv)).toEqual([]);
  });
});

describe('общая запись из версий до v4.32.293', () => {
  it('копируется каждому профилю и исчезает', async () => {
    mockLocal.__kv[MUTED_AUTHORS_KEY] = JSON.stringify([NOISY]);
    expect(await isAuthorMuted(NOISY)).toBe(true);
    expect(mockLocal.__kv[MUTED_AUTHORS_KEY]).toBeUndefined();
    expect(mockLocal.__kv[key1]).toBeDefined();
    // Второму профилю список действовал так же — забрать его одному значило бы
    // молча вернуть заглушённых в чужую ленту.
    expect(mockLocal.__kv[key2]).toBeDefined();
    mockActiveId = 2;
    resetMutedAuthorsCache();
    expect(await isAuthorMuted(NOISY)).toBe(true);
  });

  it('не трогается, пока профили неизвестны', async () => {
    mockProfiles = [];
    mockActiveId = null;
    mockLocal.__kv[MUTED_AUTHORS_KEY] = JSON.stringify([NOISY]);
    expect(await isAuthorMuted(NOISY)).toBe(true);
    expect(mockLocal.__kv[MUTED_AUTHORS_KEY]).toBeDefined();
  });

  it('остаётся на месте, если копия не легла', async () => {
    mockLocal.__kv[MUTED_AUTHORS_KEY] = JSON.stringify([NOISY]);
    mockWriteFails = true;
    expect(await isAuthorMuted(NOISY)).toBe(true);
    expect(mockLocal.__kv[MUTED_AUTHORS_KEY]).toBeDefined();
  });

  it('не затирает уже перенесённое', async () => {
    await toggleMutedAuthor(NOISY);
    resetMutedAuthorsCache();
    mockLocal.__kv[MUTED_AUTHORS_KEY] = JSON.stringify([OTHER]);
    const set = await getMutedAuthors();
    expect(set.has(NOISY)).toBe(true);
    expect(set.has(OTHER)).toBe(false);
  });
});

describe('разбор записи', () => {
  it('строка не превращается в набор букв', async () => {
    // `new Set(JSON.parse('"abc"'))` давал {'a','b','c'} — экран так и делал.
    mockLocal.__kv[key1] = '"abc"';
    expect((await getMutedAuthors()).size).toBe(0);
  });

  it('объект и мусор дают пустой список', async () => {
    mockLocal.__kv[key1] = '{"did":1}';
    expect((await getMutedAuthors()).size).toBe(0);
    resetMutedAuthorsCache();
    mockLocal.__kv[key1] = 'не json';
    expect((await getMutedAuthors()).size).toBe(0);
  });

  it('нестроковые и слишком длинные элементы отбрасываются', async () => {
    mockLocal.__kv[key1] = JSON.stringify([NOISY, 42, null, '', 'x'.repeat(257), { a: 1 }]);
    expect(await getMutedAuthors()).toEqual(new Set([NOISY]));
  });
});

describe('кэш', () => {
  it('повторная проверка не ходит в базу', async () => {
    await toggleMutedAuthor(NOISY);
    mockLocal.kvGet.mockClear();
    expect(await isAuthorMuted(NOISY)).toBe(true);
    expect(await isAuthorMuted(OTHER)).toBe(false);
    expect(mockLocal.kvGet).not.toHaveBeenCalled();
  });

  it('смена профиля кэш не переживает', async () => {
    await toggleMutedAuthor(NOISY);
    mockActiveId = 2;
    expect(await isAuthorMuted(NOISY)).toBe(false);
  });

  it('не расходится с базой, если запись не удалась', async () => {
    await getMutedAuthors();
    mockWriteFails = true;
    const set = await toggleMutedAuthor(NOISY);
    expect(set.has(NOISY)).toBe(false);
    expect(await isAuthorMuted(NOISY)).toBe(false);
  });
});
