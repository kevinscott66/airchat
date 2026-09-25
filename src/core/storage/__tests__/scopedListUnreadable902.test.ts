/**
 * Скан ключей по префиксу: «ничего нет» и «не прочиталось» — разные ответы.
 *
 * Дефект. `scopedKvListKeysByPrefix` строился на `kvListKeysByPrefix`, а тот
 * отказ базы отдаёт пустым списком. Для отметок «опубликовано по ссылке»
 * (`listLinkPublishedPostIds`) пустой список значит «наружу ничего не
 * выложено»: у записи пропадает «Отозвать ссылку», а незашифрованная копия
 * остаётся лежать на сервере и открывается по ссылке всем, у кого она есть.
 *
 * Цена. Отозвать её до перезапуска приложения нечем, и человеку об этом никто
 * не говорит: меню выглядит так, будто запись никогда и не публиковалась.
 *
 * Правка (v4.32.902). Появилась трёхсостоянная форма
 * `scopedKvTryListKeysByPrefix` (`null` — не прочиталось), и
 * `listLinkPublishedPostIds` отдаёт `null` вместо пустого набора. Прежняя
 * двусоставная форма ведёт себя как раньше — её зовут те, кому разница не
 * важна (заглушённые чаты).
 */
let mockListFails = false;
/** Отказ ровно на общем скане (без префикса профиля) — путь первого профиля. */
let mockLegacyListFails = false;

jest.mock('../local', () => {
  const kv: Record<string, string> = {};
  return {
    __kv: kv,
    kvTryListKeysByPrefix: jest.fn(async (prefix: string) => {
      if (mockListFails) return null;
      if (mockLegacyListFails && !/^p\d+:/.test(prefix)) return null;
      return Object.keys(kv).filter((k) => k.startsWith(prefix));
    }),
    // Прежняя двусоставная форма живёт в моке нарочно: без неё дореформенный
    // profileScopedKv падал бы на отсутствующем методе, и контрольные проверки
    // ничего бы не подтвердили.
    kvListKeysByPrefix: jest.fn(async (prefix: string) => {
      if (mockListFails) return [];
      if (mockLegacyListFails && !/^p\d+:/.test(prefix)) return [];
      return Object.keys(kv).filter((k) => k.startsWith(prefix));
    }),
    kvTryGet: jest.fn(async (k: string) => ({ value: kv[k] ?? null })),
    kvSetChecked: jest.fn(async (k: string, v: string) => {
      kv[k] = v;
      return true;
    }),
    kvDelete: jest.fn(async (k: string) => {
      delete kv[k];
    }),
    kvDeleteChecked: jest.fn(async (k: string) => {
      delete kv[k];
    }),
    kvGetSecretCellScoped: jest.fn(async () => ({ state: 'absent' })),
    kvSetSecret: jest.fn(async () => true),
  };
});

let mockActiveId = 2;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  scopedKvListKeysByPrefix,
  scopedKvTryListKeysByPrefix,
} from '../profileScopedKv';
import { listLinkPublishedPostIds } from '../../social/postLinkState';
import { FEED_LINK_PUBLISHED_PREFIX } from '../kvKeys';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = (require('../local') as { __kv: Record<string, string> }).__kv;

const P = FEED_LINK_PUBLISHED_PREFIX;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mockListFails = false;
  mockLegacyListFails = false;
  mockActiveId = 2;
});

describe('скан по префиксу отличает пустоту от отказа', () => {
  it('база не ответила — трёхсостоянная форма говорит «не знаем»', async () => {
    store[`p2:${P}p1`] = '1000';
    mockListFails = true;
    expect(await scopedKvTryListKeysByPrefix(P)).toBeNull();
  });

  it('база ответила — список тот же, что и у прежней формы', async () => {
    store[`p2:${P}p1`] = '1000';
    store[`p2:${P}p2`] = '1001';
    store['p2:other'] = 'x';
    expect((await scopedKvTryListKeysByPrefix(P))?.sort()).toEqual([`${P}p1`, `${P}p2`]);
    expect((await scopedKvListKeysByPrefix(P)).sort()).toEqual([`${P}p1`, `${P}p2`]);
  });

  it('ключей нет — это пустой список, а не «не знаем»', async () => {
    expect(await scopedKvTryListKeysByPrefix(P)).toEqual([]);
  });

  it('отметки «опубликовано по ссылке» при отказе базы — null, а не пустой набор', async () => {
    store[`p2:${P}p1`] = '1000';
    mockListFails = true;
    expect(await listLinkPublishedPostIds()).toBeNull();
  });

  it('отметки читаются — набор id без служебного префикса', async () => {
    store[`p2:${P}p1`] = '1000';
    store[`p2:${P}p2`] = '1001';
    const ids = await listLinkPublishedPostIds();
    expect(ids).not.toBeNull();
    expect([...(ids ?? [])].sort()).toEqual(['p1', 'p2']);
  });

  it('скан больше не идёт через форму, которая отказ выдаёт за пустоту', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'profileScopedKv.ts'), 'utf8');
    expect(src).toContain('kvTryListKeysByPrefix');
    expect(src).not.toMatch(/await kvListKeysByPrefix\(/);
  });

  it('у первого профиля общий скан тоже считается: не дочитали — «не знаем»', async () => {
    mockActiveId = 1;
    store[`p1:${P}p1`] = '1000';
    mockLegacyListFails = true;
    expect(await scopedKvTryListKeysByPrefix(P)).toBeNull();
  });
});

describe('прежняя двусоставная форма ведёт себя как раньше', () => {
  it('отказ базы она по-прежнему выдаёт за пустой список', async () => {
    store[`p2:${P}p1`] = '1000';
    mockListFails = true;
    expect(await scopedKvListKeysByPrefix(P)).toEqual([]);
  });

  it('у первого профиля отказ общего скана не съедает свои ключи', async () => {
    // Здесь двусоставная форма обязана отдать то, что нашла: иначе
    // заглушённый чат первого профиля беззвучно начал бы звонить.
    mockActiveId = 1;
    store[`p1:${P}p1`] = '1000';
    mockLegacyListFails = true;
    expect(await scopedKvListKeysByPrefix(P)).toEqual([`${P}p1`]);
  });

  it('общие имена первого профиля по-прежнему забираются в его namespace', async () => {
    mockActiveId = 1;
    store[`${P}old`] = '900';
    expect((await scopedKvListKeysByPrefix(P)).sort()).toEqual([`${P}old`]);
    expect(store[`p1:${P}old`]).toBe('900');
    expect(store[`${P}old`]).toBeUndefined();
  });
});
