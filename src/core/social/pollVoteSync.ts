/**
 * pollVoteSync — отправка и применение голосов в опросах между устройствами.
 *
 * v4.32.250. Разбор конверта живёт в pollVoteEnvelope.ts (без импортов, чтобы
 * тестировался отдельно); здесь — запись в БД и доставка.
 *
 * Личка: конверт уходит одному собеседнику.
 * Группа: fanout по всем участникам, кроме забаненных и самого голосующего —
 * ровно как для реакций (групп-чат в этом проекте это набор личных DM, общего
 * канала нет).
 */

import { profileManager } from '../identity/profileManager';
import {
  deletePollVote,
  getChatMessageAuthor,
  getChatMessageTarget,
  getGroupMessageTarget,
  listGroupMembers,
  notifyChatStorageChanged,
  setPollVote,
} from '../storage/local';
import { scopedKvGetFor, scopedKvSetFor } from '../storage/profileScopedKv';
import { pollClosedKey } from '../storage/kvKeys';
import { checkIncomingPollVote, type PollMessageFacts } from './pollVoteGuard';
import {
  createPendingPollVotes,
  isRetriablePollVoteCode,
  type ParkedVote,
} from './pollVotePending';
import {
  activeRecipients,
  fanoutControlEnvelope,
  undeliveredText,
  type FanoutResult,
  type FanoutUndelivered,
} from './controlFanout';
import { canApplyGroupMessageOp, canInteractInGroup } from './groupSendPolicy';
import { lookupGroupActor, roleOf } from './groupActor';
import { log } from '../logger';
import {
  POLL_CLOSE_PREFIX,
  POLL_VOTE_PREFIX,
  encodePollCloseEnvelope,
  encodePollVoteEnvelope,
  decodePollCloseEnvelope,
  decodePollVoteEnvelope,
  type PollCloseEnvelope,
  type PollVoteEnvelope,
} from './pollVoteEnvelope';

export {
  POLL_VOTE_PREFIX,
  POLL_CLOSE_PREFIX,
  encodePollVoteEnvelope,
  decodePollVoteEnvelope,
  encodePollCloseEnvelope,
  decodePollCloseEnvelope,
};
export type { PollVoteEnvelope, PollCloseEnvelope };

/**
 * Ключ в kv, которым помечен завершённый опрос.
 *
 * v4.32.484: читается и пишется в namespace профиля. Имя состояло из одного
 * id сообщения, а в группе, где человек состоит двумя аккаунтами, id общие:
 * завершение опроса в одном аккаунте закрывало его и во втором — там кнопка
 * переставала принимать голос без всякого конверта. Уборка удалённого
 * профиля (`p<id>:%`) под общее имя не подпадала. Само имя переехало в
 * kvKeys — его набирает ещё и уборка следов опроса.
 */
export { pollClosedKey } from '../storage/kvKeys';

/**
 * Итог попытки проголосовать. Отказ обязан быть с причиной: без неё нажатие по
 * варианту просто ничего не делает, и понять почему — неоткуда.
 */
export type PollVoteResult = { ok: true } | { ok: false; reason: string };

/** Итог завершения опроса — той же формы, что и итог голоса. */
export type PollCloseResult = PollVoteResult;

/**
 * Почему конверт опроса никуда не ушёл.
 *
 * v4.32.446: до этой версии «разослал всем», «сервиса отправки нет» и «слать
 * некому» возвращались из castAndSyncPollVote одним и тем же `{ ok: true }`, а
 * из closeAndSyncPoll — одним и тем же ничем. Пузырь опроса в обоих случаях
 * молчал, а экраны поверх этого печатали «Опрос завершён». Голос при этом
 * записан только в свою БД, очереди повторной отправки у служебного конверта
 * нет — значит он не уйдёт уже никогда, а человек видит у себя +1 и уверен,
 * что то же самое видят остальные. Ровно эту поломку — «у автора закрыт, у
 * всех открыт» — чинила v4.32.251, и она возвращалась целиком, стоило сервису
 * отправки отсутствовать хоть секунду.
 *
 * v4.32.447: и сам разбор исхода, и рассылка переехали в controlFanout —
 * реакции повторяли ту же копию кода и отстали от этой правки на версию.
 */
export type PollUndelivered = FanoutUndelivered;

/** Итог доставки конверта опроса — общий для всех служебных конвертов. */
export type PollDelivery = FanoutResult;


/**
 * Записывает свой голос локально и рассылает конверт.
 *
 * `on: false` — голос снят (повторное нажатие по своему варианту).
 * peerPubB64 обязателен для личного опроса, groupId — для группового.
 */
