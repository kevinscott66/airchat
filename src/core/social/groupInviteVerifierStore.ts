/**
 * Отпечаток действующего пригласительного токена — на устройстве участника
 * (v4.32.1005).
 *
 * Зачем он здесь, а не в таблице групп. Отпечаток — не настройка группы и не
 * её содержимое: это то, чем ЭТО устройство сверяет чужие ссылки. Ровно как
 * водяные знаки конвертов и отметки об исключении (groupRemovalMark), он
 * profileScopedKv: аккаунты на одном устройстве не должны делить право
 * впускать, а при удалении профиля отпечатки уезжают вместе с `p<id>:%`.
 *
 * Почему не столбец `invite_token` рядом: в нём лежит сам токен, и хранить в
 * нём отпечаток значило бы отдать «Пригласительной ссылке» отпечаток вместо
 * токена — то есть выдавать ссылки, которые не пускают никуда.
 *
 * Тайны в отпечатке нет: подобрать по нему токен не за что, и потеря
 * отпечатка стоит не утечки, а возврата к прежнему поведению —
 * 'unenforceable', вход решает groupJoinPolicy. Поэтому обычная запись kv, а
 * не защищённая.
 */
import { scopedKvSetCheckedFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { isInviteVerifier } from './groupInviteToken';
import { log } from '../logger';

export const INVITE_VERIFIER_PREFIX = 'grp_invite_vfy_v1:';

/**
 * Идентификатор группы идёт последним по той же причине, что и в
 * removalMarkKey: кодек ограничивает его только длиной, двоеточие внутри
 * допустимо, и класть его в середину ключа нельзя.
 */
export function inviteVerifierKey(groupId: string): string {
  return `${INVITE_VERIFIER_PREFIX}${groupId}`;
}

/**
 * Запомнить отпечаток. Отвечает словом, легла ли запись НА ДИСК.
 *
 * Ответ нужен позвавшему, чтобы отложить кадр: конверт со сбросом ссылки
 * приходит один раз, повторов у служебного конверта нет, и не легший
 * отпечаток означал бы, что этот участник так и продолжит впускать по
 * отозванной ссылке — молча и навсегда. Пока кадр на relay, починить это есть
 * чем; после «разобрано» — нечем.
 */
export async function saveInviteVerifier(groupId: string, pid: number, verifier: string): Promise<boolean> {
  if (!isInviteVerifier(verifier)) return false;
  try {
    return await scopedKvSetCheckedFor(pid, inviteVerifierKey(groupId), verifier);
  } catch (e) {
    log.warn('group_invite_verifier_save_failed', {
      gid: groupId.slice(0, 8),
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Отпечаток группы, либо null — сверять нечем.
 *
 * Оба безответных случая сходятся в null намеренно, и это единственное место
 * во всём семействе чтений, где сводить их правильно: «отпечатка нет» и
 * «отпечаток не прочитался» дают один и тот же вердикт 'unenforceable'.
 * Разделять их значило бы завести третий исход, у которого нет своего
 * поведения, — а неверный он был бы дорог: отказ базы, понятый как
 * «запрещено», закрыл бы вход по ДЕЙСТВУЮЩЕЙ ссылке.
 */
export async function readInviteVerifier(groupId: string, pid: number): Promise<string | null> {
  try {
    const got = await scopedKvTryGetFor(pid, inviteVerifierKey(groupId));
    if (got === null) {
      log.warn('group_invite_verifier_unreadable', { gid: groupId.slice(0, 8) });
      return null;
    }
    return isInviteVerifier(got.value) ? got.value : null;
  } catch (e) {
    log.warn('group_invite_verifier_read_failed', {
      gid: groupId.slice(0, 8),
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
