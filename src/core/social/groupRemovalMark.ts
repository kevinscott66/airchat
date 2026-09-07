/**
 * Пометка «этого человека из группы исключили» (v4.32.618).
 *
 * Дыра, которую она закрывает. Конверт op:'kick' удаляет строку из
 * group_members — и вместе с ней исчезает всякая память о том, что человек
 * тут был. А конверт op:'join' («я вступил по ссылке») применяется без
 * проверки прав: представить можно только себя, и решение принимает
 * decideJoin по НАШЕЙ таблице участников. Роль незнакомая — значит новый.
 *
 * Дальше расходятся две картины мира. Пригласительный токен есть только у
 * администраторов, у обычного участника его нет никогда — decideInviteToken
 * отдаёт ему 'unenforceable', и inviteTokenBlocks такой вердикт пропускает
 * (иначе группы, созданные до появления токенов, никого бы не принимали).
 * Значит исключённый, переслав себе старую ссылку, возвращается к КАЖДОМУ,
 * у кого нет токена, — то есть ко всем, кроме администраторов. Он снова
 * участник для большинства группы, его сообщения проходят анти-спуф-фильтр,
 * а администраторы его не видят и удивляются чужим ответам на пустоту.
 *
 * Почему не «пусть не-администраторы игнорируют голый join»: ровно это и
 * было до v4.32.231 и стоило CRIT — новичок оказывался немым у всех сразу.
 *
 * Поэтому память об исключении хранится явно и отдельно от состава: строки в
 * group_members больше нет, а отметка есть. Исключённый по ней не
 * возвращается сам — он попадает в заявки к администратору, который его и
 * убирал. Отметку снимает обратное действие администратора (add, unban).
 *
 * Ключ профильный (profileScopedKv), как и водяные знаки: аккаунты на одном
 * устройстве не должны делить чёрные списки, а при удалении профиля отметки
 * уезжают вместе с `p<id>:%`.
 */
import { scopedKvDeleteFor, scopedKvSetFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { log } from '../logger';

export const REMOVAL_MARK_PREFIX = 'grp_removed_v1:';

/**
 * Идентификатор группы идёт ПОСЛЕДНИМ по той же причине, что и в
 * groupWatermarkKey: кодек ограничивает его только длиной, двоеточие внутри
 * допустимо. Ключ участника — base64, двоеточий в нём не бывает.
 */
export function removalMarkKey(peerPubB64: string, groupId: string): string {
  return `${REMOVAL_MARK_PREFIX}${peerPubB64}:${groupId}`;
}

/** Запомнить исключение. Ошибка записи не должна ронять разбор конверта. */
export async function markGroupRemoval(
  groupId: string,
  peerPubB64: string,
  pid: number,
  ts: number
): Promise<void> {
  try {
    await scopedKvSetFor(pid, removalMarkKey(peerPubB64, groupId), String(Math.floor(ts)));
  } catch (e) {
    log.warn('group_removal_mark_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Снять отметку: администратор вернул человека в группу. */
export async function clearGroupRemoval(
  groupId: string,
  peerPubB64: string,
  pid: number
): Promise<void> {
  try {
    await scopedKvDeleteFor(pid, removalMarkKey(peerPubB64, groupId));
  } catch (e) {
    log.warn('group_removal_clear_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Исключали ли этого человека отсюда.
 *
 * Нечитаемая база — «не исключали»: отметки нет, и придумывать её нельзя.
 * Отказ в обратную сторону загнал бы в заявки всех подряд на устройстве, где
 * kv временно недоступна, а это уже отказ группе в приёме новых участников.
 */
export async function wasRemovedFromGroup(
  groupId: string,
  peerPubB64: string,
  pid: number
): Promise<boolean> {
  try {
    const got = await scopedKvTryGetFor(pid, removalMarkKey(peerPubB64, groupId));
    if (got === null) {
      log.warn('group_removal_read_failed', {});
      return false;
    }
    return got.value !== null;
  } catch (e) {
    log.warn('group_removal_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