export async function castAndSyncPollVote(params: {
  msgId: string;
  idx: number;
  on: boolean;
  multi: boolean;
  myPubB64: string;
  peerPubB64?: string;
  groupId?: string;
}): Promise<PollVoteResult> {
  const { msgId, idx, on, multi, myPubB64, peerPubB64, groupId } = params;
  const pid = profileManager.getActiveProfile()?.id ?? 1;

  // v4.32.273: закрытый опрос проверяется здесь, а не только кнопкой в пузыре.
  // Приёмная сторона такой голос отбрасывала с самого начала — значит без этой
  // проверки голос записывался ровно одному человеку, его автору: у себя он
  // видел +1, у всех остальных цифра не менялась.
  if ((await scopedKvGetFor(pid, pollClosedKey(msgId))) === '1') {
    return { ok: false, reason: 'Опрос завершён' };
  }

  // Роль в группе — до записи в свою БД. Проверка та же, что на приёме.
  const members = groupId ? await listGroupMembers(groupId, pid) : [];
  if (groupId) {
    const verdict = canInteractInGroup(roleOf(members, myPubB64));
    if (!verdict.allowed) {
      log.warn('poll_vote_denied', { gid: groupId.slice(0, 8), code: verdict.code });
      return { ok: false, reason: verdict.reason };
    }
  }

  // Локально — сразу: голос виден без ожидания сети, а при отказе отправки
  // конверт всё равно уйдёт из очереди сообщений позже.
  if (on) await setPollVote(msgId, myPubB64, idx, pid, multi);
  else await deletePollVote(msgId, myPubB64, idx, pid);

  const payload = encodePollVoteEnvelope({
    msgId,
    idx,
    on,
    multi,
    ts: Date.now(),
    ...(groupId ? { groupId } : {}),
  });
  const delivery = await fanoutControlEnvelope(
    'poll_vote',
    payload,
    groupId
      ? { kind: 'group', recipients: activeRecipients(members, myPubB64) }
      : { kind: 'dm', peerPubB64 }
  );
  if (!delivery.sent) {
    return { ok: false, reason: undeliveredText('Голос записан у вас', delivery.reason) };
  }
  return { ok: true };
}

/**
 * Применяет входящий конверт голоса. Возвращает true, если конверт наш
 * (независимо от того, применился он или был отброшен).
 */
