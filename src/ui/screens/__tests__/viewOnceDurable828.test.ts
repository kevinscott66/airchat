/**
 * «Один показ» переживает снятие приложения из многозадачности (v4.32.828).
 *
 * Дефект. Одноразовый снимок стирается не в момент показа, а через 0,8
 * секунды: просмотрщик берёт содержимое из уже собранных адресов, а удаление
 * строки уносит за собой файлы из кэша вложений — сотрёшь раньше, и человек
 * увидит пустой прямоугольник. Всё это время единственная память о том, что
 * снимок показан, — таймер в оперативной памяти. Не переживает он ничего:
 * смахнули приложение из многозадачности, оно упало, система выгрузила его по
 * нехватке памяти — а последнее случается ровно в ту секунду, когда на экране
 * развернулась полноэкранная картинка.
 *
 * Та же дыра шире таймера: занятая база отвечает отказом, человеку говорят
 * «снимок остался», и повторить попытку некому — `remove` зовётся один раз.
 *
 * Цена. Обещание «один показ» — единственное, что отличает одноразовый снимок
 * от обычного. Не сдержали его — и в переписке навсегда осталась фотография,
 * которую отправитель считал сгоревшей: он видит у себя «просмотрено» и
 * уверен, что её больше нет нигде.
 *
 * Правка. Перед показом номер сообщения ложится на полку на диске — «показан,
 * подлежит удалению». Удалось стереть — запись снимается; не удалось или
 * приложение до этого не дожило — следующий запуск дочитывает полку и стирает
 * строки. Полка своя у каждого аккаунта, ограничена сроком и числом записей.
 */
import {
  PENDING_KEY,
  PENDING_MAX,
  PENDING_TTL_MS,
  drainViewOncePending,
  forgetViewOnceShown,
  noteViewOnceShown,
  parsePending,
  withNoted,
  withoutNoted,
  type ViewOnceKind,
  type ViewOnceRemove,
} from '../../../core/social/viewOncePending';
import { runViewOnceTap, VIEW_ONCE_DELETE_DELAY_MS, type ViewOnceTapDeps } from '../chat-utils/viewOnceTap';

jest.mock('../../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

/** Полка на диске: ключ «профиль:имя» — как её и раскладывает scopedKv. */
const mockDisk = new Map<string, string>();
/** Что сейчас делает хранилище: 'ok', 'read-fails' или 'write-fails'. */
let mockMode: 'ok' | 'read-fails' | 'write-fails' = 'ok';

jest.mock('../../../core/storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) =>
    mockMode === 'read-fails' ? null : { value: mockDisk.get(`${pid}:${key}`) ?? null }
  ),
  scopedKvSetCheckedFor: jest.fn(async (pid: number, key: string, v: string) => {
    if (mockMode === 'write-fails') return false;
    mockDisk.set(`${pid}:${key}`, v);
    return true;
  }),
}));

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const PID = 4;
/** Что лежит на полке этого аккаунта. */
const shelf = (pid = PID): Array<{ k: string; id: string; at: number }> => {
  const raw = mockDisk.get(`${pid}:${PENDING_KEY}`);
  return raw ? (JSON.parse(raw) as Array<{ k: string; id: string; at: number }>) : [];
};

/**
 * Стенд нажатия: экран, просмотрщик и полка — настоящие, база — поддельная.
 *
 * `elapse` прокручивает те самые 0,8 секунды, `die` изображает приложение,
 * которое до них не дожило.
 */
