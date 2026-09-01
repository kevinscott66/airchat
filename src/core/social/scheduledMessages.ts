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
  insertGroupMessage,
  listDueScheduledMessages,
  deleteScheduledMessage,
  touchGroupConversation,
} from '../storage/local';
import { fanoutGroupMessage } from './groupMessaging';
import { groupSendProblem } from './groupSendOutcome';
import { log } from '../logger';
import { isSendableMessageText } from './messageTextLimit';
import { decideScheduledSend, scheduledSenderLabel, shouldReportScheduledHold } from './scheduledDispatch';
import { getOwnDisplayNameFor } from '../identity/ownProfile';

const POLL_INTERVAL_MS = 30_000;
/**
 * Сколько ждать, прежде чем бросить попытки (v4.32.440).
 *
 * Столбца «сколько раз пробовали» в таблице нет, поэтому мерой служит возраст:
 * прошло больше этого срока с назначенного времени — строку снимаем, иначе
 * неудачная отправка билась бы в отказ каждые полминуты бесконечно. Правило
 * одно и живёт здесь: раньше срок стоял числом внутри catch, а ветка «никто
 * не получил» о нём не знала.
 */
const ABANDON_AFTER_MS = 15 * 60_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

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
  if (typeof contactPubB64 !== 'string' || contactPubB64.length < 43 || contactPubB64.length > 48) {
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
  const pid = profileManager.getActiveProfile()?.id ?? 1;
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
  if (typeof senderPubB64 !== 'string' || senderPubB64.length < 43 || senderPubB64.length > 48) {
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
  const pid = profileManager.getActiveProfile()?.id ?? 1;
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
  const pid = profileManager.getActiveProfile()?.id ?? 1;
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
    if ((profileManager.getActiveProfile()?.id ?? 1) !== pid) {
      log.info('scheduled_flush_profile_switched_abort', { pid });
      break;
    }
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
        await deleteScheduledMessage(msg.id);
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
          await deleteScheduledMessage(msg.id);
          log.warn('scheduled_group_message_denied', {
            id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8), code: problem.code,
          });
          continue;
        }
        // v4.32.440: два случая, которые до разбора ответа выглядели как «права
        // отозвали» и стирали назначенное сообщение, и как «отправлено» —
        // и тоже стирали, вместе с локальной копией:
        //   служба обмена пропала между проверкой в начале прохода и рассылкой;
        //   отправка КАЖДОМУ участнику бросила исключение.
        // В обоих сообщение не ушло никому, поэтому строка остаётся до
        // следующего тика — но не дольше ABANDON_AFTER_MS.
        if (problem) {
          const staleMs = Date.now() - msg.sendAt;
          if (staleMs > ABANDON_AFTER_MS) {
            await deleteScheduledMessage(msg.id);
            log.warn('scheduled_group_message_abandoned', {
              id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8), ageMs: staleMs,
            });
          } else {
            log.info('scheduled_group_message_retry', {
              id: msg.id.slice(0, 8),
              groupId: msg.groupId.slice(0, 8),
              reason: problem.reason,
            });
          }
          continue;
        }
        await insertGroupMessage({
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
        });
        await touchGroupConversation(
          msg.groupId,
          pid,
          msg.text.slice(0, 120),
          false,
          senderLabel,
          false,
          msg.contactPubB64
        );
        log.info('scheduled_group_message_sent', { id: msg.id.slice(0, 8), groupId: msg.groupId.slice(0, 8) });
      } else {
        await svc.sendMessage(msg.contactPubB64, msg.text, mediaUris);
        log.info('scheduled_message_sent', { id: msg.id.slice(0, 8), to: msg.contactPubB64.slice(0, 8), mediaCount: mediaUris?.length ?? 0 });
      }
      // Always delete on success (either real cid or outbox-enqueued null return).
      await deleteScheduledMessage(msg.id);
    } catch (e) {
      log.warn('scheduled_message_failed', {
        id: msg.id.slice(0, 8),
        err: e instanceof Error ? e.message : String(e),
      });
      // v4.32.171: не биться в мёртвого получателя бесконечно — см. ABANDON_AFTER_MS.
      const ageMs = Date.now() - msg.sendAt;
      if (ageMs > ABANDON_AFTER_MS) {
        try {
          await deleteScheduledMessage(msg.id);
          log.warn('scheduled_message_abandoned', { id: msg.id.slice(0, 8), ageMs });
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
