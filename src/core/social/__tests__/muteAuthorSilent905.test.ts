/**
 * Дефект: заглушение, не дошедшее до базы, было неотличимо от удавшегося.
 *
 * v4.32.905. `toggleMutedAuthor` отвечал набором заглушённых и при удаче, и
 * при отказе — при отказе тем, что лежало в базе до попытки. Лента отличала от
 * него только `null` («список не прочитался»), а проверка была написана как
 * `if (!next)`: объект её проходил. Значит не легшая запись, предел в 2000
 * заглушённых и отсутствующий активный профиль проходили молча.
 *
 * Цена: человек выбирает «Заглушить автора», лента перерисовывается — и его
 * записи в ней остаются. Никто не говорит, что ничего не записалось; выглядит
 * это как сломанная кнопка, и человек жмёт её снова и снова.
 *
 * Правка: у переключения появился исход с причиной, и лента каждую причину
 * называет вслух. Тот же разбор, что у названий папок в v4.32.904.
 */
let mockWriteFails = false;
let mockReadFails = false;

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

import { MUTED_AUTHORS_KEY, getMutedAuthors, resetMutedAuthorsCache, toggleMutedAuthor } from '../mutedAuthors';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };

const NOISY = 'did:key:zNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN';
const OTHER = 'did:key:zOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO';
const key1 = `p1:${MUTED_AUTHORS_KEY}`;

const feed = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'), 'utf8');

/** Что в базе на самом деле — мимо всякого возвращаемого значения. */
function stored(): string[] {
  const v = mockLocal.__kv[key1];
  if (v == null) return [];
  return JSON.parse(Buffer.from(v.slice('enc2:'.length), 'base64').toString('utf8')) as string[];
}

function put(dids: string[]): void {
  mockLocal.__kv[key1] = `enc2:${Buffer.from(JSON.stringify(dids), 'utf8').toString('base64')}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteFails = false;
  mockReadFails = false;
  mockActiveId = 1;
  resetMutedAuthorsCache();
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
});

describe('заглушение, не дошедшее до базы, называет себя отказом', () => {
  it('не легшая запись — это ok: false, а не прежний набор', async () => {
    put([OTHER]);
    mockWriteFails = true;
    const res = await toggleMutedAuthor(NOISY);
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('write_failed');
  });

  it('снятие заглушения, которое не легло, тоже отказ', async () => {
    put([NOISY]);
    await getMutedAuthors();
    mockWriteFails = true;
    const res = await toggleMutedAuthor(NOISY);
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('write_failed');
  });

  it('без активного профиля отказ, а не тихая пустота', async () => {
    mockActiveId = null;
    const res = await toggleMutedAuthor(NOISY);
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('no_profile');
  });

  it('упёрлись в предел — говорим об этом отдельно', async () => {
    put(Array.from({ length: 2000 }, (_, i) => `did:key:z${String(i).padStart(40, '0')}`));
    const res = await toggleMutedAuthor(NOISY);
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('limit');
  });

  it('нечитаемый список отличается от неудавшейся записи', async () => {
    mockReadFails = true;
    expect(await toggleMutedAuthor(NOISY)).toEqual({ ok: false, why: 'unreadable', muted: null });
  });

  it('удача так и говорит и несёт новый набор', async () => {
    put([OTHER]);
    const res = await toggleMutedAuthor(NOISY);
    expect(res.ok).toBe(true);
    expect([...(res.muted ?? [])].sort()).toEqual([NOISY, OTHER].sort());
  });

  it('лента смотрит на исход, а не на «пришёл ли объект»', () => {
    expect(feed).toContain('const res = await toggleMutedAuthor(authorDid);');
    expect(feed).toContain('if (!res.ok) {');
    expect(feed).not.toContain('const next = await toggleMutedAuthor(authorDid);');
  });

  it('лента показывает именно тот набор, что записан', () => {
    expect(feed).toContain('setMutedAuthors(res.muted);');
  });

  it('у каждой причины свои слова', () => {
    expect(feed).toContain("res.why === 'unreadable' ? 'Не удалось прочитать список заглушённых'");
    expect(feed).toContain("res.why === 'limit' ? `Заглушённых уже ${MAX_MUTED} — это предел`");
    expect(feed).toContain("'Не удалось изменить список заглушённых'");
  });
});

describe('до правки было верно и осталось верно', () => {
  it('неудавшаяся запись не трогает базу', async () => {
    put([OTHER]);
    mockWriteFails = true;
    await toggleMutedAuthor(NOISY);
    expect(stored()).toEqual([OTHER]);
  });

  it('кэш не расходится с базой, когда запись не легла', async () => {
    await getMutedAuthors();
    mockWriteFails = true;
    await toggleMutedAuthor(NOISY);
    expect((await getMutedAuthors()).has(NOISY)).toBe(false);
  });

  it('удавшееся заглушение доходит до базы и до кэша', async () => {
    await toggleMutedAuthor(NOISY);
    expect(stored()).toEqual([NOISY]);
    expect((await getMutedAuthors()).has(NOISY)).toBe(true);
  });

  it('нечитаемый список оставляет базу нетронутой', async () => {
    put([OTHER]);
    resetMutedAuthorsCache();
    mockReadFails = true;
    await toggleMutedAuthor(NOISY);
    mockReadFails = false;
    expect(stored()).toEqual([OTHER]);
  });

  it('лента по-прежнему не пишет в состояние прямо из вызова', () => {
    // v4.32.293: запись шла side-effect'ом внутри setState-updater'а, и React
    // вправе вызвать его дважды. Эта форма не должна вернуться.
    expect(feed).not.toContain('setMutedAuthors(await toggleMutedAuthor(authorDid));');
  });
});
