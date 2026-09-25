/**
 * Каким ключом открывался `@имя` в прошлый раз (v4.32.945).
 *
 * Дефект. Переход по `@имени` к незнакомцу целиком верит серверу справочника.
 * Сервер отвечает «имя занято, вот ключ», и клиент открывает по этому ключу
 * карточку, а с неё — переписку. Никакой проверки нет: сервер называет любой
 * ключ, и переписка «с Аней» пойдёт с тем, чей ключ он назвал.
 *
 * Почему подпись эту дыру не закрывает. При занятии имени клиент подписывает
 * привязку своим ключом переписки, и сервер подпись проверяет
 * (`usernameDirectoryProof`). Отдать эту подпись в ответ на запрос и проверить
 * её у себя — ничего не даёт: подпись стоит под тем же ключом, который сервер
 * и назвал. Подделывающий ответ берёт СВОЙ ключ и делает под ним СВОЮ подпись,
 * и она сойдётся. Подпись доказывает «этот ключ согласен стоять за именем», а
 * нужно «за именем стоит именно тот ключ» — а это знает только тот, кто видел
 * имя раньше.
 *
 * Правка. Видели раньше — мы. Ключ, с которым имя открылось впервые,
 * запоминается, и при следующем переходе ответ сервера с ним сверяется. Разошлись
 * — человеку говорится об этом прямо, вместо молчаливой карточки незнакомца.
 *
 * Границы, и их надо назвать честно:
 *
 * - Первый переход не защищён ничем. Запоминать нечего, и сервер в этот момент
 *   волен сказать что угодно. Защищён второй и все следующие.
 * - Знакомые сюда не попадают вовсе: `resolveMentionTarget` ищет в адресной
 *   книге ДО справочника, и у контакта ключ лежит на устройстве.
 * - Смена ключа бывает и честной — человек переставил приложение, завёл новый
 *   профиль. Поэтому переход не запрещается, а сопровождается предупреждением:
 *   запрет сломал бы честный случай, а молчание — нечестный.
 * - Запомненное НЕ переписывается само на ответ, который не сошёлся. Иначе
 *   предупреждение показалось бы ровно один раз, а дальше за именем стоял бы
 *   подменённый ключ — то есть подмена закреплялась бы самой проверкой.
 *
 * Запись привязана к профилю и шифруется, как и список заглушённых рядом: с
 * кем человек собирался заговорить — сведения о нём самом.
 */
import { log } from '../logger';
import {
  activeProfileIdOrNull,
  tryReadProfileSharedSecret,
  writeProfileSharedSecret,
} from '../storage/profileSharedKv';

export const USERNAME_KEY_PINS_KEY = 'username_key_pins';

/**
 * Больше — уже не «имена, по которым человек ходил», а испорченная или
 * подложенная запись. Переполнение вытесняет самое давнее: помнить полезнее
 * то, к чему возвращаются.
 */
export const MAX_USERNAME_PINS = 512;

/** Ключ переписки в base64 длиннее не бывает; длиннее — мусор в записи. */
const MAX_PUB_LEN = 128;
const MAX_NAME_LEN = 64;

type Pin = { pub: string; ts: number };

let cache: { profileId: number; pins: Map<string, Pin> } | null = null;

/** Сбросить память модуля (смена DEK, восстановление из копии, тесты). */
export function resetUsernameKeyPinCache(): void {
  cache = null;
}

function parsePins(raw: string | null): Map<string, Pin> {
  const out = new Map<string, Pin>();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!name || name.length > MAX_NAME_LEN) continue;
      if (!value || typeof value !== 'object') continue;
      const { pub, ts } = value as { pub?: unknown; ts?: unknown };
      if (typeof pub !== 'string' || !pub || pub.length > MAX_PUB_LEN) continue;
      if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
      out.set(name, { pub, ts });
      if (out.size >= MAX_USERNAME_PINS) break;
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * Запомненное либо чтение из базы. `null` — не прочитали.
 *
 * Пустота от неудачного чтения в кэш не кладётся: иначе одна заминка базы
 * означала бы, что до конца сеанса не помним НИЧЕГО, и первая же запись поверх
 * стёрла бы всё запомненное раньше.
 */
