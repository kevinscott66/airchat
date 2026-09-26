/**
 * Чтение корзины «Недавно удалённые» (v4.32.992).
 *
 * Дефект. Оба экрана читали корзину через `kvGetSecretScoped`, а он сводит
 * `absent` и `unreadable` к одному `null` — и делает это намеренно:
 * `cellTextOrNull` прямо пишет, что читающим местам различие не нужно, «им
 * нечего показать в обоих случаях». Для реакций и для списка прочитавших это
 * правда. Для корзины — нет: пустота здесь не «нечего показать», а ответ, по
 * которому человек действует. Окно говорило «Нет удалённых сообщений» —
 * утверждение, которого никто не проверял.
 *
 * Цена. Корзина — последняя копия текста (см. v4.32.892 в GroupsScreen).
 * Человек, прочитавший «Нет удалённых сообщений», второй раз туда не пойдёт, а
 * запись живёт семь суток в группе и тридцать в переписке — после этого её
 * отсеет срок хранения, и открывать будет уже нечего. При этом сама запись на
 * месте: писать поверх нечитаемого запрещено с v4.32.552.
 *
 * Почему «попробуйте ещё раз», а не «ключ не вернётся». `unreadable` у
 * `kvGetSecretCell` — это три разных беды: база не ответила (`kvTryGet` вернул
 * null), ключ шифрования не достался, шифртекст не открылся нашим ключом.
 * Первые две проходят, третья нет, и различить их здесь нечем — значит нельзя
 * ни обещать «вернётся», ни хоронить.
 *
 * Разбор и срок хранения живут здесь же, а не в экранах: до этой версии они
 * были выписаны дважды и уже разъехались. В группе `JSON.parse` не проверял,
 * что вышел массив, а `.filter` стоял за пределами `try` — на объекте вместо
 * массива окно просто не открывалось, молча.
 */

import { kvGetSecretCellScoped } from './local';

/**
 * Что человек читает, когда корзину открыть не вышло.
 *
 * Первой строкой — отрицание ложного прочтения: «не значит, что она пуста».
 * Это единственное, чего человек не может увидеть сам, и ровно то, ради чего
 * вся правка. Обещания «восстановится» здесь нет — см. заголовок файла.
 */
export const RECENTLY_DELETED_UNREADABLE_TEXT =
  'Корзину не удалось открыть — это не значит, что она пуста. Удалённое не стёрто, ' +
  'но показать его сейчас нечем. Попробуйте открыть ещё раз.';

/** Прочиталась корзина (пусть и пустая) — или не прочиталась вовсе. */
export type RecentlyDeletedRead<T> = { ok: true; list: T[] } | { ok: false };

/**
 * Разбор записи корзины: чужое, битое и просроченное отсеивается, но молча —
 * это не отказ чтения, а обычная уборка.
 */
export function parseRecentlyDeleted<T extends { deletedAt: number }>(
  raw: string | null,
  ttlMs: number,
  now: number = Date.now(),
): T[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cutoff = now - ttlMs;
  return parsed.filter((x): x is T => {
    if (typeof x !== 'object' || x === null) return false;
    const at = (x as { deletedAt?: unknown }).deletedAt;
    return typeof at === 'number' && at > cutoff;
  });
}

/**
 * Прочитать корзину профиля по её ключу.
 *
 * `{ ok: false }` — «не знаем», и выдавать это за пустую корзину нельзя.
 */
export async function readRecentlyDeletedFor<T extends { deletedAt: number }>(
  profileId: number,
  key: string,
  ttlMs: number,
): Promise<RecentlyDeletedRead<T>> {
  const cell = await kvGetSecretCellScoped(profileId, key);
  if (cell.state === 'unreadable') return { ok: false };
  return { ok: true, list: parseRecentlyDeleted<T>(cell.state === 'plain' ? cell.text : null, ttlMs) };
}