function stand(over: Partial<ViewOnceTapDeps> = {}): {
  deps: ViewOnceTapDeps;
  order: string[];
  elapse: () => Promise<void>;
  die: () => void;
} {
  const pending: Array<() => void> = [];
  const order: string[] = [];
  let living = true;
  const deps: ViewOnceTapDeps = {
    resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 0 })),
    alive: jest.fn(() => living),
    open: jest.fn(() => { order.push('open'); }),
    later: jest.fn((fn: () => void) => { pending.push(fn); }),
    note: jest.fn(async () => {
      order.push('note');
      return noteViewOnceShown(PID, 'chat', 'MSG_1');
    }),
    forget: jest.fn(async () => {
      order.push('forget');
      await forgetViewOnceShown(PID, 'chat', 'MSG_1');
    }),
    remove: jest.fn(async () => true),
    reload: jest.fn(),
    onUnavailable: jest.fn(),
    onRemoveFailed: jest.fn(),
    ...over,
  };
  return {
    deps,
    order,
    elapse: async () => {
      const fns = pending.splice(0);
      fns.forEach((fn) => fn());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    die: () => { living = false; },
  };
}

beforeEach(() => {
  mockDisk.clear();
  mockMode = 'ok';
});

describe('показанный снимок не остаётся читаемым после перезапуска', () => {
  it('запись ложится на полку РАНЬШЕ показа', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    expect(s.order).toEqual(['note', 'open']);
    expect(shelf()).toEqual([{ k: 'chat', id: 'MSG_1', at: expect.any(Number) }]);
  });

  it('приложение не дожило до таймера — строку стирает следующий запуск', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    // Таймер не сработал вовсе: приложение сняли из многозадачности.

    const wiped: string[] = [];
    const gone = await drainViewOncePending(PID, async (_k, id) => {
      wiped.push(id);
      return 'deleted';
    });
    expect(wiped).toEqual(['MSG_1']);
    expect(gone).toBe(1);
    expect(shelf()).toEqual([]);
  });

  it('база отказала при удалении — запись осталась, и запуск повторяет', async () => {
    const s = stand({ remove: jest.fn(async () => false) });
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(s.deps.onRemoveFailed).toHaveBeenCalledTimes(1);
    expect(shelf()).toHaveLength(1);

    let tries = 0;
    await drainViewOncePending(PID, async () => {
      tries += 1;
      return tries === 1 ? 'failed' : 'deleted';
    });
    // Первый запуск не смог — запись на месте.
    expect(shelf()).toHaveLength(1);
    await drainViewOncePending(PID, async () => 'deleted');
    expect(shelf()).toEqual([]);
  });

  it('полка своя у каждого аккаунта', async () => {
    await noteViewOnceShown(PID, 'chat', 'MSG_A');
    await noteViewOnceShown(PID + 1, 'group', 'MSG_B');
    expect(shelf(PID).map((e) => e.id)).toEqual(['MSG_A']);
    expect(shelf(PID + 1).map((e) => e.id)).toEqual(['MSG_B']);
  });

  it('группа и личная переписка чистятся своими путями', async () => {
    await noteViewOnceShown(PID, 'chat', 'MSG_C');
    await noteViewOnceShown(PID, 'group', 'MSG_G');
    const seen: Array<[ViewOnceKind, string]> = [];
    await drainViewOncePending(PID, async (k, id) => {
      seen.push([k, id]);
      return 'deleted';
    });
    expect(seen).toEqual([['chat', 'MSG_C'], ['group', 'MSG_G']]);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Полка стирает строки без всякого участия человека, поэтому попасть на неё
 * должно ровно показанное. Снимок, который не показали или показали не
 * целиком, обязан остаться в переписке — «одноразовое» не значит «пропавшее
 * само по себе».
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: непоказанное на полку не попадает', () => {
  it('расшифровалось не всё — ни записи, ни удаления', async () => {
    const s = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 1 })) });
    await runViewOnceTap(s.deps);
    expect(s.deps.open).toHaveBeenCalledTimes(1);
    expect(s.deps.note).not.toHaveBeenCalled();
    expect(shelf()).toEqual([]);
  });

  it('снимок недоступен — показывать нечего, записывать тоже', async () => {
    const s = stand({ resolve: jest.fn(async () => ({ uris: [], missing: 0 })) });
    await runViewOnceTap(s.deps);
    expect(s.deps.onUnavailable).toHaveBeenCalledTimes(1);
    expect(s.deps.note).not.toHaveBeenCalled();
    expect(shelf()).toEqual([]);
  });

  it('ушли с экрана, пока писали, — запись снимается и снимок цел', async () => {
    const s = stand();
    (s.deps.note as jest.Mock).mockImplementation(async () => {
      const ok = await noteViewOnceShown(PID, 'chat', 'MSG_1');
      s.die();
      return ok;
    });
    await runViewOnceTap(s.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.deps.open).not.toHaveBeenCalled();
    expect(s.deps.forget).toHaveBeenCalledTimes(1);
    expect(shelf()).toEqual([]);
  });

  it('удалось стереть в срок — запись снимается, запуску делать нечего', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(shelf()).toEqual([]);
    const touched: string[] = [];
    await drainViewOncePending(PID, async (_k, id) => { touched.push(id); return 'deleted'; });
    expect(touched).toEqual([]);
  });

  it('строки уже нет — запись снимается, но стёртой не считается', async () => {
    await noteViewOnceShown(PID, 'chat', 'MSG_M');
    expect(await drainViewOncePending(PID, async () => 'missing')).toBe(0);
    expect(shelf()).toEqual([]);
  });

  it('исключение из удаления — это отказ, а не «стёрто»', async () => {
    await noteViewOnceShown(PID, 'chat', 'MSG_T');
    expect(await drainViewOncePending(PID, async () => { throw new Error('база занята'); })).toBe(0);
    expect(shelf()).toHaveLength(1);
  });

  it('чтение полки сорвалось — полку не переписываем и ничего не стираем', async () => {
    await noteViewOnceShown(PID, 'chat', 'MSG_R');
    mockMode = 'read-fails';
    const touched: string[] = [];
    expect(await drainViewOncePending(PID, async (_k, id) => { touched.push(id); return 'deleted'; })).toBe(0);
    expect(touched).toEqual([]);
    mockMode = 'ok';
    expect(shelf()).toHaveLength(1);
  });

  it('запись не легла — показ всё равно идёт', async () => {
    mockMode = 'write-fails';
    const s = stand();
    await runViewOnceTap(s.deps);
    expect(s.deps.open).toHaveBeenCalledTimes(1);
    expect(shelf()).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: полка не растёт без края', () => {
  it('битая полка — пустая, а не исключение', () => {
    expect(parsePending('не json', Date.now())).toEqual([]);
    expect(parsePending('{"a":1}', Date.now())).toEqual([]);
    expect(parsePending(null, Date.now())).toEqual([]);
  });

  it('мусор внутри списка отбрасывается по одной записи', () => {
    const now = Date.now();
    const raw = JSON.stringify([
      { k: 'chat', id: 'GOOD', at: now },
      { k: 'sms', id: 'BAD_KIND', at: now },
      { k: 'chat', id: '', at: now },
      { k: 'chat', id: 'NO_TIME' },
      null,
    ]);
    expect(parsePending(raw, now).map((e) => e.id)).toEqual(['GOOD']);
  });

  it('просроченное уходит: строку могли унести другим путём', () => {
    const now = Date.now();
    const raw = JSON.stringify([
      { k: 'chat', id: 'FRESH', at: now - 1000 },
      { k: 'chat', id: 'OLD', at: now - PENDING_TTL_MS - 1 },
    ]);
    expect(parsePending(raw, now).map((e) => e.id)).toEqual(['FRESH']);
  });

  it('потолок держится, и вытесняется самое старое', () => {
    let list = [] as ReturnType<typeof withNoted>;
    for (let i = 0; i < PENDING_MAX + 5; i++) {
      list = withNoted(list, { k: 'chat', id: `M${i}`, at: i });
    }
    expect(list).toHaveLength(PENDING_MAX);
    expect(list[0].id).toBe('M5');
  });

  it('повтор того же снимка не множит записи', () => {
    let list = withNoted([], { k: 'chat', id: 'M', at: 1 });
    list = withNoted(list, { k: 'chat', id: 'M', at: 2 });
    expect(list).toEqual([{ k: 'chat', id: 'M', at: 2 }]);
    // Один и тот же номер в личной переписке и в группе — разные строки.
    list = withNoted(list, { k: 'group', id: 'M', at: 3 });
    expect(list).toHaveLength(2);
    expect(withoutNoted(list, 'chat', 'M')).toEqual([{ k: 'group', id: 'M', at: 3 }]);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Всё это нужно ровно потому, что удаление отложено, а отложено оно таймером в
 * памяти. Убери задержку — и полка не понадобится; но убрать её нельзя:
 * удаление строки уносит файлы вложения, а просмотрщик в это мгновение ещё
 * открывается.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: удаление по-прежнему отложено', () => {
  it('задержка на месте и удаление идёт через неё', () => {
    expect(VIEW_ONCE_DELETE_DELAY_MS).toBe(800);
    const body = codeOnly(read('ui/screens/chat-utils/viewOnceTap.ts'));
    expect(body).toContain('deps.later(() => {');
    expect(body).toContain('deps\n      .remove()');
  });

  it('оба экрана откладывают его обычным таймером в памяти', () => {
    for (const f of ['ui/screens/ChatScreen.tsx', 'ui/screens/GroupsScreen.tsx']) {
      expect(codeOnly(read(f))).toContain('later: (fn) => { setTimeout(fn, VIEW_ONCE_DELETE_DELAY_MS); },');
    }
  });

  it('удаление строки уносит файлы вложения — потому показ и не ждёт его', () => {
    const local = codeOnly(read('core/storage/local.ts'));
    const at = local.indexOf('export async function deleteChatMessageChecked(');
    expect(at).toBeGreaterThan(0);
    expect(local.slice(at, at + 1600)).toContain('dropOrphanBlobCache(doomed)');
  });
});

describe('форма исходников: полка заведена во всех трёх местах', () => {
  it('личная переписка пишет и снимает запись', () => {
    const body = codeOnly(read('ui/screens/ChatScreen.tsx'));
    expect(body).toContain("note: () => noteViewOnceShown(activeProfileId, 'chat', row.id),");
    expect(body).toContain("forget: async () => { await forgetViewOnceShown(activeProfileId, 'chat', row.id); },");
  });

  it('группа пишет и снимает запись', () => {
    const body = codeOnly(read('ui/screens/GroupsScreen.tsx'));
    expect(body).toContain("note: () => noteViewOnceShown(pid, 'group', item.id),");
    expect(body).toContain("forget: async () => { await forgetViewOnceShown(pid, 'group', item.id); },");
  });

  it('запуск дочищает полку', () => {
    const body = codeOnly(read('App.tsx'));
    expect(body).toContain("void import('./core/social/viewOncePending')");
    expect(body).toContain('m.drainViewOncePendingNow(pid)');
  });

  it('дочистка зовёт удаление своей таблицы, а не одной на двоих', () => {
    const body = codeOnly(read('core/social/viewOncePending.ts'));
    expect(body).toContain('m.deleteChatMessageChecked(id, pid)');
    expect(body).toContain('m.deleteGroupMessageChecked(id, pid)');
  });
});

/** Чтобы тип исхода не разъехался с тем, чем отвечает хранилище. */
describe('исход удаления — те же три слова, что у хранилища', () => {
  it('три слова и ни одним больше', () => {
    const words: ViewOnceRemove[] = ['deleted', 'missing', 'failed'];
    expect(words).toHaveLength(3);
    const local = codeOnly(read('core/storage/local.ts'));
    expect(local).toContain("export type ChatDeleteWrite = 'deleted' | 'missing' | 'failed';");
    expect(local).toContain("export type GroupDeleteWrite = 'deleted' | 'missing' | 'failed';");
  });
});
