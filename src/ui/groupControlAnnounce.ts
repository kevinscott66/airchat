/**
 * Итог рассылки управляющего конверта группы — на экран (v4.32.451).
 *
 * v4.32.449 завёл эту воронку внутри экрана групп. Приглашение при создании
 * группы живёт в другом файле, и первое же «покажем и там» означало бы вторую
 * копию правила «молчать при успехе, называть расхождение при отказе» — ровно
 * тот способ, которым копии расходятся. Правило переехало в отдельный модуль
 * до того, как копия появилась.
 */

import type { GroupControlOutcome } from '../core/social/groupControlOutcome';
import {
  groupControlProblem,
  inviteTokenSpreadProblem,
  inviteVerifierSpreadProblem,
} from '../core/social/groupControlOutcome';
import type { InviteTokenResult } from '../core/social/groupMessaging';
import { showError } from './components/userFeedback';
import { announceLater, announceNow } from './announceOutcome';

/**
 * При успехе молчит — человек и так видит результат у себя на экране; при
 * отказе называет, что именно теперь расходится с остальными участниками.
 * Отдельная функция, а не `void` у каждого вызова: пропущенный отказ ровно так
 * и появлялся — по одному `void` за раз.
 */
export function announceCtl(sending: Promise<GroupControlOutcome>): void {
  announceLater(sending, groupControlProblem, 'Не удалось разослать изменение участникам группы');
}

/** То же самое для уже полученного исхода — чтобы правило осталось одно. */
export function announceCtlNow(outcome: GroupControlOutcome): void {
  announceNow(outcome, groupControlProblem);
}

/**
 * Токен пригласительной ссылки мог родиться прямо сейчас — у групп, созданных
 * до v4.32.303, его заводит первое же нажатие кнопки. Тогда о нём сообщали
 * другим администраторам, и молчать о неудаче нельзя.
 *
 * v4.32.1005: рассылок стало две — токен администраторам и отпечаток
 * остальным участникам, — и берёт функция весь ответ целиком, а не одну из
 * них. Аргументом-исходом второй пришлось бы дописывать в четыре места, и
 * пропущенное место было бы ровно тем, ради чего этот модуль и заведён:
 * участник, не узнавший о сбросе, по прежней ссылке впускает.
 *
 * Оба расхождения называются, если случились оба: они разные и поправить их
 * нечем сразу — человеку важно знать про каждое.
 *
 * @param result ответ rotate/ensure; исход null — токен не менялся.
 * @returns true, если расхождение показано (значит, успех объявлять не о чем).
 */
export function announceInviteToken(result: InviteTokenResult): boolean {
  const problems = [
    result.announced ? inviteTokenSpreadProblem(result.announced) : null,
    result.spread ? inviteVerifierSpreadProblem(result.spread) : null,
  ].filter((p): p is string => p !== null);
  for (const p of problems) showError(p);
  return problems.length > 0;
}
