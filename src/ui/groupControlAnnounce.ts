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
import { groupControlProblem, inviteTokenSpreadProblem } from '../core/social/groupControlOutcome';
import { showError } from './components/userFeedback';
import { announceLater, announceNow } from './announceOutcome';

/**
 * При успехе молчит — человек и так видит результат у себя на экране; при
 * отказе называет, что именно теперь расходится с остальными участниками.
 * Отдельная функция, а не `void` у каждого вызова: пропущенный отказ ровно так
 * и появлялся — по одному `void` за раз.
 */
export function announceCtl(sending: Promise<GroupControlOutcome>): void {
  announceLater(sending, groupControlProblem);
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
 * @param announced итог рассылки; null — токен не менялся, сообщать было нечего.
 * @returns true, если расхождение показано (значит, успех объявлять не о чем).
 */
export function announceInviteToken(announced: GroupControlOutcome | null): boolean {
  const problem = announced ? inviteTokenSpreadProblem(announced) : null;
  if (!problem) return false;
  showError(problem);
  return true;
}
