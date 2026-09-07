/**
 * Итог рассылки группового сообщения — на экран (v4.32.450).
 *
 * Отдельный модуль, а не копия в каждом экране: рассылку зовут из чата
 * группы, из ленты и из окна пересылки, и до этой версии все три одинаково
 * выбрасывали ответ через `void`. Одна воронка показа — чтобы следующее место
 * отправки не завело себе четвёртое мнение о том, молчать или сказать.
 */

import type { GroupFanoutResult } from '../core/social/groupMessaging';
import { groupSendProblem, groupSendProblemText } from '../core/social/groupSendOutcome';
import { userErrorText } from './components/userErrorText';
import { showError } from './components/userFeedback';

/** При успехе молчит: строка уже видна в переписке. При беде — называет её. */
export function announceGroupSend(sending: Promise<GroupFanoutResult>): void {
  void sending.then((res) => {
    const problem = groupSendProblem(res);
    if (problem) showError(groupSendProblemText(problem));
  }).catch((e: unknown) => {
    // v4.32.622: до этой ветки сорвавшаяся рассылка (сеть, ключи, база) молчала
    // совсем — строка уже стоит в переписке, и отправитель считал её
    // доставленной. Это ровно тот случай, ради которого воронка и заводилась.
    showError(userErrorText(e, 'Не удалось разослать сообщение группе'));
  });
}
