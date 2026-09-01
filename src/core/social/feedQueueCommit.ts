/**
 * Слияние итогов рассылки с текущей очередью публикации (v4.32.456).
 *
 * Очередь лежит в одной записи kv, и до этой версии каждая ветка работала с ней
 * так: прочитать весь массив → менять свою копию → записать весь массив обратно.
 * У рассылки между чтением и записью стоит сеть: один пост живёт в ней до 20
 * секунд, вся рассылка — десятки. Всё, что попадало в очередь за это время,
 * стиралось записью старого снимка. Пользователь при этом видел «пост
 * поставлен в очередь» и пост в своей ленте — а записи в очереди уже не было,
 * и ретраев не случалось никогда.
 *
 * Поэтому рассылка больше не записывает свой снимок. Она приносит решения по
 * своим записям, а `mergeQueue` накладывает их на очередь, прочитанную в момент
 * записи: чужие и новые записи остаются нетронутыми, а по своим сливаются
 * `deliveredTo` (иначе уже получившие пост получат его повторно) и берётся
 * большее число попыток (иначе счётчик откатывается назад).
 *
 * Функция намеренно ничего не знает о содержимом записи: ей нужны `id`,
 * `retries` и `deliveredTo`, остальные поля она переносит как есть.
 */

/** Минимум, который слияние обязано понимать. Остальное — данные записи. */
export type QueueEntry = {
  id: string;
  retries: number;
  deliveredTo?: string[];
};

/**
 * Решение рассылки по одной записи: `null` — убрать из очереди (доставлена
 * всем, протухла или исчерпала попытки), запись — оставить в этом виде.
 */
export type QueueDecision<T extends QueueEntry> = T | null;

/** Объединение списков доставки: повторно слать тому, кто уже получил, нельзя. */
function unionDelivered(a?: string[], b?: string[]): string[] | undefined {
  if (!a?.length) return b?.length ? [...b] : undefined;
  if (!b?.length) return [...a];
  const seen = new Set<string>(a);
  for (const d of b) seen.add(d);
  return [...seen];
}

/**
 * Наложить решения рассылки на актуальную очередь.
 *
 * @param current очередь, прочитанная в момент записи (в ней уже есть посты,
 *                добавленные пока рассылка шла)
 * @param decisions решения по `id` записей из снимка рассылки
 */
export function mergeQueue<T extends QueueEntry>(
  current: readonly T[],
  decisions: ReadonlyMap<string, QueueDecision<T>>,
): T[] {
  const out: T[] = [];
  for (const stored of current) {
    if (!decisions.has(stored.id)) {
      // Запись появилась (или изменилась) после снимка — рассылка о ней не знает.
      out.push(stored);
      continue;
    }
    const decided = decisions.get(stored.id) ?? null;
    if (decided === null) continue;
    out.push({
      ...decided,
      retries: Math.max(stored.retries, decided.retries),
      deliveredTo: unionDelivered(stored.deliveredTo, decided.deliveredTo),
    });
  }
  return out;
}

/**
 * Минимум для очереди комментариев (v4.32.471).
 *
 * У неё своя единица — не пост, а один комментарий или одно его удаление, —
 * и опознаётся она по `key`, а списка доставки у неё нет вовсе: конверт либо
 * ушёл всем, либо ждёт следующей попытки. Поэтому отдельный тип, а не
 * натягивание `QueueEntry` на чужую форму.
 */
export type OutboxEntry = { key: string; retries: number };

/**
 * Наложить итоги рассылки комментариев на очередь, прочитанную в момент записи.
 *
 * Та же беда, что и у очереди постов, и по той же причине: рассылка держала
 * снимок очереди всё время похода в сеть, а потом записывала его поверх файла.
 * Комментарий, написанный за эти секунды, исчезал молча — человек видел его в
 * ленте, но повторных попыток по нему не случалось никогда.
 */
export function mergeOutbox<T extends OutboxEntry>(
  current: readonly T[],
  decisions: ReadonlyMap<string, T | null>,
): T[] {
  const out: T[] = [];
  for (const stored of current) {
    if (!decisions.has(stored.key)) {
      // Запись появилась (или её переписали) после снимка — рассылка о ней не знает.
      out.push(stored);
      continue;
    }
    const decided = decisions.get(stored.key) ?? null;
    if (decided === null) continue;
    // Счётчик попыток только растёт: иначе повторная постановка в очередь
    // обнулила бы его и запись крутилась бы вечно.
    out.push({ ...decided, retries: Math.max(stored.retries, decided.retries) });
  }
  return out;
}

/** Ключ, под которым в счётчике лежат записи без отметки автора (до v4.32.439). */
export const UNKNOWN_AUTHOR = '';

/** Сколько записей очереди приходится на каждого автора. */
export type QueueCounts = Record<string, number>;

/**
 * Чьи это записи (v4.32.459).
 *
 * Очередь публикации — одна на всё приложение, а профилей в нём несколько.
 * Отправить запись может только тот ключ, которым она подписана; остальным она
 * не показывается и не будит их таймер повтора. Записи без отметки автора
 * (до v4.32.439) считаем своими: их владельца выясняет сама рассылка, заглянув
 * в ленту, и отдать их некому больше.
 */
export function ownedByKey<T extends { authorDid?: string }>(
  items: readonly T[],
  myDid: string,
): T[] {
  return items.filter((it) => (it.authorDid ?? UNKNOWN_AUTHOR) === UNKNOWN_AUTHOR || it.authorDid === myDid);
}

/** Разложить очередь по авторам — чтобы не читать её целиком ради одного числа. */
export function countByAuthor(items: readonly { authorDid?: string }[]): QueueCounts {
  const out: QueueCounts = {};
  for (const it of items) {
    const key = it.authorDid ?? UNKNOWN_AUTHOR;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Столько записей увидит владелец ключа `myDid` — ровно `ownedByKey(...).length`. */
export function sendableCount(counts: QueueCounts, myDid: string): number {
  return (counts[myDid] ?? 0) + (counts[UNKNOWN_AUTHOR] ?? 0);
}

/** Разобрать сохранённый счётчик. Формат до v4.32.459 (голое число) не читаем — пересчитаем. */
export function parseQueueCounts(raw: string | null | undefined): QueueCounts | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const out: QueueCounts = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
