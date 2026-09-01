/**
 * Единственная воронка отправки служебных конвертов (v4.32.447).
 *
 * Реакция, голос в опросе, завершение опроса — это не сообщения: они уходят
 * служебным конвертом через тот же sendMessage, и в каждом модуле лежала своя
 * копия одного и того же кода — «есть ли сервис отправки», «разослать всем
 * участникам, кроме себя», «поймать исключение и записать в лог». Копии
 * разошлись: в v4.32.446 у опросов «сервиса нет» перестало быть успехом, у
 * реакций осталось. Правило о том, что считать отправленным, живёт теперь в
 * одном месте, и новый вид конверта не может завести себе третье мнение.
 *
 * Успех здесь — «конверт принят сервисом отправки», а не «доставлен адресату»:
 * sendMessage отдаёт null и когда конверт отброшен, и когда он положен в
 * очередь повторной отправки, различить их по null нельзя. А вот исключение
 * означает, что отправку не начали вовсе, — его и считаем отказом.
 */

import { getMessagingService } from './messaging';
import { log } from '../logger';

/** Почему служебный конверт никуда не ушёл. */
export type FanoutUndelivered = 'no_service' | 'no_peer' | 'all_failed';

/**
 * Итог рассылки. Оба варианта обязаны нести своё поле: «скольким адресатам»
 * без «удалось ли» и наоборот — это и есть та пара, которую путали.
 */
export type FanoutResult =
  | { sent: true; recipients: number }
  | { sent: false; reason: FanoutUndelivered };

/**
 * Кому уходит конверт.
 *
 * Пустой список получателей в группе — это законная группа, где кроме меня
 * никого; отказ по «некому» бывает только в личке без собеседника.
 */
export type FanoutTarget =
  | { kind: 'group'; recipients: string[] }
  | { kind: 'dm'; peerPubB64?: string };

/** Отбрасывает себя и забаненных: конверт им не нужен, а бану — тем более. */
export function activeRecipients(
  members: { peerPubB64: string; role: string }[],
  selfPubB64: string
): string[] {
  return members
    .filter((m) => m.peerPubB64 !== selfPubB64 && m.role !== 'banned')
    .map((m) => m.peerPubB64);
}

/**
 * Рассылает служебный конверт и называет исход. `op` — только для логов.
 */
export async function fanoutControlEnvelope(
  op: string,
  payload: string,
  target: FanoutTarget
): Promise<FanoutResult> {
  const svc = getMessagingService();
  if (!svc) {
    log.warn('control_fanout_no_service', { op });
    return { sent: false, reason: 'no_service' };
  }
  const recipients =
    target.kind === 'group'
      ? target.recipients
      : target.peerPubB64
        ? [target.peerPubB64]
        : [];
  if (target.kind === 'dm' && recipients.length === 0) {
    log.warn('control_fanout_no_peer', { op });
    return { sent: false, reason: 'no_peer' };
  }
  let accepted = 0;
  await Promise.allSettled(
    recipients.map(async (pub) => {
      try {
        await svc.sendMessage(pub, payload);
        accepted += 1;
      } catch (e) {
        log.warn('control_fanout_send_failed', {
          op,
          to: pub.slice(0, 12),
          err: e instanceof Error ? e.message : String(e),
        });
      }
    })
  );
  if (accepted === 0 && recipients.length > 0) {
    return { sent: false, reason: 'all_failed' };
  }
  log.info('control_fanout_sent', { op, to: accepted, of: recipients.length });
  return { sent: true, recipients: accepted };
}

/**
 * Текст отказа для человека: у себя записано, а разослать не вышло.
 *
 * `head` — что именно уже записано («Голос записан у вас», «Реакция
 * поставлена»): без него фраза «не разослано» читается как «ничего не
 * произошло», и человек жмёт ещё раз, снимая то, что только что поставил.
 */
export function undeliveredText(head: string, reason: FanoutUndelivered): string {
  const tail = reason === 'no_peer' ? 'но разослать не вышло' : 'но остальные об этом не узнали';
  return `${head}, ${tail}: ${fanoutReasonText(reason, 'dm')}.`;
}

/**
 * Почему конверт не ушёл — одной фразой на всё приложение (v4.32.454).
 *
 * Фраза зависит от того, кому не ушло: в личке беда в том, что собеседник не
 * определён, в группе — что рассылать некому. Копий этой пары было три (общий
 * текст здесь, тексты группы и текст таймера), и они уже разошлись в
 * формулировках. Дом у неё теперь один — рядом с самой причиной.
 */
const NO_PEER: Record<FanoutTarget['kind'], string> = {
  dm: 'собеседник не определён',
  group: 'некому отправить',
};

export function fanoutReasonText(reason: FanoutUndelivered, kind: FanoutTarget['kind']): string {
  return reason === 'no_peer' ? NO_PEER[kind] : 'нет связи';
}
