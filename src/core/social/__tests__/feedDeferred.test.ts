/**
 * Полка отложенных событий ленты (v4.32.615).
 *
 * Проверяется само правило: событие переживает отсутствие публикации, снимается
 * по возрастанию времени, не растёт без предела и не даёт одному отправителю
 * закрыть полку для остальных. Плюс сторожа на проводку в feedService — на то,
 * что все три места, где событие раньше пропадало, теперь кладут его на полку,
 * а обе точки прихода публикации полку разгребают.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DEFERRED_MAX_BYTES,
  DEFERRED_MAX_PER_POST,
  DEFERRED_MAX_POSTS,
  DEFERRED_TTL_MS,
  addDeferred,
  deferredFromPayload,
  deferredSlot,
  isDeferrable,
  parseDeferredStore,
  pruneDeferred,
  takeDeferred,
  type DeferredEvent,
  type DeferredStore,
} from '../feedDeferred';

const T0 = 1_700_000_000_000;

function ev(over: Partial<DeferredEvent> = {}): DeferredEvent {
  return { type: 'feed_reaction', authorDid: 'did:key:zA', ts: T0, data: { emoji: '👍' }, ...over };
}

describe('feedDeferred: правило полки', () => {
  it('событие переживает отсутствие публикации и снимается по её приходу', () => {
    const s = addDeferred({}, 'p1', ev(), T0);
    const taken = takeDeferred(s, 'p1', T0);
    expect(taken.events).toHaveLength(1);
    expect(taken.events[0].data).toEqual({ emoji: '👍' });
    // Снятое не остаётся: второй приход публикации ничего не повторит.
    expect(takeDeferred(taken.store, 'p1', T0).events).toHaveLength(0);
  });

  it('снимается по возрастанию времени, а не по порядку прихода', () => {
    let s: DeferredStore = {};
    s = addDeferred(s, 'p1', ev({ ts: T0 + 300, data: { emoji: 'c' } }), T0);
    s = addDeferred(s, 'p1', ev({ ts: T0 + 100, data: { emoji: 'a' } }), T0);
    s = addDeferred(s, 'p1', ev({ ts: T0 + 200, data: { emoji: 'b' } }), T0);
    expect(takeDeferred(s, 'p1', T0).events.map((e) => (e.data as { emoji: string }).emoji)).toEqual(['a', 'b', 'c']);
  });

  it('снятие реакции вытесняет свою же постановку — призрака не будет', () => {
    let s: DeferredStore = {};
    s = addDeferred(s, 'p1', ev({ ts: T0 + 10 }), T0);
    s = addDeferred(s, 'p1', ev({ ts: T0 + 20, data: { emoji: '👍', remove: true } }), T0);
    const taken = takeDeferred(s, 'p1', T0);
    expect(taken.events).toHaveLength(1);
    expect((taken.events[0].data as { remove?: boolean }).remove).toBe(true);
  });

  it('устаревшая правка не отменяет уже отложенную свежую', () => {
    let s: DeferredStore = {};
    s = addDeferred(s, 'p1', ev({ type: 'feed_edit', ts: T0 + 50, data: { newText: 'новый' } }), T0);
    s = addDeferred(s, 'p1', ev({ type: 'feed_edit', ts: T0 + 10, data: { newText: 'старый' } }), T0);
    const taken = takeDeferred(s, 'p1', T0);
    expect(taken.events).toHaveLength(1);
    expect((taken.events[0].data as { newText: string }).newText).toBe('новый');
  });

  it('реакции разных авторов и разных эмодзи занимают разные ячейки', () => {
    let s: DeferredStore = {};
    s = addDeferred(s, 'p1', ev({ authorDid: 'did:key:zA', data: { emoji: '👍' } }), T0);
    s = addDeferred(s, 'p1', ev({ authorDid: 'did:key:zB', data: { emoji: '👍' } }), T0);
    s = addDeferred(s, 'p1', ev({ authorDid: 'did:key:zA', data: { emoji: '🔥' } }), T0);
    expect(takeDeferred(s, 'p1', T0).events).toHaveLength(3);
  });

  it('голоса за разные варианты — разные ячейки, за один и тот же — одна', () => {
    let s: DeferredStore = {};
    s = addDeferred(s, 'p1', ev({ type: 'feed_poll_vote', ts: T0 + 1, data: { optionIndex: 0 } }), T0);
    s = addDeferred(s, 'p1', ev({ type: 'feed_poll_vote', ts: T0 + 2, data: { optionIndex: 1 } }), T0);
    s = addDeferred(s, 'p1', ev({ type: 'feed_poll_vote', ts: T0 + 3, data: { optionIndex: 1, remove: true } }), T0);
    const taken = takeDeferred(s, 'p1', T0);
    expect(taken.events).toHaveLength(2);
    expect(taken.events.map((e) => deferredSlot(e))).toEqual(['v|did:key:zA|0', 'v|did:key:zA|1']);
  });

  it('просроченное не применяется — ни при снятии, ни при пополнении', () => {
    const s = addDeferred({}, 'p1', ev({ ts: T0 }), T0);
    expect(takeDeferred(s, 'p1', T0 + DEFERRED_TTL_MS + 1).events).toHaveLength(0);
    expect(Object.keys(pruneDeferred(s, T0 + DEFERRED_TTL_MS + 1))).toEqual([]);
  });

  it('одна публикация не может занять полку больше своего потолка', () => {
    let s: DeferredStore = {};
    for (let i = 0; i < DEFERRED_MAX_PER_POST + 20; i++) {
      s = addDeferred(s, 'p1', ev({ authorDid: `did:key:z${i}`, ts: T0 + i }), T0);
    }
    const taken = takeDeferred(s, 'p1', T0);
    expect(taken.events).toHaveLength(DEFERRED_MAX_PER_POST);
    // Выжили самые свежие — старое уже, скорее всего, не дождётся публикации.
    expect(taken.events[taken.events.length - 1].ts).toBe(T0 + DEFERRED_MAX_PER_POST + 19);
  });

  it('заваливший полку не закрывает её для новой публикации', () => {
    let s: DeferredStore = {};
    for (let i = 0; i < DEFERRED_MAX_POSTS + 10; i++) {
      s = addDeferred(s, `flood${i}`, ev({ ts: T0 + i }), T0 + i);
    }
    s = addDeferred(s, 'mine', ev({ ts: T0 + 9999 }), T0 + 9999);
    expect(Object.keys(s).length).toBeLessThanOrEqual(DEFERRED_MAX_POSTS);
    expect(takeDeferred(s, 'mine', T0 + 9999).events).toHaveLength(1);
  });

  it('вытесняется самая давняя полка, а не случайная', () => {
    let s: DeferredStore = {};
    for (let i = 0; i < DEFERRED_MAX_POSTS; i++) {
      s = addDeferred(s, `p${i}`, ev({ ts: T0 + i }), T0 + i);
    }
    s = addDeferred(s, 'fresh', ev({ ts: T0 + 5000 }), T0 + 5000);
    expect(s.p0).toBeUndefined();
    expect(s.p1).toBeDefined();
    expect(s.fresh).toBeDefined();
  });
});

describe('feedDeferred: разбор записи с диска', () => {
  it('переживает мусор вместо записи', () => {
    expect(parseDeferredStore(null)).toEqual({});
    expect(parseDeferredStore('')).toEqual({});
    expect(parseDeferredStore('{')).toEqual({});
    expect(parseDeferredStore('[]')).toEqual({});
    expect(parseDeferredStore('"строка"')).toEqual({});
  });

  it('выбрасывает записи неизвестного рода и с испорченными полями', () => {
    const raw = JSON.stringify({
      ok: { at: T0, events: [{ type: 'feed_reaction', authorDid: 'did:key:zA', ts: T0, data: { emoji: 'x' } }] },
      alienType: { at: T0, events: [{ type: 'feed_view', authorDid: 'did:key:zA', ts: T0, data: {} }] },
      badTs: { at: T0, events: [{ type: 'feed_edit', authorDid: 'did:key:zA', ts: 'вчера', data: {} }] },
      noData: { at: T0, events: [{ type: 'feed_edit', authorDid: 'did:key:zA', ts: T0 }] },
      badAt: { at: 'скоро', events: [{ type: 'feed_edit', authorDid: 'did:key:zA', ts: T0, data: {} }] },
    });
    expect(Object.keys(parseDeferredStore(raw))).toEqual(['ok']);
  });

  it('обрезает раздутую чужой рукой полку до потолка', () => {
    const events = Array.from({ length: 500 }, (_, i) => ({
      type: 'feed_reaction', authorDid: `did:key:z${i}`, ts: T0 + i, data: { emoji: 'x' },
    }));
    const parsed = parseDeferredStore(JSON.stringify({ p1: { at: T0, events } }));
    expect(parsed.p1.events).toHaveLength(DEFERRED_MAX_PER_POST);
  });
});

describe('feedDeferred: отбор родов', () => {
  it('откладываются ровно четыре рода событий', () => {
    expect(isDeferrable('feed_reaction')).toBe(true);
    expect(isDeferrable('feed_edit')).toBe(true);
    expect(isDeferrable('feed_poll_vote')).toBe(true);
    // v4.32.615: очередь повторов комментария наполняется только при неудаче
    // доставки — дошедший и отвергнутый как сирота конверт не повторится.
    expect(isDeferrable('feed_comment')).toBe(true);
    // Просмотров тысячи и цена каждого — единица в счётчике.
    expect(isDeferrable('feed_view')).toBe(false);
    expect(isDeferrable('feed_post')).toBe(false);
    expect(isDeferrable('feed_delete')).toBe(false);
  });

  it('конверт неоткладываемого рода не превращается в запись', () => {
    expect(deferredFromPayload({ type: 'feed_view', postId: 'p1', authorDid: 'did:key:zA', ts: T0, data: {} } as never)).toBeNull();
    const e = deferredFromPayload({ type: 'feed_edit', postId: 'p1', authorDid: 'did:key:zA', ts: T0, data: { newText: 'q' } } as never);
    expect(e).toEqual({ type: 'feed_edit', authorDid: 'did:key:zA', ts: T0, data: { newText: 'q' } });
  });
});

describe('feedDeferred: проводка в feedService', () => {
  const SRC = readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8');
  // Докблоки в этом файле цитируют сам разбираемый дефект — сторож обязан
  // смотреть на код, а не на его описание.
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('все четыре места, где событие пропадало, кладут его на полку', () => {
    expect(CODE).toMatch(/if \(!stored\) await deferFeedEvent\(payload, envelopePid\);/);
    expect(CODE).toMatch(/await deferFeedEvent\(payload, envelopePid\);\n\s*log\.info\('feed_edit_unknown_post'/);
    expect(CODE).toMatch(/await deferFeedEvent\(payload, envelopePid\);\n\s*log\.info\('feed_poll_vote_unknown_post'/);
    expect(CODE).toMatch(/await deferFeedEvent\(payload, envelopePid\);\n\s*log\.info\('feed_comment_rejected_orphan'/);
  });

  it('обе точки прихода публикации разгребают полку', () => {
    expect(CODE).toMatch(/await drainDeferred\(payload\.postId, s, envelopePid\);\n\s*log\.info\('feed_post_received'/);
    expect(CODE).toMatch(/await drainDeferred\(payload\.postId, s, envelopePid\);\n\s*log\.info\('feed_repost_received'/);
    expect((CODE.match(/await drainDeferred\(/g) ?? []).length).toBe(2);
  });

  it('полка очищается до применения, а не после', () => {
    const fn = CODE.slice(CODE.indexOf('async function drainDeferred('));
    const save = fn.indexOf('await saveDeferred(pid, taken.store)');
    const apply = fn.indexOf('await applyFeedEnvelope(');
    expect(save).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(save);
  });

  it('ключ полки привязан к профилю', () => {
    expect(CODE).toMatch(/const DEFERRED_KEY_PREFIX = 'feed_deferred_v1:p';/);
    expect((CODE.match(/\$\{DEFERRED_KEY_PREFIX\}\$\{pid\}/g) ?? []).length).toBe(2);
  });

  it('применение конверта выделено и вызывается с двух путей', () => {
    expect(CODE).toMatch(/async function applyFeedEnvelope\(/);
    expect((CODE.match(/await applyFeedEnvelope\(/g) ?? []).length).toBe(2);
  });
});

/**
 * v4.32.615: комментарий-сирота больше не пропадает.
 *
 * Он крупнее реакции на два порядка, поэтому вместе с ним у полки появился
 * потолок в байтах — иначе один контакт занял бы полтора мегабайта, которые
 * пришлось бы читать и переписывать на каждое следующее отложенное событие.
 */
