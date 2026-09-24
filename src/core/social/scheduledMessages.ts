/**
 * scheduledMessages — отправка сообщений по расписанию (аналог Telegram Scheduled Messages).
 *
 * - Пользователь задаёт время отправки; сообщение сохраняется в scheduled_messages.
 * - Фоновый таймер каждые 30 секунд проверяет due-сообщения и отправляет их.
 * - После отправки запись удаляется из таблицы.
 */

import { v4 as uuidv4 } from 'uuid';
import { profileManager } from '../identity/profileManager';
import { getMessagingService } from './messaging';
import {
  insertScheduledMessage,
  insertGroupMessageWithTouch,
  listDueScheduledMessages,
  deleteScheduledMessage,
  bumpScheduledAttemptChecked,
} from '../storage/local';
import { fanoutGroupMessage } from './groupMessaging';
import { groupSendProblem, groupSendProblemText } from './groupSendOutcome';
import { isPubKeyB64 } from '../crypto/pubKeyFormat';
import { log } from '../logger';
import { ErrorHandler, ErrorSeverity } from '../errorHandler';
import { isSendableMessageText } from './messageTextLimit';
import { decideScheduledSend, scheduledSenderLabel, shouldReportScheduledHold } from './scheduledDispatch';
import { getOwnDisplayNameFor } from '../identity/ownProfile';

const POLL_INTERVAL_MS = 30_000;
/**
 * Сколько раз пробовать, прежде чем бросить (v4.32.440, переписано в v4.32.835).
 *
 * Дефект. Мерой служил возраст: `Date.now() - msg.sendAt` больше пятнадцати
 * минут — строку снимаем. Возраст этот рос всегда, а пробовали отправить
 * только когда приложение открыто. Сообщение, назначенное на ночь, к утру
 * оказывалось «старым» на девять часов, и ПЕРВАЯ же его попытка — та самая,
 * что случается через полминуты после запуска, когда служба обмена ещё
 * поднимается, а сеть ещё в режиме только-из-кэша и `requireOnlineWrite`
 * бросает, — сразу перешагивала срок. Строку снимали вместе с текстом (своей
 * копии у отложенного сообщения нет нигде) и говорили «связи не было слишком
 * долго» про попытку, которой не было ни одной. Чем дольше человек откладывал
 * сообщение и чем дольше не открывал приложение, тем вернее оно пропадало.
 *
 * Правка. В таблице теперь есть столбец `attempts`, которого не было в
 * v4.32.440, — считаем попытки, а не часы. Тридцать попыток по тику раз в
 * полминуты — это те же пятнадцать минут для приложения, которое всё это
 * время работает, и ровно тридцать честных попыток для того, которое
 * открывают дважды в день. Правило по-прежнему одно на все три ветки.
 */
const ABANDON_AFTER_ATTEMPTS = 30;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

/**
 * Чей это профиль. `null` — активного нет, и угадывать нельзя.
 *
 * v4.32.668: во всех четырёх местах стояло `?? 1` — «активного нет, считаем,
 * что первый». Дороже всего это обходилось сторожу смены профиля в
 * `flushDueOnce`: он сравнивает `?? 1` с `?? 1`, поэтому у самого обычного
 * человека (единственный профиль, номер 1) выход из учётной записи посреди
 * прохода читался как «профиль тот же». Проход продолжал слать письма и
 * стирать строки уже разбираемым сервисом — ровно то, ради чего сторож и
 * заведён. Планирование при отсутствии профиля клало строку в расписание
 * первого. Лента отказалась угадывать номер профиля раньше
 * (`feed_storage_profile_unset` в feedService.ts); здесь то же правило.
 */
function activePid(): number | null {
  return profileManager.getActiveProfile()?.id ?? null;
}

/**
 * v4.32.709: сказать вслух, что отложенное сообщение не ушло и его больше нет.
 *
 * Все три ветки, где строка расписания снимается недоставленной, до сих пор
 * ограничивались строкой в лог. А снимается вместе с ней сам текст: своей
 * копии у отложенного сообщения нет нигде. Личную пишет sendMessage, но до
 * записи дело не доходит — requireOnlineWrite бросает раньше
 * (CACHE_ONLY_MODE); групповую пишет этот же проход, но только после удачной
 * рассылки. Из «Запланированных» сообщение пропадало ровно так же, как если
 * бы ушло, и человек имел все основания считать, что оно отправлено.
 *
 * Ни текста сообщения, ни ключа собеседника, ни номера группы сюда не кладём:
 * message и context уходят в Sentry (см. ErrorHandler).
 */
