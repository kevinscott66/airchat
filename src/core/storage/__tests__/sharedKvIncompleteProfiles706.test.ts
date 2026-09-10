/**
 * Общие для устройства записи (заглушённые авторы ленты, названия папок чатов)
 * при первом чтении разносятся по профилям, и общая после этого удаляется.
 * Удаление необратимо: копия у профиля — единственное место, где настройка
 * дальше живёт.
 *
 * v4.32.706: разносил их список `profileManager.getProfileIds()`, а он умеет
 * молча укорачиваться. Строку снимка не приняли — профиль пропал из списка;
 * снимок не разобрался целиком — заводится один профиль по умолчанию. Копия
 * доставалась тем, кого видно, признак «легло всем» оставался поднятым, и
 * общая запись стиралась. Настройки спрятанных профилей исчезали навсегда.
 *
 * Здесь проверяется, что при неполном списке общая запись остаётся на месте,
 * а прежние исходы (перенос всем и удаление, отказ базы, отказ записи) целы.
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

// Список профилей И слово о его полноте: до правки читалось только первое,
// поэтому в моке живут обе формы — иначе на дореформенном дереве набор упал бы
// на отсутствующем методе, а не на самой дыре.
const mockProfiles: { ids: number[]; complete: boolean } = { ids: [1, 2], complete: true };
let mockActiveId: number | null = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => (mockActiveId == null ? null : { id: mockActiveId }),
    getProfileIds: () => [...mockProfiles.ids],
    getProfileIdsComplete: () => ({ ids: [...mockProfiles.ids], complete: mockProfiles.complete }),
  },
}));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import fs from 'fs';
import path from 'path';

import {
  readProfileSharedSecret,
  tryReadProfileSharedSecret,
  writeProfileSharedSecret,
} from '../profileSharedKv';

const mockLocal = jest.requireMock('../local') as { __kv: Record<string, string> };

const KEY = 'feed_muted_authors_v1';
const scoped = (pid: number) => `p${pid}:${KEY}`;

const src = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', rel), 'utf8');
const sharedSrc = src('src/core/storage/profileSharedKv.ts');
const managerSrc = src('src/core/identity/profileManager.ts');

/** Тело copySharedToProfiles: ratchet-запреты не должны ловиться комментарием. */
function copyBody(): string {
  const from = sharedSrc.indexOf('async function copySharedToProfiles(');
  expect(from).toBeGreaterThan(0);
  const to = sharedSrc.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return sharedSrc.slice(from, to);
}

function putShared(value: string): void {
  mockLocal.__kv[KEY] = value;
}
function decode(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  return raw.startsWith('enc2:')
    ? Buffer.from(raw.slice('enc2:'.length), 'base64').toString('utf8')
    : raw;
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockDbFails = false;
  mockWriteFails = false;
  mockProfiles.ids = [1, 2];
  mockProfiles.complete = true;
  mockActiveId = 1;
});

