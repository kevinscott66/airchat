/**
 * Автоудаление по умолчанию для новых разговоров (Настройки → «Автоудаление
 * новых чатов»).
 *
 * v4.32.236: до той версии ключ писался и читался ТОЛЬКО экраном настроек —
 * чтобы показать выбранное значение обратно. Ни один разговор его не получал:
 * человек включал «1 день», видел «1 день» в настройках, а сообщения не
 * удалялись никогда.
 *
 * v4.32.483: запись лежала без имени профиля — одна на всю установку. Это
 * единственная настройка, по которой переписка УДАЛЯЕТСЯ, и она молча служила
 * всем аккаунтам сразу: включённое в отдельном аккаунте автоудаление ставило
 * таймер на новые разговоры основного, а выключенное в основном оставляло
 * навсегда те, что человек заводил как временные. Уборка удалённого профиля
 * сметает `p<id>:%` — под общее имя запись не подпадала и доставалась
 * следующему профилю с тем же номером.
 *
 * Тогда же значение переехало из local.ts сюда: кэш и разбор границ — не
 * дело модуля, который открывает базу, а проверить их без SQLite нужно.
 */
import { scopedKvSetCheckedFor, scopedKvTryGetFor } from './profileScopedKv';
import { DEFAULT_AUTO_DELETE_KEY, parseAutoDeleteMs } from './autoDeletePolicy';
import { profileManager } from '../identity/profileManager';

/**
 * Значение кэшируется: touchConversation вызывается на каждое сообщение, а
 * чтение kv — запрос к SQLite, который иначе шёл бы перед каждой записью.
 *
 * Кэш по профилю: переключение аккаунта его не сбрасывает и не должно — у
 * каждого номера свой ответ.
 */
const cache = new Map<number, number | null>();

/**
 * Автоудаление по умолчанию у названного профиля, исходом чтения (v4.32.1000).
 *
 * `null` — прочитать не удалось. `{ ms }` — прочитали: внутри либо срок, либо
 * `null`, то есть «не включено». Короткая форма ниже сводит эти два ответа к
 * одному `null`, и вызывающим её местам этого довольно — они ставят таймер и
 * на «не включено» не ставят ничего. Экрану настроек мало: он не ставит
 * таймер, он показывает, что записано, и «Выключено» на месте непрочитанной
 * записи — рассказ о базе, в которую не заглядывали.
 */
export async function getDefaultDisappearMsReadFor(
  profileId: number,
): Promise<{ ms: number | null } | null> {
  const cached = cache.get(profileId);
  if (cached !== undefined) return { ms: cached };
  const got = await scopedKvTryGetFor(profileId, DEFAULT_AUTO_DELETE_KEY);
  // Провал чтения в кэш НЕ кладётся: раньше единственная ошибка SQLite на
  // старте означала «автоудаление выключено» до конца запуска приложения —
  // настройку молча отменяла случайность.
  if (got === null) return null;
  const value = parseAutoDeleteMs(got.value);
  cache.set(profileId, value);
  return { ms: value };
}

/** Автоудаление по умолчанию у названного профиля. */
export async function getDefaultDisappearMsFor(profileId: number): Promise<number | null> {
  return (await getDefaultDisappearMsReadFor(profileId))?.ms ?? null;
}

/**
 * Разговоры, которым умолчание задолжали (v4.32.1037).
 *
 * Правило «ставить умолчание» одноразовое: оно срабатывает на первом
 * сообщении разговора и больше не вернётся — строка остаётся с непустым
 * `last_message_at` навсегда. Пока короткая форма чтения выше сводила
 * «не прочитали» и «выключено» к одному `null`, одна занятая база в эту
 * секунду оставляла разговор без таймера до конца его жизни, и увидеть это
 * было негде: чат выглядит ровно как обычный.
 *
 * Провал чтения в кэш не кладётся, значит следующее сообщение прочитает
 * настройку заново. Здесь помечается, какому разговору тогда вернуться, —
 * список живёт в памяти процесса и нарочно не пишется на диск: писать в ту
 * самую базу, которая только что не ответила, смысла нет. Перезапуск
 * приложения до следующего сообщения отсрочку теряет — остаток дыры, но от
 * прежнего «навсегда и молча» он отличается на порядок.
 */