function reportScheduledLost(code: string, message: string): void {
  void ErrorHandler.getInstance().handle({
    code,
    message,
    severity: ErrorSeverity.ERROR,
    retryable: false,
  });
}

/** Schedule a DM to be sent at `sendAt` (unix ms). */
export async function scheduleMessage(
  contactPubB64: string,
  text: string,
  sendAt: number,
  mediaCids?: string | null
): Promise<string> {
  // v4.32.187 (Round-17 #6): input validation. Accepting arbitrary sendAt
  // (NaN/Infinity/past/year 3000), arbitrary text length (multi-MB row
  // retry-loops on flushDue hammering SQLite + network), and non-base64
  // contactPubB64 lets a buggy caller silently poison the scheduler.
  // v4.32.666: форма ключа — общее правило isPubKeyB64, а не длина.
  if (!isPubKeyB64(contactPubB64)) {
    throw new Error('invalid_contact_pub');
  }
  if (!isSendableMessageText(text)) {
    throw new Error('invalid_text_length');
  }
  if (!Number.isFinite(sendAt)) throw new Error('invalid_send_at');
  const now = Date.now();
  if (sendAt < now - 60_000 || sendAt > now + 365 * 86_400_000) {
    throw new Error('send_at_out_of_range');
  }
  const pid = activePid();
  if (pid === null) throw new Error('scheduled_profile_unset');
  const id = uuidv4();
  await insertScheduledMessage({
    id,
    contactPubB64,
    text,
    mediaCids: mediaCids ?? null,
    sendAt,
    ownerProfileId: pid,
    createdAt: Date.now(),
  });
  log.info('message_scheduled', { id: id.slice(0, 8), sendAt: new Date(sendAt).toISOString() });
  return id;
}

/** Schedule a group message to be sent at `sendAt` (unix ms). */
export async function scheduleGroupMessage(
  groupId: string,
  text: string,
  sendAt: number,
  senderName: string,
  senderPubB64: string
): Promise<string> {
  // v4.32.187 (Round-17 #6): mirror scheduleMessage validation.
  if (typeof groupId !== 'string' || groupId.length === 0 || groupId.length > 128) {
    throw new Error('invalid_group_id');
  }
  if (!isPubKeyB64(senderPubB64)) {
    throw new Error('invalid_sender_pub');
  }
  if (!isSendableMessageText(text)) {
    throw new Error('invalid_text_length');
  }
  if (!Number.isFinite(sendAt)) throw new Error('invalid_send_at');
  const now = Date.now();
  if (sendAt < now - 60_000 || sendAt > now + 365 * 86_400_000) {
    throw new Error('send_at_out_of_range');
  }
  // v4.32.197 (Round-27 #10): cap senderName so fanout can't ship a multi-MB
  // string to every member per-message.
  if (typeof senderName !== 'string') throw new Error('invalid_sender_name');
  const safeSenderName = senderName.slice(0, 128);
  const pid = activePid();
  if (pid === null) throw new Error('scheduled_profile_unset');
  const id = uuidv4();
  // contactPubB64 is repurposed as senderPubB64 for group scheduled messages
  await insertScheduledMessage({
    id,
    contactPubB64: senderPubB64,
    text,
    mediaCids: null,
    sendAt,
    ownerProfileId: pid,
    createdAt: Date.now(),
    groupId,
    senderName: safeSenderName,
  });
  log.info('group_message_scheduled', { id: id.slice(0, 8), groupId: groupId.slice(0, 8), sendAt: new Date(sendAt).toISOString() });
  return id;
}