async function currentPins(): Promise<Map<string, Pin> | null> {
  const pid = activeProfileIdOrNull();
  if (pid != null && cache?.profileId === pid) return cache.pins;
  try {
    const read = await tryReadProfileSharedSecret(USERNAME_KEY_PINS_KEY);
    if (read === null) return null;
    const pins = parsePins(read.value);
    if (pid != null) cache = { profileId: pid, pins };
    return pins;
  } catch (e) {
    log.warn('username_pin_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Чем кончилась сверка ответа справочника с запомненным.
 *
 * `unknown` отдельно от `first`: «не прочитали» и «видим впервые» ведут себя
 * одинаково (переход идёт), но говорить о них одно и то же нельзя — во втором
 * случае мы запомнили, в первом нет.
 */
export type PinVerdict =
  /** Имя видим впервые — ключ запомнен. */
  | { status: 'first' }
  /** Ключ тот же, что и был. */
  | { status: 'same'; since: number }
  /** Ключ другой. `since` — когда запомнили прежний. */
  | { status: 'changed'; since: number }
  /** Запомненное не прочиталось: сверять не с чем. */
  | { status: 'unknown' };

/**
 * Сверить ключ, который справочник назвал за именем, с запомненным — и
 * запомнить, если имя встретилось впервые.
 *
 * Отказ записи не превращается в отказ перехода: не запомнили — значит в
 * следующий раз спросим заново, а не оставим человека без карточки.
 */
export async function checkUsernameKeyPin(username: string, pub: string): Promise<PinVerdict> {
  if (!username || !pub || pub.length > MAX_PUB_LEN) return { status: 'unknown' };
  const pins = await currentPins();
  if (pins === null) return { status: 'unknown' };
  const known = pins.get(username);
  if (known) {
    return known.pub === pub
      ? { status: 'same', since: known.ts }
      : { status: 'changed', since: known.ts };
  }
  const pid = activeProfileIdOrNull();
  if (pid == null) return { status: 'unknown' };
  const next = new Map(pins);
  if (next.size >= MAX_USERNAME_PINS) {
    let oldestName: string | null = null;
    let oldestTs = Infinity;
    for (const [name, pin] of next) {
      if (pin.ts < oldestTs) { oldestTs = pin.ts; oldestName = name; }
    }
    if (oldestName !== null) next.delete(oldestName);
  }
  next.set(username, { pub, ts: Date.now() });
  if (!(await writeProfileSharedSecret(USERNAME_KEY_PINS_KEY, serializePins(next)))) {
    log.warn('username_pin_write_failed', { nameLen: username.length });
    return { status: 'unknown' };
  }
  cache = { profileId: pid, pins: next };
  return { status: 'first' };
}

/**
 * Принять новый ключ за именем — после того, как человек с ним всё же
 * заговорил.
 *
 * Зовётся не сверкой, а действием человека: иначе предупреждение о смене
 * ключа показалось бы один раз и само себя отменило. Молчаливого вызова здесь
 * быть не должно.
 */
export async function acceptUsernameKey(username: string, pub: string): Promise<boolean> {
  if (!username || !pub || pub.length > MAX_PUB_LEN) return false;
  const pins = await currentPins();
  const pid = activeProfileIdOrNull();
  if (pins === null || pid == null) return false;
  const next = new Map(pins);
  next.set(username, { pub, ts: Date.now() });
  if (!(await writeProfileSharedSecret(USERNAME_KEY_PINS_KEY, serializePins(next)))) {
    log.warn('username_pin_accept_failed', { nameLen: username.length });
    return false;
  }
  cache = { profileId: pid, pins: next };
  return true;
}

function serializePins(pins: Map<string, Pin>): string {
  const obj: Record<string, Pin> = {};
  for (const [name, pin] of pins) obj[name] = pin;
  return JSON.stringify(obj);
}