describe('feedDeferred: комментарий на полке', () => {
  const comment = (id: string, text = 'привет', over: Partial<DeferredEvent> = {}): DeferredEvent => ({
    type: 'feed_comment',
    authorDid: 'did:key:zA',
    ts: T0,
    data: { kind: 'comment', commentId: id, text, authorName: 'Аноним' },
    ...over,
  });

  it('конверт комментария превращается в запись целиком', () => {
    const e = deferredFromPayload({
      type: 'feed_comment',
      postId: 'p1',
      authorDid: 'did:key:zA',
      ts: T0,
      data: { kind: 'comment', commentId: 'c1', text: 'привет', authorName: 'Аноним' },
    } as never);
    expect(e?.type).toBe('feed_comment');
    expect(e?.data).toEqual({ kind: 'comment', commentId: 'c1', text: 'привет', authorName: 'Аноним' });
  });

  it('повтор того же комментария не занимает второе место, разные — занимают', () => {
    expect(deferredSlot(comment('c1'))).toBe(deferredSlot(comment('c1', 'другой текст')));
    expect(deferredSlot(comment('c1'))).not.toBe(deferredSlot(comment('c2')));
    let store: DeferredStore = {};
    store = addDeferred(store, 'p1', comment('c1'), T0);
    store = addDeferred(store, 'p1', comment('c1', 'повтор'), T0 + 1);
    store = addDeferred(store, 'p1', comment('c2'), T0 + 2);
    expect(store.p1.events).toHaveLength(2);
  });

  it('запись комментария переживает диск', () => {
    const raw = JSON.stringify(addDeferred({}, 'p1', comment('c1'), T0));
    expect(parseDeferredStore(raw).p1.events[0].type).toBe('feed_comment');
  });

  it('полка не перерастает потолок в байтах', () => {
    const long = 'я'.repeat(2000);
    let store: DeferredStore = {};
    for (let i = 0; i < DEFERRED_MAX_POSTS; i++) {
      for (let j = 0; j < DEFERRED_MAX_PER_POST; j++) {
        store = addDeferred(store, `p${i}`, comment(`c${i}_${j}`, long, { ts: T0 + j }), T0 + i * 100 + j);
      }
    }
    expect(JSON.stringify(store).length).toBeLessThanOrEqual(DEFERRED_MAX_BYTES);
    // Последняя публикация на полке осталась: новое событие проходит всегда.
    expect(store[`p${DEFERRED_MAX_POSTS - 1}`].events.length).toBeGreaterThan(0);
  });

  it('одна публикация с огромными комментариями не отбрасывает последнее событие', () => {
    const long = 'я'.repeat(2000);
    let store: DeferredStore = {};
    for (let j = 0; j < DEFERRED_MAX_PER_POST; j++) {
      store = addDeferred(store, 'p1', comment(`c${j}`, long, { ts: T0 + j }), T0 + j);
    }
    expect(JSON.stringify(store).length).toBeLessThanOrEqual(DEFERRED_MAX_BYTES);
    expect(store.p1.events.length).toBeGreaterThanOrEqual(1);
    // Уцелевшее — самое свежее: старое уже неактуально, новое только что пришло.
    const last = store.p1.events[store.p1.events.length - 1];
    expect((last.data as { commentId: string }).commentId).toBe(`c${DEFERRED_MAX_PER_POST - 1}`);
  });

  it('потолок в байтах не мешает реакциям — их на два порядка меньше', () => {
    let store: DeferredStore = {};
    for (let i = 0; i < DEFERRED_MAX_POSTS; i++) {
      for (let j = 0; j < DEFERRED_MAX_PER_POST; j++) {
        store = addDeferred(store, `p${i}`, ev({ authorDid: `did:key:z${j}`, ts: T0 + j }), T0 + i * 100 + j);
      }
    }
    expect(Object.keys(store)).toHaveLength(DEFERRED_MAX_POSTS);
    expect(store.p0.events).toHaveLength(DEFERRED_MAX_PER_POST);
  });
});