/** Send all messages that are now due. Called by poll timer. */
async function flushDue(): Promise<void> {
  // v4.32.249: защита от повторного входа. Тик таймера — раз в 30 секунд, а
  // один проход отправляет все due-строки последовательно: рассылка в большую
  // группу или медленная сеть легко переваливают за 30 секунд. Строка удаляется
  // только ПОСЛЕ успешной отправки, поэтому следующий тик успевал прочитать её
  // снова и отправить то же самое сообщение второй раз — получатель видел дубль.
  if (flushing) return;
  flushing = true;
  try {
    await flushDueOnce();
  } finally {
    flushing = false;
  }
}

async function flushDueOnce(): Promise<void> {
  const pid = activePid();
  if (pid === null) return;
  const svc = getMessagingService();
  if (!svc) return;

  const due = await listDueScheduledMessages(pid);
  if (due.length === 0) return;

  // v4.32.175: lazy import rateLimiter (циклическая зависимость).
  const { rateLimiter } = await import('../security/rateLimiter');
  // v4.32.318: и дождаться, пока список поднят с диска. Таймер отложенных
  // сообщений заводится при запуске, а первый же тик отправляет всё, чему
  // срок вышел, пока приложение было закрыто, — то есть попадает ровно в то
  // окно, когда isBlocked ещё отвечает «не заблокирован» на кого угодно.
  await rateLimiter.whenReady();
  // v4.32.596: как автора зовут сейчас — запасное имя для подписи, если
  // записанное в строке расписания не прочиталось. Спрашивается один раз на
  // проход, а не на каждую строку: профиль в пределах прохода не меняется
  // (при смене проход прерывается проверкой ниже).
  const ownName = await getOwnDisplayNameFor(pid);

  for (const msg of due) {
    // v4.32.188 (Round-18 #5): profile-switch guard. If user switches
    // profile mid-flush, any remaining queued row from profile A would be
    // signed by profile B's key with profile B's messaging service. Bail
    // out on mismatch — the row stays in scheduled_messages and next tick
    // (now bound to the new active profile) will no-op naturally.
    if (activePid() !== pid) {
      log.info('scheduled_flush_profile_switched_abort', { pid });
      break;
    }
    // v4.32.835: номер этой попытки. Объявлен до `try`, потому что нужен и
    // ловушке внизу. Сама отметка ложится ниже, перед отправкой: ветки
    // «строка не прочиталась» и «часовой лимит выбран» уходят раньше, и
    // тратить на них попытку не за что — отправлять там никто не пробовал.
    const attempt = (msg.attempts ?? 0) + 1;
    try {
      // v4.32.565: сначала — прочиталась ли строка. Проверка стоит выше всех
      // остальных сознательно: каждая ветка ниже либо отправляет, либо
      // удаляет строку, а непрочитанную нельзя ни то, ни другое. Отправка
      // разослала бы пустой пузырь собеседнику или всей группе, удаление
      // стёрло бы шифртекст, который правильным ключом ещё открылся бы.
      // Строка просто остаётся лежать — срока годности у неё нет, а в списке
      // запланированных она теперь подписана (scheduledHoldTitle).
      const verdict = decideScheduledSend(msg);
      if (verdict.kind === 'hold') {
        if (shouldReportScheduledHold(msg.id)) {
          log.warn('scheduled_message_unreadable_hold', { id: msg.id.slice(0, 8), code: verdict.code });
        }
        continue;
      }
      // v4.32.175: если контакт заблокирован — отменяем отложенное сообщение,
      // иначе scheduled до блокировки до сих пор стрелял в заблокированного.
      if (!msg.groupId && rateLimiter.isBlocked(msg.contactPubB64)) {
        await deleteScheduledMessage(msg.id, pid);
        log.info('scheduled_message_blocked_drop', { id: msg.id.slice(0, 8) });
        continue;
      }
      // v4.32.319: часовой лимит выбран — отложить до следующего тика, а не
      // отправить и удалить. sendMessage в этом случае возвращает null, а
      // null здесь считается успехом (так помечены сообщения, ушедшие в
      // очередь отправки) — то есть строка удалялась, и запланированное
      // сообщение исчезало молча. Спрашиваем не canSendMessage: сам вопрос
      // забрал бы одну из пятидесяти попыток.
      if (!msg.groupId && rateLimiter.messageLimitReached(msg.contactPubB64)) {
        log.info('scheduled_message_deferred_rate_limit', { id: msg.id.slice(0, 8) });
        continue;
      }
      // v4.32.171: parse mediaCids from stored row (was silently dropped).
      let mediaUris: string[] | undefined = undefined;
      if (msg.mediaCids) {
        try {
          const parsed = JSON.parse(msg.mediaCids);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // v4.32.198 (Round-28 #8): cap count so a corrupt row with 10k
            // valid-length CIDs doesn't get fanned out per schedule tick.
            const filtered = parsed
              .filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 256)
              .slice(0, 32);
            if (filtered.length > 0) mediaUris = filtered;
          }
        } catch {
          // v4.32.189 (Round-19 #7): do NOT fall back to treating the raw
          // string as a single cid — a partial/corrupt write would pin the
          // row in the retry loop for 15 minutes hammering SQLite. Drop
          // the attachment silently; text still goes out.
          log.warn('scheduled_media_malformed_drop', { id: msg.id.slice(0, 8) });
        }
      }
      // Отсюда и ниже отправка правда пробуется — значит, попытка потрачена.
      // Отметку кладём ДО отправки: упасть она может как раз на отправке, и
      // попытка, о которой никто не записал, повторялась бы вечно.
      await bumpScheduledAttemptChecked(msg.id, pid, attempt);
      if (msg.groupId) {
        // Group scheduled message — fanout to all members
        const msgId = msg.id;
        /**
         * v4.32.304: `|| '?'`, а не `?? '?'`. С этой версии имя лежит в БД
         * шифртекстом, и не расшифровавшееся значение приходит сюда пустой
         * строкой, а не null (decryptAtRestString). `??` её пропускал бы — и
         * сообщение ушло бы всей группе вообще без подписи отправителя.
         *
         * v4.32.596: но и «?» было неправдой. Подписывается собственное
         * сообщение, и когда записанное имя не прочиталось, честнее взять то,
         * как автора зовут сейчас, чем расписаться знаком вопроса перед всей
         * группой — навсегда, потому что после отправки строка удаляется.
         */
        const senderLabel = scheduledSenderLabel(msg, ownName);
        /**
         * v4.32.269: своя копия. Для лички её пишет сам sendMessage
         * (upsertChatMessage + touchConversation), а для группы это всегда
         * делал вызывающий экран — все одиннадцать мест в UI пишут строку и
         * только потом зовут fanout. Планировщик — двенадцатое место, и оно
         * писать забыло: отложенное сообщение уходило ВСЕМ, кроме автора.
         * У него оно не появлялось ни в истории группы, ни в превью списка, а
         * строка расписания удалялась после успешной отправки — то есть
         * сообщение просто исчезало, и понять, ушло оно или нет, было нельзя.
         */
        const fanout = await fanoutGroupMessage(
          msg.groupId,
          msg.text,
          senderLabel,
          msg.contactPubB64, // contactPubB64 holds senderPubB64 for group messages
          msgId
        );
        // v4.32.450: разбор исхода — общий с экранами. Своя копия этого
        // условия жила здесь одна, а двенадцать мест в UI ответ просто
        // выбрасывали; теперь правило одно на всех.
        const problem = groupSendProblem(fanout);
        if (problem?.kind === 'denied') {
          // Права могли отозвать за те часы, что сообщение ждало своего часа:
          // бан, «только чтение», «писать могут только администраторы». Строку
          // расписания снимаем — иначе она будет биться в отказ каждый тик.
          await deleteScheduledMessage(msg.id, pid);
          log.warn('scheduled_group_message_denied', {
            id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8), code: problem.code,
          });
          reportScheduledLost(
            'SCHEDULED_DENIED',
            'Отложенное сообщение в группу не отправлено: писать в ней больше нельзя.'
          );
          continue;
        }
        // v4.32.440: два случая, которые до разбора ответа выглядели как «права
        // отозвали» и стирали назначенное сообщение, и как «отправлено» —
        // и тоже стирали, вместе с локальной копией:
        //   служба обмена пропала между проверкой в начале прохода и рассылкой;
        //   отправка КАЖДОМУ участнику бросила исключение.
        // В обоих сообщение не ушло никому, поэтому строка остаётся до
        // следующего тика — но не дольше ABANDON_AFTER_ATTEMPTS.
        /**
         * v4.32.850: «приняли не все» — беда, но единственная, по которой
         * повторять нельзя. Ниже по этой же ветке стоит `continue`, то есть
         * строка расписания остаётся и на следующем тике рассылка идёт заново;
         * для частичной доставки это значит второй экземпляр сообщения у всех,
         * кто его уже принял. Поэтому здесь только слова — и падение дальше, к
         * записи своей копии и снятию строки, как при обычной отправке.
         */
        if (problem?.kind === 'partial') {
          log.warn('scheduled_group_message_partial', {
            id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8), sent: problem.sent, of: problem.members,
          });
          reportScheduledLost('SCHEDULED_PARTIAL', `Отложенное сообщение: ${groupSendProblemText(problem)}`);
        }
        if (problem && problem.kind !== 'partial') {
          if (attempt >= ABANDON_AFTER_ATTEMPTS) {
            await deleteScheduledMessage(msg.id, pid);
            log.warn('scheduled_group_message_abandoned', {
              id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8), attempt,
            });
            reportScheduledLost(
              'SCHEDULED_NOT_SENT',
              'Отложенное сообщение не отправлено: связи не было слишком долго. Наберите его заново.'
            );
          } else {
            log.info('scheduled_group_message_retry', {
              id: msg.id.slice(0, 8),
              groupId: msg.groupId.slice(0, 8),
              reason: problem.reason,
            });
          }
          continue;
        }
        /**
         * v4.32.782: своя копия пишется вместе со своим следом и с исходом.
         *
         * Гасящая `insertGroupMessage` отвечала `boolean`, и ответ этот
         * выбрасывался, а `touchGroupConversation` глотала свой отказ внутри.
         * Ниже по строке 'снимается только после подтверждённой отправки: … у
         * группового — записанная строка беседы' — подтверждения-то и не было.
         * Занятая на долю секунды база давала ровно ту картину, ради которой
         * своя копия и заведена в v4.32.269: группа сообщение получила и уже
         * отвечает, у автора его нет ни в истории, ни в превью, а строка
         * расписания снята — то есть набранного не осталось нигде.
         *
         * Одной транзакцией — чтобы не было середины: строка без следа означала
         * бы группу с позавчерашним превью при лежащем внутри сообщении.
         */
        const own = await insertGroupMessageWithTouch(
          {
            id: msgId,
            groupId: msg.groupId,
            senderPubB64: msg.contactPubB64,
            senderName: senderLabel,
            text: msg.text,
            mediaCids: null,
            replyToId: null,
            replyToPreview: null,
            reactions: null,
            createdAt: Date.now(),
            ownerProfileId: pid,
          },
          {
            groupId: msg.groupId,
            ownerProfileId: pid,
            preview: msg.text.slice(0, 120),
            // Своё сообщение: ни непрочитанным, ни упоминанием себе самому.
            incrementUnread: false,
            senderName: senderLabel,
            incrementMention: false,
            senderPubB64: msg.contactPubB64,
          }
        );
        if (own === 'failed') {
          /**
           * Строку расписания держим: она единственная хранит текст, и на
           * следующем тике проход повторится целиком. Повтор рассылки для
           * группы безвреден — `msgId` тот же (`msg.id`), а приёмник пишет
           * `INSERT OR IGNORE` и отвечает `'duplicate'`, не поднимая ни
           * счётчиков, ни уведомлений. Дороже молча потерять текст.
           *
           * Запас тот же, что у «никто не получил»: тридцать отказов базы —
           * это уже не заминка, и дальше держать строку значит биться в неё
           * каждые полминуты без конца. Слова о потере здесь другие: сообщение
           * группа ПОЛУЧИЛА, и советовать набрать его заново нельзя — человек
           * напишет то же самое дважды.
           */
          if (attempt >= ABANDON_AFTER_ATTEMPTS) {
            await deleteScheduledMessage(msg.id, pid);
            log.warn('scheduled_group_own_row_abandoned', {
              id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8), attempt,
            });
            reportScheduledLost(
              'SCHEDULED_SENT_NOT_SAVED',
              'Отложенное сообщение ушло в группу, но в вашей переписке не сохранилось. Откройте группу — оно там есть.'
            );
          } else {
            log.warn('scheduled_group_own_row_failed', {
              id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8),
            });
          }
          continue;
        }
        log.info('scheduled_group_message_sent', { id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8) });
      } else {
        // v4.32.714: непустой ответ — конверт ушёл; null — отказ, и отказ
        // окончательный. sendMessage отдаёт null шестью путями, и для
        // отложенного сообщения опасны два из них: нет общего ключа
        // (NO_SESSION_DM) и негодный peerDid — оба возвращают null ДО того,
        // как заведены messageId и черновая строка, то есть текста не остаётся
        // нигде. Раньше здесь писалось scheduled_message_sent и строка
        // расписания удалялась: сообщение исчезало молча — ровно тот случай,
        // ради которого в v4.32.713 перестали считать null успехом у
        // служебного конверта. Блокировка и часовой лимит отсечены проверками
        // выше, а «нет маршрута в сеть» оставляет в переписке строку со
        // статусом failed — поэтому отчёт сперва просит заглянуть в чат.
        const cid = await svc.sendMessage(msg.contactPubB64, msg.text, mediaUris);
        if (!cid) {
          await deleteScheduledMessage(msg.id, pid);
          log.warn('scheduled_message_refused', {
            id: msg.id.slice(0, 8),
            to: msg.contactPubB64.slice(0, 8),
          });
          reportScheduledLost(
            'SCHEDULED_REFUSED',
            'Отложенное сообщение не ушло: отправить его не удалось. Проверьте переписку — если сообщения там нет, наберите его заново.'
          );
          continue;
        }
        log.info('scheduled_message_sent', { id: msg.id.slice(0, 8), to: msg.contactPubB64.slice(0, 8), mediaCount: mediaUris?.length ?? 0 });
      }
      // Строка расписания снимается только после подтверждённой отправки:
      // у личного сообщения это непустой cid, у группового — записанная
      // строка беседы. Отказ уходит веткой выше и сюда не доходит.
      // v4.32.782: и «записанная» здесь наконец значит записанную. До этого
      // круга слово держалось на записи, которая свой отказ гасила молча.
      // v4.32.662: и владельца строки — явно. Без второго довода
      // deleteScheduledMessage берёт профиль, активный В МОМЕНТ УДАЛЕНИЯ, а
      // между проверкой профиля в начале витка и этой строкой лежит вся
      // отправка: сетевой круг на сообщение или рассылка всей группе. Успей
      // человек переключить профиль за это время — DELETE не находил строки,
      // она доживала до следующего тика и уходила ВТОРОЙ раз. Строки выбраны
      // по owner_profile_id = pid, так что pid здесь — владелец по построению.
      await deleteScheduledMessage(msg.id, pid);
    } catch (e) {
      log.warn('scheduled_message_failed', {
        id: msg.id.slice(0, 8),
        err: e instanceof Error ? e.message : String(e),
      });
      // v4.32.171: не биться в мёртвого получателя бесконечно — см.
      // ABANDON_AFTER_ATTEMPTS. Сюда же приходит отказ `requireOnlineWrite` в
      // режиме только-из-кэша — то есть обычное «сети пока нет», и до
      // v4.32.835 оно и стирало ночные сообщения первым же утренним тиком.
      if (attempt >= ABANDON_AFTER_ATTEMPTS) {
        try {
          await deleteScheduledMessage(msg.id, pid);
          log.warn('scheduled_message_abandoned', { id: msg.id.slice(0, 8), attempt });
          reportScheduledLost(
            'SCHEDULED_NOT_SENT',
            'Отложенное сообщение не отправлено: связи не было слишком долго. Наберите его заново.'
          );
        } catch { /* ignore */ }
      }
    }
  }
}

/** Start the background scheduler. Call once after MessagingService is ready. */
export function startScheduler(): void {
  if (pollTimer) return;
  // v4.32.249: раньше было `void flushDue()`. Отказ SQLite при чтении due-строк
  // превращался в необработанный reject — в dev это красный экран поверх чата.
  const tick = () => void flushDue().catch((e) => {
    log.warn('scheduled_flush_failed', { err: e instanceof Error ? e.message : String(e) });
  });
  // Check immediately on start
  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
