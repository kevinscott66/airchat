/**
 * Кого человек заглушил в ленте: список did, чьи публикации не показываются и
 * не расходятся дальше через нашу ноду.
 *
 * v4.32.293. Список лежал одной записью на устройство и открытым текстом, а
 * читался в двух местах с разными правилами. Что из этого следовало:
 *
 * - Заглушить кого-то во втором профиле значило заглушить его и в первом.
 *   Решение «не хочу это видеть» — само по себе сведения о человеке, и оно
 *   связывало аккаунты ровно так же, как связывал общий блок-лист (v4.32.281)
 *   и общий список переписок (v4.32.290).
 * - Открытым текстом: перечень did с оценкой «неприятен» читался в базе как
 *   есть, хотя блок-лист рядом уже шифруется.
 * - Экран ленты разбирал запись как `new Set(JSON.parse(raw))` без проверок:
 *   подменённая строка `"abc"` разворачивалась в набор букв, объект — в
 *   исключение. feedService рядом проверял и тип, и элементы. Правило теперь
 *   одно и здесь.
 *
 * Список читается на КАЖДЫЙ входящий конверт ленты, поэтому держится в памяти
 * процесса: единственный, кто его меняет, — этот модуль, и он же обновляет
 * кэш. Кэш привязан к профилю, так что переключение аккаунта его не переживает.
 */
import { log } from '../logger';
import {
  activeProfileIdOrNull,
  readProfileSharedSecret,
  writeProfileSharedSecret,
} from '../storage/profileSharedKv';

export const MUTED_AUTHORS_KEY = 'feed_muted_authors';

/** Больше — уже не «не хочу видеть этих», а испорченная или подложенная запись. */
const MAX_MUTED = 2000;
const MAX_DID_LEN = 256;

let cache: { profileId: number; set: Set<string> } | null = null;

/** Сбросить кэш (смена DEK, восстановление из копии, тесты). */
export function resetMutedAuthorsCache(): void {
  cache = null;
}

function parseMuted(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const out = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string' || !item || item.length > MAX_DID_LEN) continue;
      out.add(item);
      if (out.size >= MAX_MUTED) break;
    }
    return out;
  } catch {
    return new Set();
  }
}

export async function getMutedAuthors(): Promise<Set<string>> {
  const pid = activeProfileIdOrNull();
  if (pid != null && cache?.profileId === pid) return cache.set;
  try {
    // Перенос старой общей записи — в storage/profileSharedKv: правило у неё
    // общее с названиями папок чатов (v4.32.294), и копия здесь разъехалась бы
    // с копией там ровно так же, как разъезжались правила чтения этого списка.
    const set = parseMuted(await readProfileSharedSecret(MUTED_AUTHORS_KEY));
    if (pid != null) cache = { profileId: pid, set };
    return set;
  } catch (e) {
    log.warn('muted_authors_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return new Set();
  }
}

export async function isAuthorMuted(did: string): Promise<boolean> {
  if (!did) return false;
  return (await getMutedAuthors()).has(did);
}

/**
 * Переключить заглушение и вернуть новый список — интерфейс показывает именно
 * то, что записано, а не то, что он предположил.
 */
export async function toggleMutedAuthor(did: string): Promise<Set<string>> {
  const current = await getMutedAuthors();
  const pid = activeProfileIdOrNull();
  if (!did || pid == null) {
    log.warn('muted_authors_no_profile', { didLen: did.length });
    return current;
  }
  const next = new Set(current);
  if (next.has(did)) {
    next.delete(did);
  } else if (next.size >= MAX_MUTED) {
    log.warn('muted_authors_limit', { size: next.size });
    return current;
  } else {
    next.add(did);
  }
  // Кэш обновляем только вслед за записью: разойдись они — интерфейс показывал
  // бы заглушение, которого в базе нет, и после перезапуска оно бы «отменилось».
  if (!(await writeProfileSharedSecret(MUTED_AUTHORS_KEY, JSON.stringify([...next])))) {
    return current;
  }
  cache = { profileId: pid, set: next };
  return next;
}
