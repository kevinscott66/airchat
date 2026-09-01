/**
 * reactionSync — отправка и применение реакций между устройствами.
 *
 * v4.32.232. Разбор конверта живёт в reactionEnvelope.ts (без импортов, чтобы
 * тестировался отдельно); здесь — доставка и запись в БД.
 *
 * Личка: конверт уходит одному собеседнику.
 * Группа: fanout по всем участникам, кроме забаненных и самого автора —
 * ровно как для сообщений и управляющих конвертов (групп-чат в этом проекте
 * это набор личных DM, общего канала нет).
 */

import { profileManager } from '../identity/profileManager';
import { listGroupMembers, toggleReaction } from '../storage/local';
import { reactionWriteFailureText } from './reactionWrite';
import type { ReactionScope } from '../storage/reactionScope';
import {
  activeRecipients,
  fanoutControlEnvelope,
  undeliveredText,
} from './controlFanout';
import { canInteractInGroup } from './groupSendPolicy';
import { lookupGroupActor, roleOf } from './groupActor';
import { log } from '../logger';
import {
  REACTION_PREFIX,
  encodeReactionEnvelope,
  decodeReactionEnvelope,
  type ReactionEnvelope,
} from './reactionEnvelope';

export { REACTION_PREFIX, encodeReactionEnvelope, decodeReactionEnvelope };
export type { ReactionEnvelope };

/**
 * Base64 публичного ключа активного профиля — ключ автора в карте реакций.
 *
 * v4.32.480: берётся у profileManager, а не из хранилища ключей устройства.
 * Устройство отдаёт ключ, который переключение аккаунта перезаписывает
 * отдельным шагом, — а номер профиля рядом читался у profileManager. Между
 * двумя чтениями помещалось целое переключение, и реакция уходила в группу
 * под номером одного профиля и ключом другого.
 */
export async function myReactionKey(): Promise<string> {
  return profileManager.getActiveIdentity()?.myPubB64 ?? '';
}

/**
 * Итог переключения реакции.
 *
 * v4.32.447: раньше отсюда возвращалось `boolean | null`, и `null` значил
 * одновременно «личность не готова», «роль в группе запрещает», «собеседник не
 * определён» и «строки сообщения нет» — четыре разных отказа, о которых
 * человеку нельзя было сказать ничего, кроме молчания. Экран группы поэтому
 * держал собственную копию проверки роли, чтобы хоть её проговорить, и копия
 * читала своё, устаревающее состояние вместо базы.
 *
 * `warning` обязателен и у успеха: реакция записана у себя, но конверт мог
 * никуда не уйти — а очереди повторной отправки у служебного конверта нет.
 * Обязательное поле не даёт вызывающему снова «не заметить» этот случай.
 */
export type ReactionResult =
  | { ok: false; reason: string }
  | { ok: true; on: boolean; warning: string | null };

/**
 * Локально переключает реакцию и рассылает конверт.
 *
 * peerPubB64 обязателен для личной реакции, groupId — для групповой.
 */