describe('неполный список профилей не даёт стереть общую запись', () => {
  it('общая запись остаётся на месте, когда снимок профилей неполон', async () => {
    putShared('["did:key:zA"]');
    mockProfiles.complete = false;
    await tryReadProfileSharedSecret(KEY);
    expect(mockLocal.__kv[KEY]).toBe('["did:key:zA"]');
  });

  it('видимые профили копию всё же получают', async () => {
    putShared('["did:key:zA"]');
    mockProfiles.complete = false;
    await tryReadProfileSharedSecret(KEY);
    expect(decode(mockLocal.__kv[scoped(1)])).toBe('["did:key:zA"]');
    expect(decode(mockLocal.__kv[scoped(2)])).toBe('["did:key:zA"]');
  });

  it('спрятанный профиль не теряет настройку: общая доживает до его появления', async () => {
    putShared('["did:key:zA"]');
    mockProfiles.ids = [1];
    mockProfiles.complete = false;
    await tryReadProfileSharedSecret(KEY);
    expect(mockLocal.__kv[KEY]).toBeDefined();

    // Снимок прочитался — профиль 3 вернулся и забирает свою копию.
    mockProfiles.ids = [1, 3];
    mockProfiles.complete = true;
    mockActiveId = 3;
    await tryReadProfileSharedSecret(KEY);
    expect(decode(mockLocal.__kv[scoped(3)])).toBe('["did:key:zA"]');
    expect(mockLocal.__kv[KEY]).toBeUndefined();
  });

  it('значение при неполном списке всё равно читается', async () => {
    putShared('["did:key:zA"]');
    mockProfiles.complete = false;
    expect(await tryReadProfileSharedSecret(KEY)).toEqual({ value: '["did:key:zA"]' });
    expect(await readProfileSharedSecret(KEY)).toBe('["did:key:zA"]');
  });

  it('один профиль по умолчанию вместо четырёх — тоже неполный список', async () => {
    putShared('["did:key:zA"]');
    mockProfiles.ids = [1];
    mockProfiles.complete = false;
    await tryReadProfileSharedSecret(KEY);
    expect(mockLocal.__kv[KEY]).toBe('["did:key:zA"]');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('полный список: копии всем и общая убрана', async () => {
    putShared('["did:key:zA"]');
    await tryReadProfileSharedSecret(KEY);
    expect(decode(mockLocal.__kv[scoped(1)])).toBe('["did:key:zA"]');
    expect(decode(mockLocal.__kv[scoped(2)])).toBe('["did:key:zA"]');
    expect(mockLocal.__kv[KEY]).toBeUndefined();
  });

  it('своя запись главнее общей и общей не затирается', async () => {
    mockLocal.__kv[scoped(1)] = `enc2:${Buffer.from('["did:key:zOWN"]', 'utf8').toString('base64')}`;
    putShared('["did:key:zA"]');
    expect(await tryReadProfileSharedSecret(KEY)).toEqual({ value: '["did:key:zOWN"]' });
    expect(decode(mockLocal.__kv[scoped(1)])).toBe('["did:key:zOWN"]');
  });

  it('неудачная запись копии сохраняет общую (v4.32.699)', async () => {
    putShared('["did:key:zA"]');
    mockWriteFails = true;
    await tryReadProfileSharedSecret(KEY);
    expect(mockLocal.__kv[KEY]).toBe('["did:key:zA"]');
  });

  it('отказ базы: не читаем и ничего не трогаем', async () => {
    putShared('["did:key:zA"]');
    mockDbFails = true;
    expect(await tryReadProfileSharedSecret(KEY)).toBeNull();
    expect(mockLocal.__kv[KEY]).toBe('["did:key:zA"]');
  });

  it('профилей нет вовсе — общая на месте', async () => {
    putShared('["did:key:zA"]');
    mockProfiles.ids = [];
    mockActiveId = null;
    await tryReadProfileSharedSecret(KEY);
    expect(mockLocal.__kv[KEY]).toBe('["did:key:zA"]');
  });

  it('общей записи нет — читается своя', async () => {
    mockLocal.__kv[scoped(1)] = `enc2:${Buffer.from('["did:key:zB"]', 'utf8').toString('base64')}`;
    expect(await tryReadProfileSharedSecret(KEY)).toEqual({ value: '["did:key:zB"]' });
  });

  it('нет ни своей, ни общей — пусто, а не отказ', async () => {
    expect(await tryReadProfileSharedSecret(KEY)).toEqual({ value: null });
  });

  it('запись идёт в namespace активного профиля', async () => {
    expect(await writeProfileSharedSecret(KEY, '["did:key:zC"]')).toBe(true);
    expect(decode(mockLocal.__kv[scoped(1)])).toBe('["did:key:zC"]');
    expect(mockLocal.__kv[KEY]).toBeUndefined();
  });

  it('без активного профиля не пишем', async () => {
    mockActiveId = null;
    expect(await writeProfileSharedSecret(KEY, '["did:key:zC"]')).toBe(false);
  });
});

describe('форма правки закреплена', () => {
  it('список берётся со словом о полноте', () => {
    expect(copyBody()).toContain(
      'const { ids: profileIds, complete } = profileManager.getProfileIdsComplete();',
    );
  });

  it('признак «легло всем» начинается с полноты списка', () => {
    expect(copyBody()).toContain('let copiedEverywhere = complete;');
  });

  it('короткий список внутри переноса больше не спрашивают', () => {
    expect(copyBody()).not.toContain('profileManager.getProfileIds()');
    expect(copyBody()).not.toContain('let copiedEverywhere = true;');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('удаление общей записи по-прежнему есть и по-прежнему необратимо', () => {
    expect(copyBody()).toContain('if (copiedEverywhere) await kvDelete(key);');
  });

  it('снимок профилей всё ещё умеет укорачиваться', () => {
    expect(managerSrc).toContain('this.snapshotIncomplete = true;');
    expect(managerSrc).toContain('return { ids: this.getProfileIds(), complete: !this.snapshotIncomplete };');
  });

  it('оба потребителя общих записей ходят через это чтение', () => {
    expect(src('src/core/social/mutedAuthors.ts')).toContain(
      'await tryReadProfileSharedSecret(MUTED_AUTHORS_KEY)',
    );
    expect(src('src/core/storage/chatFolders.ts')).toContain(
      'await tryReadProfileSharedSecret(FOLDER_NAMES_KEY)',
    );
  });

  it('исходники не выродились', () => {
    expect(sharedSrc.length).toBeGreaterThan(2000);
    expect(copyBody().length).toBeGreaterThan(400);
  });
});
