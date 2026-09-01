/**
 * Вставляет новые элементы в уже отсортированный DESC-массив (по полю createdAt).
 *
 * Используется в appendNewMessages: вместо полной пересортировки O(N log N)
 * делаем слияние O(N + M), где M — число новых сообщений.
 * В типичном случае M = 0–3, поэтому операция практически бесплатна.
 *
 * Инвариант: `existing` уже отсортирован DESC по createdAt.
 * Возвращает новый массив, отсортированный DESC, или тот же `existing` если нет изменений.
 */
export function insertSortedDesc<T extends { id: string; createdAt: number }>(
  existing: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) {
    // Сортируем incoming DESC на случай если пришёл не в порядке
    return [...incoming].sort((a, b) => b.createdAt - a.createdAt);
  }

  // Быстрый путь: все новые элементы новее самого первого (самого свежего) existing →
  // просто prepend и отсортировать только incoming между собой
  const newestExisting = existing[0].createdAt;
  if (incoming.every((m) => m.createdAt >= newestExisting)) {
    const sortedIncoming = [...incoming].sort((a, b) => b.createdAt - a.createdAt);
    return [...sortedIncoming, ...existing];
  }

  // Медленный путь: входящие пришли с задержкой (out-of-order) — полное слияние
  const merged = [...incoming, ...existing];
  merged.sort((a, b) => b.createdAt - a.createdAt);
  return merged;
}
