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
import { scopedKvSetFor, scopedKvTryGetFor } from './profileScopedKv';
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

/** Автоудаление по умолчанию у названного профиля. */
export async function getDefaultDisappearMsFor(profileId: number): Promise<number | null> {
  const cached = cache.get(profileId);
  if (cached !== undefined) return cached;
  const got = await scopedKvTryGetFor(profileId, DEFAULT_AUTO_DELETE_KEY);
  // Провал чтения в кэш НЕ кладётся: раньше единственная ошибка SQLite на
  // старте означала «автоудаление выключено» до конца запуска приложения —
  // настройку молча отменяла случайность.
  if (got === null) return null;
  const value = parseAutoDeleteMs(got.value);
  cache.set(profileId, value);
  return value;
}

/** То же у активного профиля — для экрана настроек. */
export async function getDefaultDisappearMs(): Promise<number | null> {
  return getDefaultDisappearMsFor(activeProfileId());
}

/** Пишет значение названному профилю и обновляет его кэш. */
export async function setDefaultDisappearMsFor(
  profileId: number,
  ms: number | null
): Promise<void> {
  cache.set(profileId, ms != null && ms > 0 ? ms : null);
  await scopedKvSetFor(profileId, DEFAULT_AUTO_DELETE_KEY, String(ms ?? 0));
}

/** То же у активного профиля. */
export async function setDefaultDisappearMs(ms: number | null): Promise<void> {
  await setDefaultDisappearMsFor(activeProfileId(), ms);
}

/**
 * Забыть значение профиля. Зовётся уборкой удалённого аккаунта: записи в базе
 * сметены, а кэш в памяти пережил бы удаление и достался новому профилю с тем
 * же номером.
 */
export function forgetDefaultDisappear(profileId: number): void {
  cache.delete(profileId);
}

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}
