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
import { cellTextOrNull } from './atRestCell';
import { profileScopedKey } from './kvKeys';
import { kvDelete, kvGetSecretCell, kvSetSecret, kvTryGet } from './local';

/** Номер активного профиля или null, если менеджер профилей ещё не поднялся. */
export function activeProfileIdOrNull(): number | null {
  return profileManager.getActiveProfile()?.id ?? null;
}

/**
 * Прочитать запись профиля, попутно перенеся общую (если она ещё есть).
 * Возвращает сырую строку — разбор и границы остаются за вызывающим, они у
 * каждой записи свои.
 *
 * `null` — не прочитали. v4.32.699: раньше здесь возвращалась просто строка, а
 * отказ базы приходил тем же null, что и «записи нет». Оба вызывающих — список
 * заглушённых авторов и названия папок чатов — перечитывают запись целиком,
 * меняют один элемент и кладут обратно ВСЮ. То есть неудачное чтение означало
 * «в списке никого» и следующая же запись оставляла в нём ровно один элемент:
 * человек снимал заглушение с одного автора и молча возвращал себе в ленту всех
 * остальных, а переименование одной папки стирало названия прочих.
 */
export async function tryReadProfileSharedSecret(
  key: string,
): Promise<{ value: string | null } | null> {
  const pid = activeProfileIdOrNull();
  let own: string | null = null;
  if (pid != null) {
    const cell = await kvGetSecretCell(profileScopedKey(pid, key));
    if (cell.state === 'unreadable') return null;
    own = cellTextOrNull(cell);
  }
  // Общую запись разбираем даже когда своя уже есть: перенести её надо всем
  // профилям, а не только тому, кто первым открыл нужный экран.
  const sharedRead = await kvTryGet(key);
  // Своя запись главнее общей, поэтому её достаточно. А вот когда своей нет,
  // непрочитанная общая — это неизвестность: вернуть «пусто» значит разрешить
  // вызывающему затереть ею то, что мы просто не увидели.
  if (sharedRead === null) return own == null ? null : { value: own };
  const shared = sharedRead.value;
  if (shared != null) await copySharedToProfiles(key, shared);
  return { value: own ?? shared };
}

/** То же чтение строкой: отсутствие и нечитаемость снова сливаются в null. */
export async function readProfileSharedSecret(key: string): Promise<string | null> {
  return (await tryReadProfileSharedSecret(key))?.value ?? null;
}

async function copySharedToProfiles(key: string, value: string): Promise<void> {
  const profileIds = profileManager.getProfileIds();
  if (profileIds.length === 0) return;
  let copiedEverywhere = true;
  for (const id of profileIds) {
    const scoped = profileScopedKey(id, key);
    // v4.32.699: kvTryGet, а не kvGet. Здесь спрашивают «есть ли уже копия у
    // этого профиля», и отказ базы отвечал на это «нет» — общая запись
    // устройства ложилась поверх собственного, уже перенесённого списка чужого
    // профиля. Не прочитав, ничего не пишем и общую запись сохраняем: перенос
    // повторится при следующем чтении.
    const existing = await kvTryGet(scoped);
    if (existing === null) {
      copiedEverywhere = false;
      continue;
    }
    if (existing.value !== null) continue;
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
