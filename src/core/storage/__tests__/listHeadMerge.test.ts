/**
 * Обновление списка не стирает долистанное (v4.32.503, обобщено в v4.32.533).
 *
 * Лента листается страницами по 40, а обновление читало первую страницу и
 * клало её на место всего списка. Звали обновление отовсюду: раз в минуту по
 * таймеру, после реакции, закладки, репоста, «прочитано», заглушения автора.
 * Человек, долиставший до трёхсотого поста, в произвольный момент терял
 * двести шестьдесят из них — список схлопывался под пальцем, прокрутка
 * уезжала к началу. Ошибка тем заметнее, чем дольше человек читает.
 *
 * v4.32.533: та же форма нашлась в переписке группы, где обновление зовётся
 * на каждую запись в базе. Правило переехало в `storage` и работает с любым
 * порядком «новее — раньше»; значение достаётся переданной функцией, чтобы
 * не заводить вторую копию склейки ради другого имени поля.
 *
 * Заодно закрыт порядок выборки: `ORDER BY … DESC` без id не воспроизводим
 * на строках, поделивших миллисекунду (восстановление из копии, догон после
 * сети), и страницы теряли одни строки, показывая другие дважды.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  atCreatedAt,
  atTimestamp,
  compareListOrder,
  hasMoreAfterRefresh,
  mergeByRowId,
  mergeListHead,
} from '../listHeadMerge';

const PAGE = 40;

type Post = { id: string; timestamp: number };
type Msg = { id: string; createdAt: number };

/** Лента как её отдаёт база: новее — раньше. */
function feed(n: number, from = 1000): Post[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${from - i}`, timestamp: from - i }));
}

const ids = (list: readonly { id: string }[]) => list.map((p) => p.id);
const merge = (prev: readonly Post[], head: readonly Post[], size: number) =>
  mergeListHead(prev, head, size, atTimestamp);
const cmp = (a: Post, b: Post) => compareListOrder(a, b, atTimestamp);

describe('склейка головы и хвоста', () => {
  it('долистанный хвост переживает обновление', () => {
    const prev = feed(300);
    const head = prev.slice(0, PAGE);
    expect(merge(prev, head, PAGE)).toHaveLength(300);
    expect(ids(merge(prev, head, PAGE))).toEqual(ids(prev));
  });

  it('новая строка встаёт наверх, не выталкивая ничего из хвоста', () => {
    const prev = feed(300);
    const fresh = { id: 'p1001', timestamp: 1001 };
    const head = [fresh, ...prev.slice(0, PAGE - 1)];
    const merged = merge(prev, head, PAGE);
    expect(merged).toHaveLength(301);
    expect(merged[0]).toEqual(fresh);
    expect(ids(merged).slice(1)).toEqual(ids(prev));
  });

  it('строка, удалённая в пределах головы, исчезает', () => {
    const prev = feed(300);
    const head = [...prev.slice(0, 5), ...prev.slice(6, PAGE + 1)];
    const merged = merge(prev, head, PAGE);
    expect(ids(merged)).not.toContain(prev[5].id);
    expect(merged).toHaveLength(299);
  });

  it('весь список уместился в страницу — хвост отбрасываем, там только удалённое', () => {
    const prev = feed(300);
    const head = prev.slice(0, 12);
    expect(ids(merge(prev, head, PAGE))).toEqual(ids(head));
  });

  it('список опустел — он пуст, а не остаётся прежним', () => {
    expect(merge(feed(300), [], PAGE)).toEqual([]);
  });

  it('прежнего списка нет — отдаём голову как есть', () => {
    const head = feed(PAGE);
    expect(ids(merge([], head, PAGE))).toEqual(ids(head));
  });

  it('дублей не появляется ни при каком пересечении', () => {
    const prev = feed(300);
    for (const shift of [0, 1, 5, 39, 40, 41, 120]) {
      const head = feed(PAGE, 1000 + shift);
      const merged = merge(prev, head, PAGE);
      expect(new Set(ids(merged)).size).toBe(merged.length);
    }
  });

  it('порядок склеенного списка строго убывающий — без инверсий на стыке', () => {
    const prev = feed(300);
    const head = [{ id: 'p1001', timestamp: 1001 }, ...prev.slice(0, PAGE - 1)];
    const merged = merge(prev, head, PAGE);
    for (let i = 1; i < merged.length; i++) {
      expect(cmp(merged[i - 1], merged[i])).toBeLessThan(0);
    }
  });

  it('мусорный размер страницы не превращается в склейку наугад', () => {
    const prev = feed(300);
    const head = prev.slice(0, PAGE);
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(ids(merge(prev, head, bad))).toEqual(ids(head));
    }
  });

  it('прежний список не мутируется', () => {
    const prev = feed(300);
    const copy = ids(prev);
    merge(prev, prev.slice(0, PAGE), PAGE);
    expect(ids(prev)).toEqual(copy);
  });

  it('строка, удалённая за пределами головы, до перезахода остаётся — это известно', () => {
    // Голова про хвост ничего не говорит. Осознанная плата за то, что
    // обновление не тяжелеет от длины прочитанного.
    const prev = feed(300);
    const head = prev.slice(0, PAGE);
    expect(ids(merge(prev, head, PAGE))).toContain(prev[250].id);
  });

  it('до фикса тот же тик оставлял от трёхсот постов сорок', () => {
    const prev = feed(300);
    const head = prev.slice(0, PAGE);
    const before = [...head]; // прежнее поведение: setPosts(list)
    expect(before).toHaveLength(PAGE);
    expect(merge(prev, head, PAGE)).toHaveLength(300);
  });
});

describe('склейка не знает, чей это список', () => {
  const GRP = 60;
  const chat = (n: number, from = 5000): Msg[] =>
    Array.from({ length: n }, (_, i) => ({ id: `m${from - i}`, createdAt: from - i }));

  it('переписка группы склеивается тем же кодом', () => {
    const prev = chat(600);
    const incoming = { id: 'm5001', createdAt: 5001 };
    const head = [incoming, ...prev.slice(0, GRP - 1)];
    const merged = mergeListHead(prev, head, GRP, atCreatedAt);
    // Раньше здесь оставалось шестьдесят сообщений из шестисот.
    expect(merged).toHaveLength(601);
    expect(merged[0]).toEqual(incoming);
    expect(ids(merged).slice(1)).toEqual(ids(prev));
  });

  it('удалённое сообщение уходит, если оно в пределах головы', () => {
    const prev = chat(600);
    const head = [...prev.slice(0, 3), ...prev.slice(4, GRP + 1)];
    const merged = mergeListHead(prev, head, GRP, atCreatedAt);
    expect(ids(merged)).not.toContain(prev[3].id);
  });

  it('порядок сообщений тоже добирает id на равном времени', () => {
    const a = { id: 'aaa', createdAt: 7 };
    const b = { id: 'bbb', createdAt: 7 };
    expect(compareListOrder(a, b, atCreatedAt)).toBeGreaterThan(0);
    expect(compareListOrder(b, a, atCreatedAt)).toBeLessThan(0);
  });
});

describe('порядок списка', () => {
  it('новее — раньше', () => {
    expect(cmp({ id: 'a', timestamp: 2 }, { id: 'b', timestamp: 1 })).toBeLessThan(0);
  });

  it('одна миллисекунда на двоих — решает id, а не удача', () => {
    const a = { id: 'aaa', timestamp: 7 };
    const b = { id: 'bbb', timestamp: 7 };
    expect(cmp(a, b)).toBeGreaterThan(0);
    expect(cmp(b, a)).toBeLessThan(0);
    expect(cmp(a, a)).toBe(0);
  });

  it('порядок совпадает с сортировкой массива — тем же кодом, что и склейка', () => {
    const list = [
      { id: 'b', timestamp: 5 },
      { id: 'c', timestamp: 9 },
      { id: 'a', timestamp: 5 },
    ];
    expect(ids([...list].sort(cmp))).toEqual(['c', 'b', 'a']);
  });
});

describe('есть ли что подгружать после обновления', () => {
  it('хвост сохранён — отвечает прежнее знание', () => {
    expect(hasMoreAfterRefresh(PAGE, 300, PAGE, false)).toBe(false);
    expect(hasMoreAfterRefresh(PAGE, 300, PAGE, true)).toBe(true);
  });

  it('хвоста нет — отвечает длина головы', () => {
    expect(hasMoreAfterRefresh(PAGE, PAGE, PAGE, false)).toBe(true);
    expect(hasMoreAfterRefresh(12, 12, PAGE, true)).toBe(false);
  });
});

describe('карты медиа и счётчиков', () => {
  it('хвост не теряет картинки при обновлении головы', () => {
    const prev = { p1: ['a.jpg'], p99: ['tail.jpg'] };
    const fresh = { p1: ['a2.jpg'] };
    expect(mergeByRowId(prev, fresh, ['p1', 'p99'])).toEqual({ p1: ['a2.jpg'], p99: ['tail.jpg'] });
  });

  it('удалённая строка уносит свою запись — карта не растёт бесконечно', () => {
    expect(mergeByRowId({ p1: 1, p2: 2 }, {}, ['p1'])).toEqual({ p1: 1 });
  });

  it('свежее значение важнее старого, даже если оно пустое', () => {
    expect(mergeByRowId({ p1: 5 }, { p1: 0 }, ['p1'])).toEqual({ p1: 0 });
  });

  it('id строки с именем из прототипа не подменяет чужие значения', () => {
    const out = mergeByRowId<number>({}, {}, ['__proto__', 'constructor', 'toString']);
    expect(Object.keys(out)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('карты не мутируются', () => {
    const prev = { p1: 1 };
    mergeByRowId(prev, { p2: 2 }, ['p1', 'p2']);
    expect(prev).toEqual({ p1: 1 });
  });
});

describe('форма кода', () => {
  const SRC = path.join(__dirname, '..', '..', '..');
  const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
  const FEED = read('ui', 'screens', 'FeedScreen.tsx');
  const GROUPS = read('ui', 'screens', 'GroupsScreen.tsx');
  const STORAGE = read('core', 'storage', 'feedStorage.ts');
  const LOCAL = read('core', 'storage', 'local.ts');
  const MERGE = read('core', 'storage', 'listHeadMerge.ts');

  it('обновление ленты склеивает, а не заменяет', () => {
    expect(FEED).toContain('mergeListHead(postsRef.current, list, FEED_PAGE, atTimestamp)');
    expect(FEED).not.toContain('setPosts((prev) => (jsonEq(prev, list) ? prev : list));');
    expect(FEED).toContain('setFeedOffset(merged.length);');
    expect(FEED).toContain('hasMoreAfterRefresh(list.length, merged.length, FEED_PAGE, prevHas)');
  });

  it('обновление переписки группы склеивает, а не заменяет', () => {
    expect(GROUPS).toContain('mergeListHead(messagesRef.current, msgs, PAGE_SIZE, atCreatedAt)');
    expect(GROUPS).toContain('setMsgOffset(merged.length);');
    expect(GROUPS).toContain('hasMoreAfterRefresh(msgs.length, merged.length, PAGE_SIZE, prevHas)');
    // Прежнее поведение: свежая страница ложилась на место всего списка.
    expect(GROUPS).not.toContain('setMessages([...msgs]);');
    expect(GROUPS).not.toContain('setMsgOffset(PAGE_SIZE);');
    expect(GROUPS).not.toContain('setHasMore(msgs.length === PAGE_SIZE);');
  });

  it('текущий список берётся из ref, а не из зависимостей обновления', () => {
    // Иначе обновление пересобиралось бы на каждое изменение списка и
    // перезапускало подписанные на него эффекты — вплоть до цикла загрузок.
    expect(FEED).toContain('postsRef.current = posts;');
    const load = FEED.slice(FEED.indexOf('const loadFeed = useCallback('));
    expect(load.slice(0, load.indexOf('const loadMoreFeed'))).toContain('}, [gateway, did]);');
    expect(GROUPS).toContain('messagesRef.current = messages;');
    const grpLoad = GROUPS.slice(GROUPS.indexOf('const loadMessages = useCallback('));
    expect(grpLoad.slice(0, grpLoad.indexOf('\n  /**'))).toContain('}, [group.id, group.unreadCount, pid, myPubB64]);');
  });

  it('карты медиа и счётчиков тоже склеиваются', () => {
    expect(FEED.match(/mergeByRowId\(prev, /g)).toHaveLength(3);
  });

  it('страницы выбираются воспроизводимо', () => {
    expect(STORAGE).toContain('ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?');
    expect(STORAGE).not.toMatch(/ORDER BY timestamp DESC LIMIT \? OFFSET \?/);
    expect(LOCAL).toContain('ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?');
    expect(LOCAL).not.toMatch(/ORDER BY created_at DESC LIMIT \? OFFSET \?/);
  });

  it('правило порядка живёт в одном экземпляре и без зависимостей', () => {
    expect(MERGE).not.toMatch(/^import /m);
    expect(MERGE).toContain('timestamp DESC, id DESC');
    expect(MERGE).toContain('created_at DESC, id DESC');
    // Прежнее имя не должно остаться ни у кого — иначе рядом заведётся копия.
    for (const src of [FEED, GROUPS]) {
      expect(src).not.toContain('feedHeadMerge');
      expect(src).not.toContain('mergeFeedHead');
    }
  });
});
