/**
 * Записи kv, которые до разделения на профили были общими для устройства и
 * действовали во всех аккаунтах сразу: заглушённые авторы ленты (v4.32.293),
 * названия папок чатов (v4.32.294).
 *
 * Правило переноса у них одно, и оно отличается от kvGetSecretScoped: там
 * старая запись достаётся первому, кто её прочитает, и из общей области
 * исчезает (так и надо для корзины и заметок — они про конкретную переписку и
 * принадлежат кому-то одному). Здесь запись действовала везде, поэтому отдать
 * её одному профилю значит для остальных молча отменить их же настройку.
 * Копируем каждому, общую убираем только когда копия легла всем.
 *
 * Пока profileManager не поднялся, не трогаем ничего: неизвестно, кому
 * копировать, а стереть — необратимо.
 */
import { profileManager } from '../identity/profileManager';
import { profileScopedKey } from './kvKeys';
import { kvDelete, kvGet, kvGetSecret, kvSetSecret } from './local';

/** Номер активного профиля или null, если менеджер профилей ещё не поднялся. */
export function activeProfileIdOrNull(): number | null {
  return profileManager.getActiveProfile()?.id ?? null;
}

/**
 * Прочитать запись профиля, попутно перенеся общую (если она ещё есть).
 * Возвращает сырую строку — разбор и границы остаются за вызывающим, они у
 * каждой записи свои.
 */
export async function readProfileSharedSecret(key: string): Promise<string | null> {
  const pid = activeProfileIdOrNull();
  const own = pid == null ? null : await kvGetSecret(profileScopedKey(pid, key));
  // Общую запись разбираем даже когда своя уже есть: перенести её надо всем
  // профилям, а не только тому, кто первым открыл нужный экран.
  const shared = await kvGet(key);
  if (shared != null) await copySharedToProfiles(key, shared);
  return own ?? shared;
}

async function copySharedToProfiles(key: string, value: string): Promise<void> {
  const profileIds = profileManager.getProfileIds();
  if (profileIds.length === 0) return;
  let copiedEverywhere = true;
  for (const id of profileIds) {
    const scoped = profileScopedKey(id, key);
    if ((await kvGet(scoped)) != null) continue;
    if (!(await kvSetSecret(scoped, value))) copiedEverywhere = false;
  }
  if (copiedEverywhere) await kvDelete(key);
}

/** Записать в namespace активного профиля. false — не записалось (или профиля нет). */
export async function writeProfileSharedSecret(key: string, value: string): Promise<boolean> {
  const pid = activeProfileIdOrNull();
  if (pid == null) return false;
  return await kvSetSecret(profileScopedKey(pid, key), value);
}
