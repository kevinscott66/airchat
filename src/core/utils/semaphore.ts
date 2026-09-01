/**
 * semaphore — ограничитель одновременных задач.
 *
 * v4.32.359. Такой счётчик уже жил в useResolvedMediaUrls: пара модульных
 * переменных и очередь продолжений, вплотную к хуку и потому непроверяемая.
 * Считает он тонко — освободившийся слот не отдаётся обратно в счётчик, а
 * передаётся первому ожидающему, — и ошибка в этой арифметике не видна ничем,
 * кроме зависшей загрузки: счётчик уехал вверх, свободных слотов «нет»
 * навсегда, картинки в чате остаются серыми квадратами до перезапуска.
 *
 * Ни таймеров, ни платформенных модулей: только очередь и число.
 */

export type Semaphore = {
  /** Выполнить задачу, дождавшись свободного слота. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Сколько задач выполняется прямо сейчас. */
  activeCount: () => number;
  /** Сколько ждёт своей очереди. */
  waitingCount: () => number;
};

export function createSemaphore(max: number): Semaphore {
  // Нецелый или нулевой предел — это ошибка вызывающего, но останавливать из-за
  // неё загрузку картинок не стоит: один слот работает, просто медленнее.
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  let active = 0;
  const waiting: Array<() => void> = [];

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < limit) {
      active += 1;
    } else {
      // Слот не занимаем: его передаст освободившийся, счётчик не меняется.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      // Освобождение обязано случиться и после отказа задачи, иначе один
      // неудачный запрос забирает слот навсегда.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  }

  return {
    run,
    activeCount: () => active,
    waitingCount: () => waiting.length,
  };
}
