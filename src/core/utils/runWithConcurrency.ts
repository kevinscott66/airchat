/**
 * Ограниченная параллельность для асинхронных задач по списку.
 *
 * Замена для `Promise.all(items.map(fn))`, когда длина списка большая: на Hermes / RN
 * слишком много одновременных I/O (fetch, чтение файлов, нативные вызовы) может
 * перегрузить пул потоков или память.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { shouldStop?: () => boolean },
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, concurrency);
  const n = Math.min(cap, items.length);
  const results: R[] = new Array(items.length);
  let idx = 0;
  const stop = options?.shouldStop ?? (() => false);

  const worker = async () => {
    while (!stop()) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
