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
  tryReadProfileSharedSecret,
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

/**
 * Кэш либо чтение из базы. `null` — не прочитали.
 *
 * v4.32.699: пустой список, полученный из неудачного чтения, раньше попадал в
 * кэш и жил там до конца сеанса. Это превращало одну заминку базы в постоянную:
 * каждое следующее переключение писало новый список поверх старого, взяв за
 * основу пустоту.
 */
async function currentMuted(): Promise<Set<string> | null> {
  const pid = activeProfileIdOrNull();
  if (pid != null && cache?.profileId === pid) return cache.set;
  try {
    // Перенос старой общей записи — в storage/profileSharedKv: правило у неё
    // общее с названиями папок чатов (v4.32.294), и копия здесь разъехалась бы
    // с копией там ровно так же, как разъезжались правила чтения этого списка.
    const read = await tryReadProfileSharedSecret(MUTED_AUTHORS_KEY);
    if (read === null) return null;
    const set = parseMuted(read.value);
    if (pid != null) cache = { profileId: pid, set };
    return set;
  } catch (e) {
    log.warn('muted_authors_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Для показа: не прочитали — считаем, что заглушённых нет. Лишняя публикация в
 * ленте обратима, в отличие от записи по такому же предположению.
 */
export async function getMutedAuthors(): Promise<Set<string>> {
  return (await currentMuted()) ?? new Set();
}

export async function isAuthorMuted(did: string): Promise<boolean> {
  if (!did) return false;
  return (await getMutedAuthors()).has(did);
}

/**
 * То же исходом чтения (v4.32.1043).
 *
 * `null` — списка мы не прочитали. Оправдание короткой формы выше («лишняя
 * публикация в ленте обратима») верно ровно для показа. Приём чужого конверта
 * не только показывает: следом за проверкой стоит пересылка чужой публикации
 * моим контактам от моего имени, а её не отменить ничем. Тому месту нужна
 * разница между «никого не заглушали» и «не знаем».
 */
export async function isAuthorMutedTry(did: string): Promise<{ muted: boolean } | null> {
  if (!did) return { muted: false };
  const set = await currentMuted();
  return set === null ? null : { muted: set.has(did) };
}

/**
 * Чем кончилась попытка заглушить или расслышать автора (v4.32.905).
 *
 * Прежде и удача, и отказ возвращались набором заглушённых: при отказе — тем,
 * что лежало в базе до попытки. Экран отличал от него только `null` («список
 * не прочитался»), а остальные отказы принимал за удачу и молча перерисовывал
 * ленту прежним списком.
 *
 * `muted` при отказе — то, что в базе на самом деле: экран по нему всё равно
 * обновляется, соврав при этом только в одном — в молчании, которого теперь
 * нет.
 */
export type MuteWrite =
  | { ok: true; muted: Set<string> }
  | { ok: false; why: 'unreadable'; muted: null }
  | { ok: false; why: 'write_failed' | 'limit' | 'no_profile'; muted: Set<string> };

/** Предел числа заглушённых — показывается человеку, когда он в него упёрся. */
export { MAX_MUTED };

/**
 * Заглушить автора или расслышать обратно — по тому, что человек попросил.
 *
 * `ok: false` — не записано, и `why` говорит почему. «Не прочитали» выделено
 * отдельно: запись идёт целиком, так что «взять пустой набор и добавить
 * одного» означало бы вернуть человеку в ленту всех, кого он когда-либо
 * заглушил.
 *
 * v4.32.1046: направление приходит снаружи, а не выводится из базы. Прежде
 * функция переключала: брала текущее состояние и меняла его на обратное. Но
 * надпись на кнопке экран берёт из списка, прочитанного при открытии ленты, а
 * `getMutedAuthors` на отказ базы отдаёт пустой набор — на запуске, когда
 * связка ключей ещё не готова, это обычное дело. Заглушённый автор оказывался
 * в меню с надписью «Скрыть автора», человек её нажимал, здесь список
 * перечитывался уже успешно — и автор РАССЛЫШИВАЛСЯ. Просьба спрятать
 * исполнялась наоборот и ложилась на диск. Теперь «скрыть» значит скрыть при
 * любом исходе прежнего чтения.
 */
export async function setAuthorMuted(did: string, want: boolean): Promise<MuteWrite> {
  const current = await currentMuted();
  if (current === null) {
    log.warn('muted_authors_unreadable', { didLen: did.length });
    return { ok: false, why: 'unreadable', muted: null };
  }
  const pid = activeProfileIdOrNull();
  if (!did || pid == null) {
    log.warn('muted_authors_no_profile', { didLen: did.length });
    return { ok: false, why: 'no_profile', muted: current };
  }
  const next = new Set(current);
  if (!want) {
    next.delete(did);
  } else if (!next.has(did) && next.size >= MAX_MUTED) {
    log.warn('muted_authors_limit', { size: next.size });
    return { ok: false, why: 'limit', muted: current };
  } else {
    next.add(did);
  }
  // Кэш обновляем только вслед за записью: разойдись они — интерфейс показывал
  // бы заглушение, которого в базе нет, и после перезапуска оно бы «отменилось».
  if (!(await writeProfileSharedSecret(MUTED_AUTHORS_KEY, JSON.stringify([...next])))) {
    log.warn('muted_authors_write_failed', { didLen: did.length });
    return { ok: false, why: 'write_failed', muted: current };
  }
  cache = { profileId: pid, set: next };
  return { ok: true, muted: next };
}
