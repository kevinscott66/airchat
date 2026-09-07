/**
 * Пометка «из этой группы я вышел» (v4.32.621).
 *
 * Дыра, которую она закрывает. `invite` — единственная операция, применимая к
 * ещё не известной нам группе, и защита у неё ровно одна: `if (group) return
 * true` — «уже состоим, приглашение идемпотентно». Выход из группы удаляет
 * строку через `deleteGroup`, и после него `getGroup` отвечает null. То есть
 * условие идемпотентности перестаёт выполняться ровно у того, кто вышел.
 *
 * Реле хранит конверты тридцать суток, темы выводятся из открытых DID, писать
 * в них может кто угодно. Значит, любой, кто однажды видел приглашение (сам
 * приглашающий, соседний участник, посторонний со снимком трафика), может
 * прислать те же байты ещё раз — и группа появится на устройстве заново, с
 * прежним составом и прежними правами. `isInviteTrusted` этому не мешает:
 * приглашал-то обычно контакт, а контакту она доверяет по определению.
 *
 * Отличить повтор от нового приглашения можно по времени. Метку ставит
 * отправитель, и подделать её в ЧУЖОМ конверте нельзя — конверт подписан
 * целиком, повторяющий пересылает те же байты. Поэтому приглашение, чья метка
 * старше момента выхода, — это повтор прошлого, а не новое приглашение.
 *
 * Осознанные границы:
 *
 *   • Группы, покинутые до этой версии, отметки не имеют — их повтор по-прежнему
 *     проходит. Задним числом восстановить момент выхода не из чего.
 *   • Отметка живёт вечно, как и `grp_removed_v1:`. Её объём — по одному
 *     короткому числу на каждую покинутую группу, и снимается она законным
 *     новым приглашением.
 *   • Часы отправителя. Приглашение с меткой из прошлого (сбитые часы) будет
 *     отвергнуто; приглашающий увидит, что человек не появился, и позовёт
 *     снова. Обратная ошибка — принять повтор — необратима, потому что
 *     возвращает переписку и состав, от которых человек отказался.
 *
 * Ключ профильный (profileScopedKv): аккаунты на одном устройстве не делят
 * решения о выходе, а при удалении профиля отметки уезжают вместе с `p<id>:%`.
 */
import { scopedKvDeleteFor, scopedKvSetFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { log } from '../logger';

export const LEAVE_MARK_PREFIX = 'grp_left_v1:';

/** Ключ строится из одного идентификатора, поэтому порядок значения не имеет. */
export function leaveMarkKey(groupId: string): string {
  return `${LEAVE_MARK_PREFIX}${groupId}`;
}

/** Запомнить выход. Ошибка записи не должна мешать самому выходу. */
export async function markGroupLeft(groupId: string, pid: number, ts: number = Date.now()): Promise<void> {
  try {
    await scopedKvSetFor(pid, leaveMarkKey(groupId), String(Math.floor(ts)));
  } catch (e) {
    log.warn('group_leave_mark_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Снять отметку: пришло законное новое приглашение, и оно принято. */
export async function clearGroupLeft(groupId: string, pid: number): Promise<void> {
  try {
    await scopedKvDeleteFor(pid, leaveMarkKey(groupId));
  } catch (e) {
    log.warn('group_leave_clear_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Новее ли приглашение, чем выход из этой группы.
 *
 * Нечитаемая база — «новее» (пропускаем). У приглашения нет обратной связи:
 * отвергнутое молча, оно не порождает ни ошибки у отправителя, ни строки у
 * получателя — человек просто не появляется в группе, и никто не понимает
 * почему. Отказ в эту сторону на время недоступности kv отменил бы приём в
 * группы целиком. Ошибка в другую сторону видна и обратима: группа появилась,
 * из неё можно выйти снова.
 */
export async function inviteNewerThanLeave(groupId: string, pid: number, ts: number): Promise<boolean> {
  try {
    const got = await scopedKvTryGetFor(pid, leaveMarkKey(groupId));
    if (got === null) {
      log.warn('group_leave_read_failed', {});
      return true;
    }
    if (got.value === null) return true;
    const left = Number(got.value);
    if (!Number.isFinite(left)) return true;
    return ts > left;
  } catch (e) {
    log.warn('group_leave_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return true;
  }
}
