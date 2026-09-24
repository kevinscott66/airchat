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
  getChatMessageAuthorRead,
  getChatMessageTargetRead,
  getGroupMessageTargetRead,
  listGroupMembersRead,
  notifyChatStorageChanged,
  setPollVote,
} from '../storage/local';
import { lookupValue } from '../utils/lookupResult';
import { scopedKvSetCheckedFor, scopedKvTryGetFor } from '../storage/profileScopedKv';
import { pollClosedKey } from '../storage/kvKeys';
import { checkIncomingPollVote, type PollMessageFacts } from './pollVoteGuard';
import {
  createPendingPollCloses,
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
import { commitPollVoteTs, pollVoteTsFresh } from './controlWatermark';
import { canApplyGroupMessageOp, canInteractInGroup } from './groupSendPolicy';
import { lookupGroupActorRead, roleOf } from './groupActor';
import type { EnvelopeIntake } from '../transport/envelopeIntake';
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
 * Отказ, когда состояние опроса неизвестно.
 *
 * v4.32.644: до этой версии флаг «завершён» читался через scopedKvGetFor,
 * который отдаёт null и на «флага нет», и на «прочитать не удалось». Сбой базы
 * означал «опрос открыт», и голос уходил в завершённый опрос: у себя человек
 * видел +1, а все, у кого флаг прочитался, тот же конверт отбрасывали — ровно
 * то расхождение, которое чинила v4.32.273. На входящем пути это вдобавок
 * рычаг в чужих руках: голос в закрытый опрос попадал бы в счётчики, если у
 * принимающего в этот миг не прочиталась одна строка kv.
 *
 * Цена отказа мала: чтение стоит непосредственно перед записью голоса в ту же
 * базу — если не прочиталось, записать почти наверняка тоже не выйдет.
 */
const POLL_STATE_UNKNOWN = 'Не удалось проверить, не завершён ли опрос. Попробуйте ещё раз.';
/**
 * Состав группы не прочитался (v4.32.648).
 *
 * Пустой состав — законный ответ, и по нему делаются два вывода: «вас нет
 * среди участников» и «рассылать некому». Сбой чтения давал ровно такой же
 * пустой список, то есть один заблокированный миг базы отказывал человеку в
 * голосе в его собственной группе, а завершение опроса объявлял разосланным,
 * не отправив ничего.
 */
const MEMBERS_UNKNOWN = 'Не удалось прочитать состав группы. Попробуйте ещё раз.';

/** Завершён ли опрос. `null` — прочитать не удалось, см. POLL_STATE_UNKNOWN. */
async function pollIsClosed(pid: number, msgId: string): Promise<boolean | null> {
  const read = await scopedKvTryGetFor(pid, pollClosedKey(msgId));
  if (read === null) return null;
  return read.value === '1';
}


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
  const closed = await pollIsClosed(pid, msgId);
  if (closed === null) {
    log.warn('poll_closed_read_failed', { pid });
    return { ok: false, reason: POLL_STATE_UNKNOWN };
  }
  if (closed) {
    return { ok: false, reason: 'Опрос завершён' };
  }

  // Роль в группе — до записи в свою БД. Проверка та же, что на приёме.
  // v4.32.648: состав, который не прочитался, — не пустая группа.
  const members = groupId ? await listGroupMembersRead(groupId, pid) : [];
  if (members === null) {
    log.warn('poll_vote_members_read_failed', { gid: groupId?.slice(0, 8) });
    return { ok: false, reason: MEMBERS_UNKNOWN };
  }
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
 * Применяет входящий конверт голоса.
 *
 * v4.32.755: отвечает словом, а не `true`. Прежний `boolean` значил «конверт
 * наш», и развилка в messaging.ts его не читала — кадр объявлялся разобранным
 * при любом исходе, метка «докуда прочитано» шла дальше, и relay свой кадр
 * больше не отдавал. Голос пропадал совсем: счётчики у двух людей расходились,
 * и ни один экран об этом не говорил. Тот же приём, что у реакции в v4.32.754.
 */
export async function handleIncomingPollVote(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<EnvelopeIntake> {
  if (!text.startsWith(POLL_VOTE_PREFIX)) return 'consumed';
  const env = decodePollVoteEnvelope(text);
  if (!env || !senderPubB64) return 'consumed';
  // Профиль-владелец — от службы переписки (v4.32.481), см. handleIncomingReaction.
  return await applyIncomingPollVote(env, senderPubB64, ownerPid, Date.now(), true);
}

/**
 * v4.32.573: полка для голосов, обогнавших свой опрос, — см. pollVotePending.
 * Одна на процесс: голос кладут и снимают разные пути приёма.
 */
const pendingVotes = createPendingPollVotes();

/**
 * Общее тело применения голоса: и для только что пришедшего конверта, и для
 * снятого с полки. `canPark` не даёт снятому голосу лечь обратно на полку.
 *
 * v4.32.755: отвечает исходом приёма. Снятому с полки голосу этот ответ ни к
 * чему — его кадр разобран давно, и метка по нему уже прошла; `deferred` там
 * значит лишь «во второй раз тоже не вышло», и смотреть на него некому.
 */
async function applyIncomingPollVote(
  env: PollVoteEnvelope,
  senderPubB64: string,
  pid: number,
  now: number,
  canPark: boolean
): Promise<EnvelopeIntake> {
  if (env.groupId) {
    // Голос от не-участника — тот же анти-спуф, что и для реакций: иначе
    // посторонний, знающий id группы и сообщения, накручивает опрос всем.
    //
    // v4.32.755: чтение различающее. Схлопывающая форма объявляла группу
    // незнакомой по отказу базы, и голос участника пропадал молча.
    const actor = await lookupGroupActorRead(env.groupId, senderPubB64, pid);
    if (!actor) {
      log.warn('poll_vote_group_unreadable', { gid: env.groupId.slice(0, 8) });
      return 'deferred';
    }
    if (!actor.group) {
      log.debug('poll_vote_unknown_group', { gid: env.groupId.slice(0, 8) });
      return 'consumed';
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
      return 'consumed';
    }
  }

  // v4.32.252: в закрытый опрос голос не принимается. Свою кнопку блокирует
  // isClosed в пузыре, но по сети голос мог прийти от того, до кого конверт
  // завершения ещё не доехал (или не доедет — офлайн, старая версия), и
  // счётчики закрытого опроса продолжали бы расти.
  const closed = await pollIsClosed(pid, env.msgId);
  if (closed === null) {
    // v4.32.755: прочитать флаг не вышло — это отказ kv, и он пройдёт сам.
    // Раньше голос на нём отбрасывался навсегда: осторожность на месте (в
    // закрытый опрос голос не принимаем), а цена у неё была та же, что у
    // потери.
    log.warn('poll_vote_closed_unknown_drop', { from: senderPubB64.slice(0, 12) });
    return 'deferred';
  }
  if (closed) {
    log.debug('poll_vote_closed_drop', { from: senderPubB64.slice(0, 12) });
    return 'consumed';
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
        // Голос лежит на полке и будет применён, когда придёт сам опрос:
        // держать за него ещё и метку незачем, кадр своё дело сделал.
        return 'consumed';
      }
    }
    log.warn('poll_vote_target_drop', {
      from: senderPubB64.slice(0, 12),
      group: !!env.groupId,
      code: target.code,
    });
    // v4.32.763: «базу не спросили» — единственный из шести отказов, который
    // проходит сам. Остальные пять постоянны, и вторая попытка их не изменит.
    return target.code === 'read_failed' ? 'deferred' : 'consumed';
  }

  // Автор голоса берётся из ПОДПИСАННОГО отправителя DM, а не из конверта —
  // иначе любой мог бы проголосовать от чужого имени. allowMultiple — из текста
  // опроса, а не из конверта: с чужим multi: true хранилище не вытесняло
  // прошлый выбор, и один человек занимал все варианты одиночного опроса.
  //
  // v4.32.755: отказ самой записи — тоже «сейчас не смогли». Обе функции на
  // упавшем запросе бросают, и раньше это исключение уходило сквозь развилку
  // в messaging наверх, где приёмник кадра ловил его общей ловушкой. Исход был
  // верный по случайности; теперь он назван, а снятому с полки голосу ловушка
  // по-прежнему нужна своя — она стоит в flushPendingPollVotes.
  // v4.32.794: знак свежести на тройку «голосующий + вариант + сообщение».
  // Голос — переключатель, и повтор перехваченного кадра его двигает. В
  // одиночном опросе это не добавление, а подмена: setPollVote вытесняет
  // прошлый выбор, поэтому сохранённый кадр «за A» стирает тот вариант, за
  // который человек проголосовал потом. Сдвиг знака — ниже, после удавшейся
  // записи: обе причины отказа проходят сами, и хоронить перезапрос нельзя.
  if (!(await pollVoteTsFresh(senderPubB64, env.idx, env.msgId, pid, env.ts))) {
    log.info('poll_vote_stale_drop', { from: senderPubB64.slice(0, 12), idx: env.idx });
    return 'consumed';
  }
  try {
    if (env.on) await setPollVote(env.msgId, senderPubB64, env.idx, pid, target.allowMultiple);
    else await deletePollVote(env.msgId, senderPubB64, env.idx, pid);
  } catch (e) {
    log.warn('poll_vote_write_failed', {
      from: senderPubB64.slice(0, 12),
      err: e instanceof Error ? e.message : String(e),
    });
    return 'deferred';
  }
  await commitPollVoteTs(senderPubB64, env.idx, env.msgId, pid, env.ts);
  log.info('poll_vote_applied', { group: !!env.groupId, on: env.on });
  return 'consumed';
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
  let applied = 0;
  let failed = 0;
  for (const v of votes) {
    // v4.32.623: отказ на одном голосе больше не уносит остальные. Голоса уже
    // сняты с полки строкой выше (take), и обратно они не лягут — значит
    // исключение на середине списка теряло безвозвратно весь его хвост, и
    // теряло молча: вызывающие пишут в журнал один общий poll_vote_flush_failed.
    try {
      // v4.32.755: отказ записи теперь называется словом, а не исключением, и
      // счётчик обязан его увидеть — иначе «применено N» включало бы голоса,
      // которые никуда не легли, и строка poll_votes_flushed врала бы.
      const intake = await applyIncomingPollVote(
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
      if (intake === 'deferred') failed += 1;
      else applied += 1;
    } catch (e) {
      failed += 1;
      log.warn('poll_vote_apply_failed', {
        msgId: v.msgId.slice(0, 8),
        from: v.senderPubB64.slice(0, 12),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  log.info('poll_votes_flushed', { count: applied, failed, msgId: msgId.slice(0, 8) });
  return applied;
}

/**
 * Снимает с полки завершения, ждавшие это сообщение, и применяет их
 * (v4.32.764).
 *
 * Права проверяются заново, как и у голосов. Второй раз на полку конверт не
 * ложится: сообщение есть, а любой другой отказ со временем не меняется.
 */
export async function flushPendingPollCloses(
  msgId: string,
  pid: number,
  now: number = Date.now()
): Promise<number> {
  const closes = pendingCloses.take(msgId, pid, now);
  if (closes.length === 0) return 0;
  let applied = 0;
  let failed = 0;
  for (const c of closes) {
    // Отказ на одном конверте не уносит остальные — то же правило, что у
    // голосов в v4.32.623: сняты они уже все и обратно не лягут.
    try {
      const intake = await applyIncomingPollClose(
        { msgId: c.msgId, ts: c.ts, ...(c.groupId ? { groupId: c.groupId } : {}) },
        c.senderPubB64,
        pid,
        now,
        false
      );
      if (intake === 'deferred') failed += 1;
      else applied += 1;
    } catch (e) {
      failed += 1;
      log.warn('poll_close_apply_failed', {
        msgId: c.msgId.slice(0, 8),
        from: c.senderPubB64.slice(0, 12),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  log.info('poll_closes_flushed', { count: applied, failed, msgId: msgId.slice(0, 8) });
  return applied;
}

/**
 * Разобрать полки обоих видов для только что записанного сообщения-опроса
 * (v4.32.764).
 *
 * Порядок не произволен: сперва голоса, потом завершение. Голоса отправлены
 * раньше завершения — иначе автор не смог бы его отправить, — и применённое
 * первым завершение отбросило бы их все как «в закрытый опрос». Обратный
 * порядок повторяет то, как события шли у отправителя.
 */
export async function flushPendingPollEnvelopes(
  msgId: string,
  pid: number,
  now: number = Date.now()
): Promise<void> {
  await flushPendingPollVotes(msgId, pid, now);
  await flushPendingPollCloses(msgId, pid, now);
}

/**
 * v4.32.763: обе читают различающей обёрткой. Прежние отдавали `null` и на
 * «такого сообщения нет», и на «базу не удалось спросить», а здесь из этого
 * `null` делался вывод `missing` — то есть «голос обогнал свой опрос, положить
 * на полку». Полка в этом случае — худший из возможных исходов: сообщение уже
 * лежит в базе, второй раз его никто не запишет, разбирать полку некому, и
 * голос умирает по сроку, но уже молча и с отметкой «конверт разобран».
 */
async function groupFacts(msgId: string, pid: number): Promise<PollMessageFacts> {
  const read = await getGroupMessageTargetRead(msgId, pid);
  if (read.state === 'failed') return { kind: 'failed' };
  if (read.state === 'missing') return { kind: 'missing' };
  return { kind: 'group', groupId: read.value.groupId, text: read.value.text };
}

async function dmFacts(msgId: string, pid: number): Promise<PollMessageFacts> {
  const read = await getChatMessageTargetRead(msgId, pid);
  if (read.state === 'failed') return { kind: 'failed' };
  if (read.state === 'missing') return { kind: 'missing' };
  return { kind: 'dm', contactPubB64: read.value.contactPubB64, text: read.value.text };
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

  // v4.32.648: состав читается ДО записи, по той же причине, по которой ниже
  // рассылка идёт после неё. Пустой состав — законный ответ, и рассылать тогда
  // правда некому; но сбой чтения давал такой же пустой список, а
  // fanoutControlEnvelope при нуле получателей считает отправку удавшейся —
  // человек видел «Опрос завершён» при живом опросе у всех остальных.
  const members = groupId ? await listGroupMembersRead(groupId, pid) : [];
  if (members === null) {
    log.warn('poll_close_members_read_failed', { gid: groupId?.slice(0, 8) });
    return { ok: false, reason: MEMBERS_UNKNOWN };
  }

  // v4.32.644: отказ записи — это отказ завершения. Незамеченным он печатал
  // «Опрос завершён» при живом у себя опросе, а конверт закрывал его всем
  // остальным: расхождение зеркально тому, что чинила v4.32.251. Рассылки до
  // удачной записи быть не должно — иначе закрытым он станет у кого угодно,
  // кроме автора.
  if (!(await scopedKvSetCheckedFor(pid, pollClosedKey(msgId), '1'))) {
    log.warn('poll_close_write_failed', { pid });
    return { ok: false, reason: 'Не удалось завершить опрос. Попробуйте ещё раз.' };
  }
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
      ? { kind: 'group', recipients: activeRecipients(members, myPubB64) }
      : { kind: 'dm', peerPubB64 }
  );
  if (!delivery.sent) {
    return { ok: false, reason: undeliveredText('Опрос завершён у вас', delivery.reason) };
  }
  return { ok: true };
}

/**
 * Применяет входящий конверт завершения.
 *
 * v4.32.755: отвечает словом, а не `true`. Завершение опроса — конверт без
 * повтора и без второй посылки: не применённый сейчас, он не применится
 * никогда. Опрос остаётся открытым у получателя, тот продолжает голосовать, а
 * его голоса на другой стороне отбрасываются как «в закрытый опрос» — расход,
 * который ни одна сторона не видит.
 */
export async function handleIncomingPollClose(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<EnvelopeIntake> {
  if (!text.startsWith(POLL_CLOSE_PREFIX)) return 'consumed';
  const env = decodePollCloseEnvelope(text);
  if (!env || !senderPubB64) return 'consumed';
  // Профиль-владелец — от службы переписки (v4.32.481).
  return await applyIncomingPollClose(env, senderPubB64, ownerPid, Date.now(), true);
}

/**
 * v4.32.764: полка для завершений, обогнавших свой опрос, — см.
 * pollVotePending. Одна на процесс, как и полка голосов.
 */
const pendingCloses = createPendingPollCloses();

/**
 * Общее тело применения завершения: и для только что пришедшего конверта, и
 * для снятого с полки. `canPark` не даёт снятому лечь обратно.
 *
 * v4.32.764. До этой версии завершение, для которого сообщения-опроса ещё нет,
 * отбрасывалось навсегда (`poll_close_unknown_message` в группе,
 * `poll_close_not_author_drop` в личном) — ровно та же ошибка, которую у голоса
 * исправили в v4.32.573, только дороже: опрос оставался открытым у получателя
 * до конца времён. Теперь конверт ждёт своё сообщение на полке, а все проверки
 * прав проходят заново при снятии: на полке лежит конверт, а не разрешение.
 */
async function applyIncomingPollClose(
  env: PollCloseEnvelope,
  senderPubB64: string,
  pid: number,
  now: number,
  canPark: boolean
): Promise<EnvelopeIntake> {
  /**
   * Отложить конверт до прихода самого опроса. Не вышло отложить — значит
   * конверт негоден, и держать его незачем: кадр разобран.
   */
  const parkOrDrop = (where: string): EnvelopeIntake => {
    if (canPark) {
      const parked = pendingCloses.park({
        pid,
        msgId: env.msgId,
        senderPubB64,
        ...(env.groupId ? { groupId: env.groupId } : {}),
        ts: now,
      });
      if (parked) {
        log.info('poll_close_parked', { from: senderPubB64.slice(0, 12), group: !!env.groupId });
        // Конверт лежит на полке и будет применён, когда придёт сам опрос:
        // держать за него ещё и метку «докуда прочитано» незачем.
        return 'consumed';
      }
    }
    log.debug(where, { from: senderPubB64.slice(0, 12), group: !!env.groupId });
    return 'consumed';
  };

  if (env.groupId) {
    // v4.32.755: различающее чтение — см. голос выше.
    const actor = await lookupGroupActorRead(env.groupId, senderPubB64, pid);
    if (!actor) {
      log.warn('poll_close_group_unreadable', { gid: env.groupId.slice(0, 8) });
      return 'deferred';
    }
    if (!actor.group) {
      log.debug('poll_close_unknown_group', { gid: env.groupId.slice(0, 8) });
      return 'consumed';
    }
    // Закрыть можно свой опрос либо любой, если ты админ группы — те же права,
    // что даёт кнопку в GroupsScreen. Без этой проверки рядовой участник гасил
    // бы чужой опрос всей группе одним конвертом.
    const targetRead = await getGroupMessageTargetRead(env.msgId, pid);
    // v4.32.763: отказ базы отвечал тем же `null`, что и «сообщения нет», и
    // завершение опроса терялось навсегда — ровно тот случай, ради которого в
    // v4.32.755 эта функция и начала отвечать словом.
    if (targetRead.state === 'failed') {
      log.warn('poll_close_message_unreadable', { gid: env.groupId.slice(0, 8) });
      return 'deferred';
    }
    // Сообщения нет — либо конверт обогнал свой опрос (тогда полка), либо id
    // выдуман (тогда полка его отсеет по сроку). Записывать флаг вслепую
    // по-прежнему нельзя: конвертами с выдуманными id засоряли бы kv ключами
    // poll_closed_*.
    if (targetRead.state === 'missing') {
      return parkOrDrop('poll_close_unknown_message');
    }
    const target = targetRead.value;
    // v4.32.342: сообщение обязано быть из названной группы. Права проверялись
    // по env.groupId, а закрывался опрос по env.msgId — то есть админ своей
    // группы гасил любой опрос в любой чужой, зная только id сообщения.
    if (target.groupId !== env.groupId) {
      log.warn('poll_close_wrong_group_drop', {
        gid: env.groupId.slice(0, 8),
        from: senderPubB64.slice(0, 12),
      });
      return 'consumed';
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
      return 'consumed';
    }
  } else {
    // Личный опрос: закрыть его вправе только тот, кто его создал. direction
    // 'in' — сообщение пришло от собеседника, значит автор он.
    const authorRead = await getChatMessageAuthorRead(env.msgId, pid);
    // v4.32.763: «не прочитали строку» — не «прислал не автор». Сплющенное
    // чтение уравнивало эти два случая, и занятая база отказывала в завершении
    // теми же словами, что и подделке, — навсегда и без следа для человека.
    if (authorRead.state === 'failed') {
      log.warn('poll_close_author_unreadable', { from: senderPubB64.slice(0, 12) });
      return 'deferred';
    }
    const author = lookupValue(authorRead);
    // v4.32.764: «строки ещё нет» и «прислал не автор» — разные вещи, а
    // отбрасывались они одинаково. Первое проходит само собой через секунду
    // (конверт обогнал свой опрос), второе не изменится никогда.
    if (!author) {
      return parkOrDrop('poll_close_unknown_message');
    }
    if (author.direction !== 'in' || author.contactPubB64 !== senderPubB64) {
      log.warn('poll_close_not_author_drop', { from: senderPubB64.slice(0, 12) });
      return 'consumed';
    }
  }

  // v4.32.644: конверт наш и разобран, но если запись не легла — опрос у нас
  // не закрылся. Строка «poll_close_applied» и побудка подписчиков соврали бы:
  // пузырь перечитал бы флаг и снова нашёл опрос открытым.
  // v4.32.755: и метку «докуда прочитано» двигать в этом случае нельзя. Отказ
  // kv пройдёт сам, а второй посылки у конверта завершения нет: разобранным
  // его объявляли молча, и опрос оставался открытым навсегда.
  if (!(await scopedKvSetCheckedFor(pid, pollClosedKey(env.msgId), '1'))) {
    log.warn('poll_close_not_applied', { group: !!env.groupId });
    return 'deferred';
  }
  // Запись в kv не будит подписчиков chat-writes, а пузырь опроса перечитывает флаг
  // именно по ним — без этого закрытие увидели бы только после перезахода в чат.
  notifyChatStorageChanged();
  log.info('poll_close_applied', { group: !!env.groupId });
  return 'consumed';
}
