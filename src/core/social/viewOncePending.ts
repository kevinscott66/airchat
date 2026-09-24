/**
 * Показанные одноразовые снимки, которые ещё не стёрты (v4.32.828).
 *
 * Дефект. Одноразовый снимок стирается не в тот же миг, когда его открыли, а
 * через 0,8 секунды: просмотрщик берёт содержимое из уже собранных адресов, а
 * удаление строки уносит за собой файлы из кэша вложений — сотрите раньше, и
 * человек увидит пустой прямоугольник. Всё это время единственная память о
 * том, что снимок показан, — таймер в оперативной памяти. Она не переживает
 * ничего: снятие из многозадачности, падение, выгрузку по нехватке памяти (на
 * телефоне это обычное дело ровно в ту секунду, когда открылась полноэкранная
 * картинка). Переписка открывается заново, строка на месте, снимок «на один
 * раз» открывается второй раз, третий и дальше без счёта.
 *
 * Та же дыра шире таймера: если база в это мгновение занята, удаление
 * отвечает отказом, человеку говорят «снимок остался», и повторить попытку
 * некому — `remove` зовётся ровно один раз.
 *
 * Правка. Перед тем как открыть просмотрщик, номер сообщения записывается на
 * диск — «показан, подлежит удалению». Удалось стереть — запись снимается;
 * не удалось или приложение до этого не дожило — на следующем запуске список
 * дочитывается и строки стираются. Обещание «один показ» больше не держится
 * на таймере.
 *
 * Порядок именно такой: сначала запись, потом показ. Обратный порядок оставил
 * бы щель между показом и записью, и снимок остался бы читаемым — то самое,
 * ради чего всё это. Щель у выбранного порядка тоже есть, зеркальная: падение
 * между записью и показом стирает непоказанный снимок. Но между `await` и
 * следующей строкой не проходит ни одного чужого шага, а запись на диск —
 * это заметное время, и рисковать разумнее непоказанным кадром, чем
 * «одноразовым», который читается вечно.
 *
 * Модуль намеренно не тянет хранилище переписки: удаление приходит
 * зависимостью, поэтому и полка, и порядок проверяются без SQLite.
 */
import { log } from '../logger';
import { scopedKvSetCheckedFor, scopedKvTryGetFor } from '../storage/profileScopedKv';

/** Ключ полки. Своя у каждого аккаунта — как и сама переписка. */
export const PENDING_KEY = 'view_once_pending_v1';

/**
 * Сколько ждём своей очереди на удаление.
 *
 * Неделя — с запасом: за это время приложение открывают не раз. Срок нужен не
 * для порядка, а от вечной записи: строку могли унести другим путём (удаление
 * переписки целиком, смена аккаунта), и тогда «не нашлось» не придёт никогда,
 * потому что дочитывать будет нечего.
 */
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Сколько записей держим.
 *
 * Полку наполняют собственные нажатия, а не чужие конверты, поэтому потолок
 * здесь — от накопления, а не от нападения: шестьдесят четыре непогашенных
 * снимка означают, что удаление не работает вовсе, и хранить больше нет
 * смысла.
 */
export const PENDING_MAX = 64;

/** Где лежит строка: в личной переписке или в группе. */
export type ViewOnceKind = 'chat' | 'group';

/** Что ответило удаление: `failed` — строка осталась, повторим потом. */
export type ViewOnceRemove = 'deleted' | 'missing' | 'failed';

export interface PendingEntry {
  /** Вид переписки: от него зависит, какую таблицу чистить. */
  k: ViewOnceKind;
  /** Номер сообщения. */
  id: string;
  /** Когда снимок показали. */
  at: number;
}

const isKind = (v: unknown): v is ViewOnceKind => v === 'chat' || v === 'group';

/**
 * Разобрать полку. Испорченное, просроченное и лишнее отбрасывается молча:
 * полка — служебная, и падать из-за неё нельзя нигде.
 */
