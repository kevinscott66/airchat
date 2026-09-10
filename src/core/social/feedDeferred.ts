/**
 * Отложенные события ленты: реакция, правка и голос, приехавшие раньше поста.
 *
 * Дефект (v4.32.615). Реакция, правка, голос и просмотр отбрасывались, если
 * публикации, к которой они относятся, у получателя ещё нет: addReaction
 * возвращала `false` («поста нет»), а feed_edit/feed_poll_vote выходили по
 * `feed_edit_unknown_post` / `feed_poll_vote_unknown_post`. Повтора у них не
 * бывает: в addAndBroadcastReaction прямо написано, что очереди повторов у
 * реакции нет, — то есть событие пропадало навсегда.
 *
 * Порядок доставки не гарантирован ничем. Пост доходит до третьего лица через
 * пересылку по цепочке (до трёх переходов), реакция на него — напрямую от
 * поставившего, и это два независимых пути с разной задержкой. Отдельно
 * складывается переигрывание накопленного за двенадцать часов: там порядок
 * задаёт очередь отправителя, а не время события.
 *
 * Решение — маленькая полка: событие без публикации откладывается, а когда
 * публикация приходит, всё отложенное по её номеру применяется по возрастанию
 * времени. Полка ограничена со всех сторон, потому что её наполняет чужой
 * подписанный конверт: номер публикации придумывает отправитель, и завалить
 * полку ссылками на несуществующие публикации может кто угодно из контактов.
 *
 * Просмотры (`feed_view`) сюда не кладутся намеренно: их много (у заметной
 * публикации — тысячи), а ценность каждого — единица в счётчике. По той же
 * причине их не пересылают по цепочке.
 *
 * Комментарии кладутся (v4.32.615). Прежняя оговорка ссылалась на очередь
 * повторов комментария, но та наполняется только при неудаче доставки
 * (`!res || res.delivered.success < res.delivered.total`): конверт, дошедший
 * до всех, но отвергнутый получателем как сирота, повторён не будет никогда.
 * А отвергается он ровно в том случае, ради которого полка и заведена, —
 * публикация ещё в пути. Комментарий крупнее реакции, поэтому у полки
 * появился ещё и потолок в байтах: чужой подписанный конверт задаёт и число
 * событий, и их размер.
 */
import type { FeedEnvelopePayload } from './feedTransport';

/** Сколько живёт отложенное событие. Дольше суток пост уже не придёт. */
export const DEFERRED_TTL_MS = 24 * 60 * 60 * 1000;
/** Сколько разных публикаций держим на полке. */
export const DEFERRED_MAX_POSTS = 32;
/** Сколько событий на одну публикацию. */
export const DEFERRED_MAX_PER_POST = 24;
/**
 * Потолок полки в знаках JSON.
 *
 * Число событий само по себе размер не ограничивает: текст комментария —
 * до двух тысяч знаков, и полное заполнение по одному лишь счётчику дало бы
 * запись под полтора мегабайта, которую пришлось бы читать и переписывать на
 * каждое следующее отложенное событие. Реакциям и голосам этот потолок не
 * мешает: они на два порядка меньше.
 */
export const DEFERRED_MAX_BYTES = 192 * 1024;

export type DeferredType = 'feed_reaction' | 'feed_edit' | 'feed_poll_vote' | 'feed_comment';

export const DEFERRABLE: readonly DeferredType[] = [
  'feed_reaction',
  'feed_edit',
  'feed_poll_vote',
  'feed_comment',
];

export type DeferredEvent = {
  type: DeferredType;
  authorDid: string;
  ts: number;
  data: unknown;
};

export type DeferredBucket = {
  /** Время последнего пополнения — по нему вытесняется самая старая полка. */
  at: number;
  events: DeferredEvent[];
};

export type DeferredStore = Record<string, DeferredBucket>;

/** Можно ли отложить событие этого рода. */
export function isDeferrable(type: string): type is DeferredType {
  return (DEFERRABLE as readonly string[]).includes(type);
}

/**
 * Ячейка события: два события с одной ячейкой — это одно и то же действие,
 * и держать оба незачем. Правка у публикации одна на автора и разрешается по
 * времени, поэтому её ячейка — это её автор.
 */
export function deferredSlot(e: DeferredEvent): string {
  const d = (e.data ?? {}) as {
    emoji?: unknown;
    optionIndex?: unknown;
    remove?: unknown;
    commentId?: unknown;
  };
  // v4.32.673: в ячейке правки стоит её автор. Раньше здесь была голая строка
  // 'edit', одна на всю публикацию, — и правки разных отправителей сталкивались
  // в ней, хотя правкой публикации является только правка её автора.
  //
  // Проверить авторство на полке нечем: публикации ещё нет, а её автора знает
  // только она сама. Проверка есть на выходе — applyFeedEnvelope отвергает
  // правку с чужим DID (`feed_edit_auth_mismatch`), — но до выхода доживал один
  // жилец ячейки, тот, у кого время больше. Любой контакт, подписав feed_edit
  // на ещё не доехавшую до получателя публикацию временем чуть вперёд
  // (транспорт разрешает пять минут), занимал ячейку, вытеснял из неё настоящую
  // правку автора и сам отсеивался при применении. Правка пропадала молча и
  // навсегда: очереди повторов у неё нет.
  //
  // Остальные рода отправителей уже различали: реакция и голос — по DID,
  // комментарий — по своему номеру.
  if (e.type === 'feed_edit') return `e|${e.authorDid}`;
  if (e.type === 'feed_reaction') return `r|${e.authorDid}|${String(d.emoji ?? '')}`;
  // Ячейка комментария — его собственный номер: повтор того же конверта не
  // должен занимать на полке второе место, а два разных комментария одного
  // человека — это два разных события.
  if (e.type === 'feed_comment') return `c|${String(d.commentId ?? '')}`;
  return `v|${e.authorDid}|${String(d.optionIndex ?? '')}`;
}

