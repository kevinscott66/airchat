/**
 * Разбор исхода рассылки группового сообщения (v4.32.450).
 *
 * fanoutGroupMessage с самого начала возвращал разбор случаев, а не флаг:
 * «прав нет» (повторять бессмысленно), «службы обмена нет» (повторить позже)
 * и «разослано — вот скольким из скольких». Пользовался этим ровно один
 * вызывающий — планировщик отложенных, где правило и было выведено в
 * v4.32.440. Все двенадцать мест в UI писали `void fanoutGroupMessage(...)`.
 *
 * Своя строка при этом уже лежит в переписке: экраны пишут её ДО рассылки,
 * иначе своё же сообщение не появилось бы на своём экране. Поэтому отказ
 * выглядел как обычное отправленное сообщение — навсегда. Забаненный или
 * переведённый в «только чтение» видел свои сообщения в группе и не понимал,
 * почему ему никто не отвечает.
 *
 * Правило «что считать бедой» переезжает сюда целиком, чтобы у планировщика и
 * у экранов оно было одно. Успех с нулём принявших бедой считается наравне с
 * отказом: адресаты были, конверт не взял никто.
 */

import type { GroupFanoutResult } from './groupMessaging';
import { sendDenyText, type SendDenyCode } from './groupSendPolicy';

/**
 * Что именно не так. Два случая разведены, потому что решения по ним
 * противоположные: по 'denied' повторять бессмысленно (права не вернутся сами),
 * по 'undelivered' — наоборот, только повтор и поможет.
 */
export type GroupSendProblem =
  | { kind: 'denied'; code: SendDenyCode }
  | { kind: 'undelivered'; reason: 'no_service' | 'all_failed' };

/** Беда рассылки, либо null — если сообщение принял хотя бы кто-то. */
export function groupSendProblem(res: GroupFanoutResult): GroupSendProblem | null {
  if (!res.ok) {
    return res.reason === 'denied'
      ? { kind: 'denied', code: res.code }
      : { kind: 'undelivered', reason: 'no_service' };
  }
  // ok:true с нулём принявших — не успех. Пустая группа (адресатов не было
  // вовсе) бедой не считается: рассылать было некому и незачем.
  if (res.members > 0 && res.sent === 0) return { kind: 'undelivered', reason: 'all_failed' };
  return null;
}

/**
 * Текст для человека. Обе фразы кончаются одинаково — «осталось только у
 * вас»: без этого «не отправлено» читается как «ничего не произошло», а
 * строка при этом уже видна в переписке.
 */
export function groupSendProblemText(problem: GroupSendProblem): string {
  return problem.kind === 'denied'
    ? `${sendDenyText(problem.code)}. Сообщение осталось только у вас.`
    : 'Сообщение не ушло никому из участников: нет связи. Оно осталось только у вас.';
}

/**
 * Короткая причина — для перечислений вида «Не отправлено: «А» — …; «Б» — …».
 * Там уже сказано, что не отправлено, и целая фраза в списке не читается.
 */
export function groupSendProblemShort(problem: GroupSendProblem): string {
  return problem.kind === 'denied' ? sendDenyText(problem.code).toLowerCase() : 'нет связи';
}