export function parsePending(raw: string | null, now: number): PendingEntry[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: PendingEntry[] = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const e = it as Partial<PendingEntry>;
    if (!isKind(e.k) || typeof e.id !== 'string' || !e.id) continue;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
    if (now - e.at > PENDING_TTL_MS) continue;
    if (out.some((p) => p.k === e.k && p.id === e.id)) continue;
    out.push({ k: e.k, id: e.id, at: e.at });
  }
  return out.slice(-PENDING_MAX);
}

/** Добавить запись. Повтор того же снимка обновляет время, а не множит строки. */
export function withNoted(list: PendingEntry[], entry: PendingEntry): PendingEntry[] {
  const rest = list.filter((p) => !(p.k === entry.k && p.id === entry.id));
  return [...rest, entry].slice(-PENDING_MAX);
}

/** Снять запись. */
export function withoutNoted(list: PendingEntry[], k: ViewOnceKind, id: string): PendingEntry[] {
  return list.filter((p) => !(p.k === k && p.id === id));
}

async function readPending(pid: number, now: number): Promise<PendingEntry[] | null> {
  const got = await scopedKvTryGetFor(pid, PENDING_KEY);
  // `null` — чтение не удалось. Это не «полка пуста»: перезаписав её сейчас,
  // мы бы стёрли чужие непогашенные записи.
  if (!got) return null;
  return parsePending(got.value, now);
}

/**
 * Записать «снимок показан, строку стереть».
 *
 * `false` — записать не удалось. Показ на этом не останавливается: человек
 * нажал, снимок ему причитается, а без записи всё останется как было до этой
 * версии.
 */
export async function noteViewOnceShown(
  pid: number,
  k: ViewOnceKind,
  id: string,
  now = Date.now()
): Promise<boolean> {
  const list = await readPending(pid, now);
  if (!list) return false;
  const next = withNoted(list, { k, id, at: now });
  return scopedKvSetCheckedFor(pid, PENDING_KEY, JSON.stringify(next));
}

/** Снять запись: строки больше нет, догонять нечего. */
export async function forgetViewOnceShown(
  pid: number,
  k: ViewOnceKind,
  id: string,
  now = Date.now()
): Promise<boolean> {
  const list = await readPending(pid, now);
  if (!list) return false;
  const next = withoutNoted(list, k, id);
  if (next.length === list.length) return true;
  return scopedKvSetCheckedFor(pid, PENDING_KEY, JSON.stringify(next));
}

/**
 * Дочистить показанное: вернуть число стёртых строк.
 *
 * Отказ базы запись сохраняет — попробуем на следующем запуске. «Не нашлось»
 * снимает: строки нет, а значит и снимка в переписке нет.
 */
export async function drainViewOncePending(
  pid: number,
  remove: (k: ViewOnceKind, id: string) => Promise<ViewOnceRemove>,
  now = Date.now()
): Promise<number> {
  const list = await readPending(pid, now);
  if (!list || list.length === 0) return 0;
  const keep: PendingEntry[] = [];
  let gone = 0;
  for (const e of list) {
    let res: ViewOnceRemove;
    try {
      res = await remove(e.k, e.id);
    } catch {
      res = 'failed';
    }
    if (res === 'failed') keep.push(e);
    else if (res === 'deleted') gone += 1;
  }
  if (keep.length !== list.length) {
    await scopedKvSetCheckedFor(pid, PENDING_KEY, JSON.stringify(keep));
  }
  if (gone > 0 || keep.length > 0) {
    log.info('view_once_drain', { gone, kept: keep.length });
  }
  return gone;
}

/**
 * То же, но с настоящим удалением: зовётся при запуске.
 *
 * Хранилище приезжает динамическим импортом — модуль дёргают и экраны, и
 * запуск, а тянуть за собой SQLite ради одной строки незачем.
 */
export async function drainViewOncePendingNow(pid: number): Promise<number> {
  const m = await import('../storage/local');
  return drainViewOncePending(pid, async (k, id) =>
    k === 'chat'
      ? await m.deleteChatMessageChecked(id, pid)
      : await m.deleteGroupMessageChecked(id, pid)
  );
}