const pendingKeys = new Set<string>();

const pendingKey = (profileId: number, contactPubB64: string): string =>
  `${profileId}\u0000${contactPubB64}`;

/** Запомнить, что умолчание этому разговору не досталось из-за отказа чтения. */
export function markDefaultDisappearPending(profileId: number, contactPubB64: string): void {
  pendingKeys.add(pendingKey(profileId, contactPubB64));
}

/** Задолжали ли этому разговору умолчание. */
export function isDefaultDisappearPending(profileId: number, contactPubB64: string): boolean {
  return pendingKeys.has(pendingKey(profileId, contactPubB64));
}

/** Долг закрыт: настройку прочитали или человек выбрал таймер сам. */
export function clearDefaultDisappearPending(profileId: number, contactPubB64: string): void {
  pendingKeys.delete(pendingKey(profileId, contactPubB64));
}

/** То же у активного профиля — для экрана настроек. */
export async function getDefaultDisappearMs(): Promise<number | null> {
  return getDefaultDisappearMsFor(activeProfileId());
}

/** Исход чтения у активного профиля — см. getDefaultDisappearMsReadFor. */
export async function getDefaultDisappearMsRead(): Promise<{ ms: number | null } | null> {
  return getDefaultDisappearMsReadFor(activeProfileId());
}

/**
 * Пишет значение названному профилю и обновляет его кэш.
 *
 * v4.32.811. Кэш ставился ПЕРЕД записью, а сама запись шла через
 * `scopedKvSetFor` — `Promise<void>` поверх проверяемой, то есть ответ базы
 * терялся дважды. Пока приложение не перезапускали, всё выглядело сделанным:
 * кэш отвечал новым значением на каждое `touchConversation`. После перезапуска
 * кэш собирался заново с диска, а там лежало прежнее.
 *
 * Это единственная настройка, по которой переписка УДАЛЯЕТСЯ, и опасны обе
 * стороны. Поставил «1 день», запись не легла — новые разговоры живут вечно, а
 * человек уверен, что они исчезают, и пишет соответственно. Поставил «Выкл»,
 * запись не легла — новые разговоры продолжают удаляться, и узнают об этом,
 * когда искать удалённое уже негде.
 *
 * Поэтому кэш теперь ставится ПОСЛЕ удачной записи, а при отказе сбрасывается:
 * ответ в памяти обязан совпадать с тем, что лежит на диске, даже ценой лишнего
 * чтения. Ответ `false` уходит вызывающему — экран возвращает выбор на место.
 */
export async function setDefaultDisappearMsFor(
  profileId: number,
  ms: number | null
): Promise<boolean> {
  const written = await scopedKvSetCheckedFor(profileId, DEFAULT_AUTO_DELETE_KEY, String(ms ?? 0));
  if (written) cache.set(profileId, ms != null && ms > 0 ? ms : null);
  else cache.delete(profileId);
  return written;
}

/** То же у активного профиля. */
export async function setDefaultDisappearMs(ms: number | null): Promise<boolean> {
  return setDefaultDisappearMsFor(activeProfileId(), ms);
}

/**
 * Забыть значение профиля. Зовётся уборкой удалённого аккаунта: записи в базе
 * сметены, а кэш в памяти пережил бы удаление и достался новому профилю с тем
 * же номером.
 */
export function forgetDefaultDisappear(profileId: number): void {
  cache.delete(profileId);
  // Долги удалённого профиля уходят вместе с ним: иначе они достались бы
  // новому профилю с тем же номером и его разговорам с теми же контактами.
  const prefix = `${profileId}\u0000`;
  for (const k of [...pendingKeys]) if (k.startsWith(prefix)) pendingKeys.delete(k);
}

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}
