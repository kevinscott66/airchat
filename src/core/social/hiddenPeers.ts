/**
 * Список «не отмечать этого человека» — разбор и правка (v4.32.485).
 *
 * Живёт отдельно от presenceService, потому что нужен в двух местах сразу:
 * служба ведёт свой список в памяти, а просьба, адресованная ДРУГОМУ
 * аккаунту, правится прямо в его записи, минуя память. Одна и та же граница
 * (HIDDEN_PEERS_MAX) должна действовать на обоих путях, иначе мусор в kv
 * обходит её по второму.
 *
 * Модуль ничего не импортирует: ни базы, ни профилей — только строки.
 */

/** Верхняя граница на случай мусора в kv. */
export const HIDDEN_PEERS_MAX = 1000;

/**
 * Разобрать сохранённый список. Что угодно, кроме массива непустых строк,
 * читается как пустой список: запись пишем мы сами, но прочитать её можно
 * и после порчи файла базы.
 */
export function parseHiddenPeers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const p of parsed) {
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
    if (out.length >= HIDDEN_PEERS_MAX) break;
  }
  return out;
}

/**
 * Новый список после просьбы собеседника, либо null — если он не изменился.
 *
 * null отличается от «списка с тем же содержимым» намеренно: вызывающий по
 * нему решает, писать ли в базу вообще. Переполнение списка тоже даёт null —
 * запрет не запомнен, и делать вид, что запомнен, нельзя.
 */
export function withHiddenPeer(
  list: readonly string[],
  peer: string,
  hidden: boolean
): string[] | null {
  if (!peer) return null;
  const has = list.includes(peer);
  if (hidden) {
    if (has) return null;
    if (list.length >= HIDDEN_PEERS_MAX) return null;
    return [...list, peer];
  }
  if (!has) return null;
  return list.filter((p) => p !== peer);
}
