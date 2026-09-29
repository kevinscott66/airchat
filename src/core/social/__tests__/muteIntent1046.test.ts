/**
 * Просьба скрыть автора снимала скрытие (v4.32.1046).
 *
 * ДЕФЕКТ. Надпись на кнопке меню лента берёт из набора `mutedAuthors`, а тот
 * заполняется один раз при открытии экрана через `getMutedAuthors` — чтение,
 * которое на отказ базы отдаёт пустой набор. Заглушённый автор оказывался в
 * меню с надписью «Скрыть автора». Нажатие звало `toggleMutedAuthor`, тот
 * перечитывал список — уже успешно, потому что заминка прошла, — видел автора
 * в нём и УДАЛЯЛ оттуда.
 *
 * ЦЕНА. Человек просил спрятать, а получал обратное, и это ложилось на диск:
 * после перезапуска записи автора, которого он прятал, в ленте. Понять причину
 * нельзя ничем: и надпись, и результат выглядят как обычная работа кнопки.
 * Отказ чтения на открытии ленты — не редкость: экран монтируется на запуске,
 * когда связка ключей ещё не отдала ключ шифрования, а база занята первым
 * проходом синхронизации.
 *
 * ПРАВКА. Направление передаётся снаружи: `setAuthorMuted(did, want)`. Что
 * написано на кнопке, то и выполняется, каким бы ни был исход прежнего чтения.
 *
 * ГРАНИЦЫ. Показ по-прежнему считает непрочитанный список пустым — лишняя
 * публикация в ленте обратима, и это записано в самом модуле. Отказ ЗАПИСИ,
 * предел и нечитаемый список по-прежнему отвечают `ok: false`.
 */
import io from 'fs';
import path from 'path';

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

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, did: 'did:key:zSELF' }),
    getAllProfiles: () => [{ id: 1, did: 'did:key:zSELF' }],
    getProfileIds: () => [1],
    getProfileIdsComplete: () => ({ ids: [1], complete: true }),
  },
}));

import {
  MUTED_AUTHORS_KEY,
  isAuthorMuted,
  resetMutedAuthorsCache,
  setAuthorMuted,
} from '../mutedAuthors';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };

const NOISY = 'did:key:zNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN';
const OTHER = 'did:key:zOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO';
const key1 = `p1:${MUTED_AUTHORS_KEY}`;

const ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return io.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Комментарии не доказательство: пины смотрят только на код. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Положить список в базу так, как он там лежит: шифртекстом профиля. */
function put(dids: string[]): void {
  mockLocal.__kv[key1] = 'enc2:' + Buffer.from(JSON.stringify(dids), 'utf8').toString('base64');
}

/** Что в базе на самом деле. */
function stored(): string[] {
  const v = mockLocal.__kv[key1];
  if (!v) return [];
  return JSON.parse(Buffer.from(v.slice('enc2:'.length), 'base64').toString('utf8')) as string[];
}

beforeEach(() => {
  mockWriteFails = false;
  mockReadFails = false;
  resetMutedAuthorsCache();
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
});

describe('делается то, о чём попросили', () => {
  it('«скрыть» скрывает автора, который уже был скрыт', async () => {
    // Ровно случай дефекта: экран считал список пустым, потому что при
    // открытии ленты его не прочитали, и предложил «Скрыть автора».
    put([NOISY]);
    const res = await setAuthorMuted(NOISY, true);
    expect(res.ok).toBe(true);
    expect(stored()).toEqual([NOISY]);
    expect(await isAuthorMuted(NOISY)).toBe(true);
  });

  it('«скрыть» скрывает автора, который скрыт не был', async () => {
    put([OTHER]);
    const res = await setAuthorMuted(NOISY, true);
    expect(res.ok).toBe(true);
    expect(stored().sort()).toEqual([NOISY, OTHER].sort());
  });

  it('«показывать» снимает скрытие', async () => {
    put([NOISY, OTHER]);
    const res = await setAuthorMuted(NOISY, false);
    expect(res.ok).toBe(true);
    expect(stored()).toEqual([OTHER]);
  });

  it('«показывать» над нескрытым автором ничего не ломает', async () => {
    put([OTHER]);
    const res = await setAuthorMuted(NOISY, false);
    expect(res.ok).toBe(true);
    expect(stored()).toEqual([OTHER]);
  });
});

describe('ГРАНИЦА: отказы остались отказами', () => {
  it('нечитаемый список — не пишем ничего', async () => {
    put([NOISY]);
    resetMutedAuthorsCache();
    mockReadFails = true;
    expect(await setAuthorMuted(NOISY, false)).toEqual({ ok: false, why: 'unreadable', muted: null });
    mockReadFails = false;
    expect(stored()).toEqual([NOISY]);
  });

  it('не легшая запись — отказ, а не молчание', async () => {
    put([OTHER]);
    mockWriteFails = true;
    const res = await setAuthorMuted(NOISY, true);
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.why).toBe('write_failed');
    expect(stored()).toEqual([OTHER]);
  });

  it('предел считается только когда добавляем', async () => {
    const full = Array.from({ length: 2000 }, (_, i) => `did:key:z${String(i).padStart(40, '0')}`);
    put(full);
    const add = await setAuthorMuted(NOISY, true);
    expect(add.ok).toBe(false);
    expect(add.ok ? null : add.why).toBe('limit');
    // Снятие в предел не упирается: набор от него только уменьшается.
    resetMutedAuthorsCache();
    const drop = await setAuthorMuted(full[0], false);
    expect(drop.ok).toBe(true);
    expect(stored()).toHaveLength(1999);
  });
});

describe('форма исходников', () => {
  const muted = codeOnly(read('src/core/social/mutedAuthors.ts'));
  const feed = codeOnly(read('src/ui/screens/FeedScreen.tsx'));

  it('переключателя по состоянию базы больше нет', () => {
    expect(muted).toContain('export async function setAuthorMuted(did: string, want: boolean): Promise<MuteWrite> {');
    expect(muted).not.toContain('toggleMutedAuthor');
  });

  it('лента передаёт то, что написано на кнопке', () => {
    expect(feed).toContain('setMuteAuthor(p.authorDid, !isMutedP)');
    expect(feed).toContain('const res = await setAuthorMuted(authorDid, want);');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: надпись по-прежнему берётся из набора, прочитанного при открытии', () => {
    // Если это когда-нибудь перестанет быть так, направление можно будет снова
    // выводить из базы — но пока набор берётся из `getMutedAuthors`, нельзя.
    expect(feed).toContain('const isMutedP = mutedAuthors.has(p.authorDid);');
    expect(feed).toContain('void getMutedAuthors().then((set) => { if (alive) setMutedAuthors(set); });');
  });

  it('ГРАНИЦА: показ по-прежнему считает непрочитанный список пустым', () => {
    expect(muted).toContain('export async function getMutedAuthors(): Promise<Set<string>> {');
    expect(muted).toContain('return (await currentMuted()) ?? new Set();');
  });
});
