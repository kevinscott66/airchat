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
import { recountGroupMembers, removeGroupMember } from '../storage/local';
import { scopedKvDeleteFor, scopedKvSetCheckedFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { createMarkFallback } from './markFallback';
import { log } from '../logger';

export const REMOVAL_MARK_PREFIX = 'grp_removed_v1:';

/** Исключения, о которых база отметку не приняла (v4.32.787). См. markFallback. */
const unsavedRemovals = createMarkFallback();

/** Ключ запаса: тот же, что и у базы, только без общего префикса. */
function fallbackKey(peerPubB64: string, groupId: string): string {
  return `${peerPubB64}:${groupId}`;
}

/**
 * Идентификатор группы идёт ПОСЛЕДНИМ по той же причине, что и в
 * groupWatermarkKey: кодек ограничивает его только длиной, двоеточие внутри
 * допустимо. Ключ участника — base64, двоеточий в нём не бывает.
 */
export function removalMarkKey(peerPubB64: string, groupId: string): string {
  return `${REMOVAL_MARK_PREFIX}${peerPubB64}:${groupId}`;
}

/**
 * Запомнить исключение. Ошибка записи не должна ронять разбор конверта.
 *
 * v4.32.787: писала гасящая `scopedKvSetFor` — та зовёт проверяемую и
 * выбрасывает её ответ, поэтому catch ниже не срабатывал никогда, и занятая
 * база стирала отметку молча. Исключённый возвращался по старой ссылке ко
 * всем, у кого нет пригласительного токена, то есть ко всем, кроме
 * администраторов. Теперь отказ виден, и не легшая отметка живёт в памяти
 * процесса до первого чтения.
 *
 * v4.32.817: отвечает словом, легла ли отметка НА ДИСК. Запас в памяти держит
 * её, пока приложение не закрыли, — а конверт-приглашение приходит когда
 * угодно, хоть через неделю. Позвавшему ответ нужен, чтобы отложить кадр:
 * пока он на relay, отметку есть чем починить, после `'consumed'` — нечем.
 */
export async function markGroupRemoval(
  groupId: string,
  peerPubB64: string,
  pid: number,
  ts: number
): Promise<boolean> {
  const at = Math.floor(ts);
  try {
    if (await scopedKvSetCheckedFor(pid, removalMarkKey(peerPubB64, groupId), String(at))) {
      unsavedRemovals.forget(pid, fallbackKey(peerPubB64, groupId));
      return true;
    }
  } catch (e) {
    log.warn('group_removal_mark_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  unsavedRemovals.remember(pid, fallbackKey(peerPubB64, groupId), at);
  log.warn('group_removal_mark_unsaved', { at });
  return false;
}

/** Дописать на диск отметку, которую база не приняла в прошлый раз. */
async function repairRemovalMark(
  groupId: string,
  peerPubB64: string,
  pid: number,
  at: number
): Promise<void> {
  try {
    if (await scopedKvSetCheckedFor(pid, removalMarkKey(peerPubB64, groupId), String(at))) {
      unsavedRemovals.forget(pid, fallbackKey(peerPubB64, groupId));
      log.info('group_removal_mark_repaired', { at });
    }
  } catch (e) {
    log.warn('group_removal_mark_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Исключить участника у СЕБЯ — отметка и состав вместе (v4.32.851).
 *
 * Дыра, которую закрывает. Отметку писала одна ветка: разбор входящего
 * конверта op:'kick'. У того, кто кик и затеял, её не писал никто — экран
 * групп звал `removeGroupMember` напрямую, а свой собственный конверт назад не
 * приходит. Получалось, что защита из groupRemovalMark.ts не работала ровно у
 * администратора: исключённый пересылал себе старую ссылку, его op:'join'
 * упирался в `wasRemovedFromGroup` у всех, кроме исключившего, — а у
 * исключившего проходил как вступление незнакомца и возвращал человека в
 * состав. Дальше администратор своим же конвертом op:'add' рассказывал об этом
 * остальным, и `clearGroupRemoval` в ветке 'add' стирал отметку у всей группы.
 * То есть чем выше права у обманутого, тем полнее возврат.
 *
 * Порядок тот же, что во входящей ветке: сначала отметка, потом состав. Обрыв
 * между ними оставит отметку на ещё состоящем участнике — он пойдёт в заявки
 * вместо прямого входа; обратный порядок оставил бы исключённого без отметки
 * вовсе, а это и есть дыра.
 *
 * Отвечает словом, легла ли отметка на диск. Отказ базы исключение не отменяет
 * — человек нажал кнопку, и оставлять его в группе было бы хуже, — но запас
 * держит отметку лишь до закрытия приложения, и об этом стоит сказать вслух.
 */
export async function kickGroupMemberLocally(
  groupId: string,
  peerPubB64: string,
  pid: number,
  ts: number = Date.now()
): Promise<boolean> {
  const marked = await markGroupRemoval(groupId, peerPubB64, pid, ts);
  await removeGroupMember(groupId, peerPubB64, pid);
  await recountGroupMembers(groupId, pid);
  return marked;
}

/** Снять отметку: администратор вернул человека в группу. */
export async function clearGroupRemoval(
  groupId: string,
  peerPubB64: string,
  pid: number
): Promise<void> {
  unsavedRemovals.forget(pid, fallbackKey(peerPubB64, groupId));
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
  // v4.32.787: отметка, не легшая на диск, отвечает наравне с диском. Заодно
  // пробуем дописать её: база могла освободиться, и тогда отметка переживёт
  // перезапуск.
  const kept = unsavedRemovals.pending(pid, fallbackKey(peerPubB64, groupId));
  if (kept !== null) {
    await repairRemovalMark(groupId, peerPubB64, pid, kept);
    return true;
  }
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