export async function handleIncomingPollVote(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<boolean> {
  if (!text.startsWith(POLL_VOTE_PREFIX)) return false;
  const env = decodePollVoteEnvelope(text);
  if (!env || !senderPubB64) return true;
  // Профиль-владелец — от службы переписки (v4.32.481), см. handleIncomingReaction.
  await applyIncomingPollVote(env, senderPubB64, ownerPid, Date.now(), true);
  return true;
}

/**
 * v4.32.573: полка для голосов, обогнавших свой опрос, — см. pollVotePending.
 * Одна на процесс: голос кладут и снимают разные пути приёма.
 */
const pendingVotes = createPendingPollVotes();

/**
 * Общее тело применения голоса: и для только что пришедшего конверта, и для
 * снятого с полки. `canPark` не даёт снятому голосу лечь обратно на полку.
 */
async function applyIncomingPollVote(
  env: PollVoteEnvelope,
  senderPubB64: string,
  pid: number,
  now: number,
  canPark: boolean
): Promise<void> {
  if (env.groupId) {
    // Голос от не-участника — тот же анти-спуф, что и для реакций: иначе
    // посторонний, знающий id группы и сообщения, накручивает опрос всем.
    const actor = await lookupGroupActor(env.groupId, senderPubB64, pid);
    if (!actor.group) {
      log.debug('poll_vote_unknown_group', { gid: env.groupId.slice(0, 8) });
      return;
    }
    // v4.32.273: не только бан, но и read-only — тот же вердикт, что отправитель
    // проверяет у себя перед записью голоса.
    const verdict = canInteractInGroup(actor.role);
    if (!verdict.allowed) {
      log.warn('poll_vote_not_allowed_drop', {
        gid: env.groupId.slice(0, 8),
        from: senderPubB64.slice(0, 12),
        code: verdict.code,
      });
      return;
    }
  }

  // v4.32.252: в закрытый опрос голос не принимается. Свою кнопку блокирует
  // isClosed в пузыре, но по сети голос мог прийти от того, до кого конверт
  // завершения ещё не доехал (или не доедет — офлайн, старая версия), и
  // счётчики закрытого опроса продолжали бы расти.
  const closed = await scopedKvGetFor(pid, pollClosedKey(env.msgId));
  if (closed === '1') {
    log.debug('poll_vote_closed_drop', { from: senderPubB64.slice(0, 12) });
    return;
  }

  // v4.32.342: сам опрос, а не только конверт. До этого голос писался по любому
  // message_id, который назвали: проверка прав в группе стояла под `if
  // (env.groupId)`, и достаточно было не указать groupId, чтобы обойти её
  // целиком — строка ложилась та же самая. Разбор проверок — в pollVoteGuard.
  const facts: PollMessageFacts = env.groupId
    ? await groupFacts(env.msgId, pid)
    : await dmFacts(env.msgId, pid);
  const target = checkIncomingPollVote(facts, env, senderPubB64);
  if (!target.ok) {
    // v4.32.573: голос обгоняет свой опрос — конверт голоса маленький и едет
    // служебной дорогой, а сам опрос обычным сообщением. Раньше такой голос
    // отбрасывался навсегда, и счётчики опроса у разных людей расходились.
    if (canPark && isRetriablePollVoteCode(target.code)) {
      const vote: ParkedVote = {
        pid,
        msgId: env.msgId,
        senderPubB64,
        idx: env.idx,
        on: env.on,
        ...(env.groupId ? { groupId: env.groupId } : {}),
        ts: now,
      };
      if (pendingVotes.park(vote)) {
        log.info('poll_vote_parked', { from: senderPubB64.slice(0, 12), group: !!env.groupId });
        return;
      }
    }
    log.warn('poll_vote_target_drop', {
      from: senderPubB64.slice(0, 12),
      group: !!env.groupId,
      code: target.code,
    });
    return;
  }

  // Автор голоса берётся из ПОДПИСАННОГО отправителя DM, а не из конверта —
  // иначе любой мог бы проголосовать от чужого имени. allowMultiple — из текста
  // опроса, а не из конверта: с чужим multi: true хранилище не вытесняло
  // прошлый выбор, и один человек занимал все варианты одиночного опроса.
  if (env.on) await setPollVote(env.msgId, senderPubB64, env.idx, pid, target.allowMultiple);
  else await deletePollVote(env.msgId, senderPubB64, env.idx, pid);
  log.info('poll_vote_applied', { group: !!env.groupId, on: env.on });
}

/**
 * Снимает с полки голоса, ждавшие это сообщение, и применяет их.
 *
 * Зовут те, кто только что записал входящее сообщение-опрос: личный приём и
 * приём в группе. Все проверки прав проходят заново — на полке лежит конверт,
 * а не разрешение, — и второй раз на полку голос уже не ложится: сообщение
 * есть, а любой другой отказ со временем не меняется.
 */
export async function flushPendingPollVotes(
  msgId: string,
  pid: number,
  now: number = Date.now()
): Promise<number> {
  const votes = pendingVotes.take(msgId, pid, now);
  if (votes.length === 0) return 0;
  for (const v of votes) {
    await applyIncomingPollVote(
      {
        msgId: v.msgId,
        idx: v.idx,
        on: v.on,
        // multi из конверта не хранится и не используется: право решать,
        // вытеснять ли прошлый голос, даёт текст опроса (см. pollVoteGuard).
        multi: false,
        ts: v.ts,
        ...(v.groupId ? { groupId: v.groupId } : {}),
      },
      v.senderPubB64,
      pid,
      now,
      false
    );
  }
  log.info('poll_votes_flushed', { count: votes.length, msgId: msgId.slice(0, 8) });
  return votes.length;
}

async function groupFacts(msgId: string, pid: number): Promise<PollMessageFacts> {
  const row = await getGroupMessageTarget(msgId, pid);
  return row ? { kind: 'group', groupId: row.groupId, text: row.text } : { kind: 'missing' };
}

async function dmFacts(msgId: string, pid: number): Promise<PollMessageFacts> {
  const row = await getChatMessageTarget(msgId, pid);
  return row ? { kind: 'dm', contactPubB64: row.contactPubB64, text: row.text } : { kind: 'missing' };
}

/**
 * Помечает опрос завершённым локально и рассылает конверт.
 *
 * v4.32.251. Раньше «Завершить опрос» писал только ключ poll_closed_<id> в свою
 * kv: у автора опрос закрывался, у всех остальных оставался открытым, и они
 * продолжали голосовать. Права на закрытие проверяет вызывающий экран
 * (своё сообщение либо админ группы) — здесь же приёмная сторона проверяет их
 * заново, потому что конверт приходит из недоверенной сети.
 */
export async function closeAndSyncPoll(params: {
  msgId: string;
  myPubB64: string;
  peerPubB64?: string;
  groupId?: string;
}): Promise<PollCloseResult> {
  const { msgId, myPubB64, peerPubB64, groupId } = params;
  const pid = profileManager.getActiveProfile()?.id ?? 1;

  await scopedKvSetFor(pid, pollClosedKey(msgId), '1');
  notifyChatStorageChanged();

  const payload = encodePollCloseEnvelope({
    msgId,
    ts: Date.now(),
    ...(groupId ? { groupId } : {}),
  });
  const delivery = await fanoutControlEnvelope(
    'poll_close',
    payload,
    groupId
      ? { kind: 'group', recipients: activeRecipients(await listGroupMembers(groupId, pid), myPubB64) }
      : { kind: 'dm', peerPubB64 }
  );
  if (!delivery.sent) {
    return { ok: false, reason: undeliveredText('Опрос завершён у вас', delivery.reason) };
  }
  return { ok: true };
}

/**
 * Применяет входящий конверт завершения. Возвращает true, если конверт наш
 * (независимо от того, применился он или был отброшен).
 */
export async function handleIncomingPollClose(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<boolean> {
  if (!text.startsWith(POLL_CLOSE_PREFIX)) return false;
  const env = decodePollCloseEnvelope(text);
  if (!env || !senderPubB64) return true;
  // Профиль-владелец — от службы переписки (v4.32.481).
  const pid = ownerPid;

  if (env.groupId) {
    const actor = await lookupGroupActor(env.groupId, senderPubB64, pid);
    if (!actor.group) {
      log.debug('poll_close_unknown_group', { gid: env.groupId.slice(0, 8) });
      return true;
    }
    // Закрыть можно свой опрос либо любой, если ты админ группы — те же права,
    // что даёт кнопку в GroupsScreen. Без этой проверки рядовой участник гасил
    // бы чужой опрос всей группе одним конвертом.
    const target = await getGroupMessageTarget(env.msgId, pid);
    // Сообщения нет — закрывать нечего; иначе конвертами с выдуманными id
    // можно было бы засорять kv ключами poll_closed_*.
    if (!target) {
      log.debug('poll_close_unknown_message', { gid: env.groupId.slice(0, 8) });
      return true;
    }
    // v4.32.342: сообщение обязано быть из названной группы. Права проверялись
    // по env.groupId, а закрывался опрос по env.msgId — то есть админ своей
    // группы гасил любой опрос в любой чужой, зная только id сообщения.
    if (target.groupId !== env.groupId) {
      log.warn('poll_close_wrong_group_drop', {
        gid: env.groupId.slice(0, 8),
        from: senderPubB64.slice(0, 12),
      });
      return true;
    }
    // v4.32.429: тот же вердикт, что на удалении своего сообщения, и та же
    // функция. Раньше здесь стояли две проверки от руки — «не участник или
    // забанен» и собственное множество ['owner','admin'] — то есть четвёртая
    // копия правила «кто здесь модератор». Правило то же самое: убрать своё —
    // право автора в любой роли (read-only участнику незачем запрещать снимать
    // собственный опрос, ровно как удалять собственный текст), чужое — право
    // администрации.
    const verdict = canApplyGroupMessageOp({
      op: 'del',
      role: actor.role,
      isAuthor: target.senderPubB64 === senderPubB64,
      type: actor.group.type,
      adminOnlyPosting: actor.group.adminOnlyPosting,
    });
    if (!verdict.allowed) {
      log.warn('poll_close_not_allowed_drop', {
        gid: env.groupId.slice(0, 8),
        from: senderPubB64.slice(0, 12),
        code: verdict.code,
      });
      return true;
    }
  } else {
    // Личный опрос: закрыть его вправе только тот, кто его создал. direction
    // 'in' — сообщение пришло от собеседника, значит автор он.
    const author = await getChatMessageAuthor(env.msgId, pid);
    if (!author || author.direction !== 'in' || author.contactPubB64 !== senderPubB64) {
      log.warn('poll_close_not_author_drop', { from: senderPubB64.slice(0, 12) });
      return true;
    }
  }

  await scopedKvSetFor(pid, pollClosedKey(env.msgId), '1');
  // Запись в kv не будит подписчиков chat-writes, а пузырь опроса перечитывает флаг
  // именно по ним — без этого закрытие увидели бы только после перезахода в чат.
  notifyChatStorageChanged();
  log.info('poll_close_applied', { group: !!env.groupId });
  return true;
}