export async function toggleAndSyncReaction(params: {
  msgId: string;
  emoji: string;
  peerPubB64?: string;
  groupId?: string;
}): Promise<ReactionResult> {
  const { msgId, emoji, peerPubB64, groupId } = params;
  // Номер профиля и ключ автора — одним чтением: см. getActiveIdentity.
  const me = profileManager.getActiveIdentity();
  const actorKey = me?.myPubB64 ?? '';
  if (!actorKey || !me) {
    log.warn('reaction_no_identity');
    return { ok: false, reason: 'Профиль ещё не готов — попробуйте ещё раз через секунду' };
  }
  const pid = me.pid;

  // v4.32.273: роль проверяется до записи в свою БД — тем же вердиктом, что
  // применяет приёмная сторона. Иначе read-only участник ставил реакцию, видел
  // её у себя, а у остальных её отбрасывали как чужую: расхождение без единого
  // признака отказа.
  const members = groupId ? await listGroupMembers(groupId, pid) : [];
  if (groupId) {
    const verdict = canInteractInGroup(roleOf(members, actorKey));
    if (!verdict.allowed) {
      log.warn('reaction_denied', { gid: groupId.slice(0, 8), code: verdict.code });
      return { ok: false, reason: verdict.reason };
    }
  }

  // v4.32.343: переписка теперь входит в условие запроса, а не подразумевается.
  // Собеседник нужен до записи: без него привязать реакцию не к чему, а раньше
  // его отсутствие обнаруживалось уже после того, как реакция легла в базу.
  const scope: ReactionScope | null = groupId
    ? { group: true, groupId, ownerProfileId: pid }
    : peerPubB64
      ? { group: false, contactPubB64: peerPubB64, ownerProfileId: pid }
      : null;
  if (!scope) {
    log.warn('reaction_no_peer', { msgId: msgId.slice(0, 8) });
    return { ok: false, reason: 'Не удалось привязать реакцию: собеседник не определён' };
  }

  // v4.32.599: здесь стояло единственное «Сообщение не найдено» на четыре
  // разных отказа записи. Человек читал про пропавшее сообщение, глядя прямо
  // на него, а настоящая беда — ключ, не открывающий столбец с реакциями, —
  // оставалась неназванной. Причину теперь называет сама запись.
  const res = await toggleReaction(msgId, emoji, actorKey, 'toggle', scope);
  if (!res.ok) return { ok: false, reason: reactionWriteFailureText(res.reason) };
  const on = res.on;

  const payload = encodeReactionEnvelope({ msgId, emoji, on, ts: Date.now(), ...(groupId ? { groupId } : {}) });
  // v4.32.447: рассылка — общая с опросами воронка. До неё «сервиса отправки
  // нет» здесь возвращалось тем же значением, что и «разослано всем»: реакция
  // оставалась только у автора, и ни один экран об этом не узнавал.
  const delivery = await fanoutControlEnvelope(
    'reaction',
    payload,
    scope.group
      ? { kind: 'group', recipients: activeRecipients(members, actorKey) }
      : { kind: 'dm', peerPubB64: scope.contactPubB64 }
  );
  return {
    ok: true,
    on,
    warning: delivery.sent
      ? null
      : undeliveredText(on ? 'Реакция поставлена у вас' : 'Реакция снята у вас', delivery.reason),
  };
}

/**
 * Применяет входящий конверт реакции. Возвращает true, если конверт наш
 * (независимо от того, применился он или был отброшен).
 */
export async function handleIncomingReaction(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<boolean> {
  if (!text.startsWith(REACTION_PREFIX)) return false;
  const env = decodeReactionEnvelope(text);
  if (!env || !senderPubB64) return true;
  // v4.32.481: профиль-владелец приходит от службы переписки, которая знает
  // его по своей паре ключей. Раньше он брался у глобального «активного», а
  // между расшифровкой конверта и записью в базу стоят await'ы — переключение
  // аккаунта помещалось туда целиком, и чужая реакция ложилась в переписку
  // другого профиля.
  const pid = ownerPid;

  if (env.groupId) {
    // Реакция от не-участника — тот же анти-спуф, что и для сообщений: иначе
    // посторонний, знающий id группы и сообщения, накручивает реакции всем.
    const actor = await lookupGroupActor(env.groupId, senderPubB64, pid);
    if (!actor.group) {
      log.debug('reaction_unknown_group', { gid: env.groupId.slice(0, 8) });
      return true;
    }
    const verdict = canInteractInGroup(actor.role);
    if (!verdict.allowed) {
      log.warn('reaction_not_allowed_drop', {
        gid: env.groupId.slice(0, 8),
        from: senderPubB64.slice(0, 12),
        code: verdict.code,
      });
      return true;
    }
  }

  // Ключ автора берём из ПОДПИСАННОГО отправителя DM, а не из конверта —
  // иначе любой мог бы поставить реакцию от чужого имени.
  //
  // v4.32.343: и переписку берём оттуда же. Права проверялись по env.groupId, а
  // строка правилась по env.msgId, и связи между ними не было: участник группы
  // А ставил реакцию на сообщение группы Б, зная только его id. В личной ветке
  // не проверялось ничего — контакт отмечался в переписке двух других людей.
  const scope: ReactionScope = env.groupId
    ? { group: true, groupId: env.groupId, ownerProfileId: pid }
    : { group: false, contactPubB64: senderPubB64, ownerProfileId: pid };
  const res = await toggleReaction(env.msgId, env.emoji, senderPubB64, env.on, scope);
  if (!res.ok) {
    // Чужую реакцию ронять молча можно — отвечать отправителю нечем. Но в
    // журнал причина попасть обязана: «не нашли сообщение» и «не открылся
    // столбец» требуют совершенно разных действий (v4.32.599).
    log.warn('reaction_target_drop', {
      from: senderPubB64.slice(0, 12),
      group: !!env.groupId,
      reason: res.reason,
    });
    return true;
  }
  log.info('reaction_applied', { group: !!env.groupId, on: env.on });
  return true;
}