/** Событие из проверенного конверта. `null` — род не откладывается. */
export function deferredFromPayload(payload: FeedEnvelopePayload): DeferredEvent | null {
  if (!isDeferrable(payload.type)) return null;
  return { type: payload.type, authorDid: payload.authorDid, ts: payload.ts, data: payload.data };
}

/** Форма записи с полки — она пролежала на диске и могла быть чем угодно. */
function validEvent(v: unknown): v is DeferredEvent {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as DeferredEvent;
  return (
    isDeferrable(e.type) &&
    typeof e.authorDid === 'string' &&
    e.authorDid.length > 0 &&
    e.authorDid.length <= 256 &&
    Number.isSafeInteger(e.ts) &&
    e.ts >= 0 &&
    !!e.data &&
    typeof e.data === 'object' &&
    !Array.isArray(e.data)
  );
}

/** Разбор полки с диска: всё непонятное молча выбрасывается. */
export function parseDeferredStore(raw: string | null | undefined): DeferredStore {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: DeferredStore = {};
  for (const [postId, bucket] of Object.entries(parsed as Record<string, unknown>)) {
    if (!postId || postId.length > 128) continue;
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    const b = bucket as DeferredBucket;
    if (!Number.isSafeInteger(b.at) || b.at < 0) continue;
    if (!Array.isArray(b.events)) continue;
    const events = b.events.filter(validEvent).slice(0, DEFERRED_MAX_PER_POST);
    if (events.length === 0) continue;
    out[postId] = { at: b.at, events };
  }
  return out;
}

/** Снять просроченное. Возвращает новую полку. */
export function pruneDeferred(store: DeferredStore, now: number): DeferredStore {
  const out: DeferredStore = {};
  for (const [postId, bucket] of Object.entries(store)) {
    const events = bucket.events.filter((e) => now - e.ts < DEFERRED_TTL_MS);
    if (events.length > 0) out[postId] = { at: bucket.at, events };
  }
  return out;
}

/**
 * Положить событие на полку.
 *
 * Порядок вытеснения: сначала просроченное, потом — внутри публикации — самое
 * старое событие, и только потом целая полка самой давно не пополнявшейся
 * публикации. Новое событие всегда проходит: иначе первый же заваливший полку
 * контакт закрыл бы её для всех остальных.
 */
export function addDeferred(
  store: DeferredStore,
  postId: string,
  event: DeferredEvent,
  now: number
): DeferredStore {
  const next = pruneDeferred(store, now);
  const bucket = next[postId] ?? { at: now, events: [] };
  const slot = deferredSlot(event);
  const kept = bucket.events.filter((e) => deferredSlot(e) !== slot || e.ts > event.ts);
  // Ячейка занята более свежим событием — новое уже неактуально.
  const events = kept.length === bucket.events.length && kept.some((e) => deferredSlot(e) === slot)
    ? kept
    : [...kept, event];
  events.sort((a, b) => a.ts - b.ts);
  next[postId] = {
    at: now,
    events: events.slice(Math.max(0, events.length - DEFERRED_MAX_PER_POST)),
  };
  const ids = Object.keys(next);
  if (ids.length > DEFERRED_MAX_POSTS) {
    ids
      .filter((id) => id !== postId)
      .sort((a, b) => next[a].at - next[b].at)
      .slice(0, ids.length - DEFERRED_MAX_POSTS)
      .forEach((id) => { delete next[id]; });
  }
  return trimToBudget(next, postId);
}

/**
 * Ужать полку до потолка в байтах.
 *
 * Выбывают самые давно не пополнявшиеся публикации, кроме той, ради которой
 * пришли сейчас, — как и при переполнении по счётчику. Если и она одна уже
 * не помещается, у неё отбрасываются самые старые события, но последнее
 * остаётся всегда: новое событие проходит на полку при любом раскладе.
 */
function trimToBudget(store: DeferredStore, keepPostId: string): DeferredStore {
  if (JSON.stringify(store).length <= DEFERRED_MAX_BYTES) return store;
  const next = { ...store };
  const order = Object.keys(next)
    .filter((id) => id !== keepPostId)
    .sort((a, b) => next[a].at - next[b].at);
  for (const id of order) {
    delete next[id];
    if (JSON.stringify(next).length <= DEFERRED_MAX_BYTES) return next;
  }
  const bucket = next[keepPostId];
  if (!bucket) return next;
  const events = [...bucket.events];
  next[keepPostId] = { at: bucket.at, events };
  while (events.length > 1 && JSON.stringify(next).length > DEFERRED_MAX_BYTES) {
    events.shift();
  }
  return next;
}

/** Снять с полки всё по этой публикации — по возрастанию времени. */
export function takeDeferred(
  store: DeferredStore,
  postId: string,
  now: number
): { store: DeferredStore; events: DeferredEvent[] } {
  const pruned = pruneDeferred(store, now);
  const bucket = pruned[postId];
  if (!bucket) return { store: pruned, events: [] };
  const rest = { ...pruned };
  delete rest[postId];
  return { store: rest, events: [...bucket.events].sort((a, b) => a.ts - b.ts) };
}
