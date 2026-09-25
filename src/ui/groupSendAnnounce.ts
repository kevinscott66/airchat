/**
 * Итог рассылки группового сообщения — на экран (v4.32.450).
 *
 * Отдельный модуль, а не копия в каждом экране: рассылку зовут из чата
 * группы, из ленты и из окна пересылки, и до этой версии все три одинаково
 * выбрасывали ответ через `void`. Одна воронка показа — чтобы следующее место
 * отправки не завело себе четвёртое мнение о том, молчать или сказать.
 *
 * v4.32.951: беда теперь не только называется, но и запоминается. Плашка
 * висит секунды, а сообщение остаётся в переписке навсегда — и до этой версии
 * оставалось с той же галочкой, что и дошедшее. Отметка кладётся рядом с
 * сообщением (см. groupSendProblemStore) и переживает выход из группы.
 */

import type { GroupFanoutResult } from '../core/social/groupMessaging';
import { groupSendProblem, groupSendProblemText } from '../core/social/groupSendOutcome';
import { recordGroupSendProblemFor } from '../core/social/groupSendProblemStore';
import { userErrorText } from './components/userErrorText';
import { showError } from './components/userFeedback';

/**
 * Какое сообщение рассылали: id строки, уже лежащей в переписке, и профиль,
 * которому она принадлежит. Профиль называется здесь, а не спрашивается у
 * активного: между отправкой и ответом рассылки человек успевает переключить
 * аккаунт, и отметка легла бы чужому (то же правило, что у scopedKvSetFor).
 */
export type GroupSentMessage = { msgId: string; pid: number };

/** При успехе молчит: строка уже видна в переписке. При беде — называет её. */
export function announceGroupSend(sending: Promise<GroupFanoutResult>, sent: GroupSentMessage): void {
  void sending.then((res) => {
    const problem = groupSendProblem(res);
    if (problem) showError(groupSendProblemText(problem));
    if (problem) void recordGroupSendProblemFor(sent.pid, sent.msgId, problem);
  }).catch((e: unknown) => {
    // v4.32.622: до этой ветки сорвавшаяся рассылка (сеть, ключи, база) молчала
    // совсем — строка уже стоит в переписке, и отправитель считал её
    // доставленной. Это ровно тот случай, ради которого воронка и заводилась.
    showError(userErrorText(e, 'Не удалось разослать сообщение группе'));
    // Бросок — это тоже «не ушло никому»: до подсчёта принявших дело не дошло.
    void recordGroupSendProblemFor(sent.pid, sent.msgId, {
      kind: 'undelivered',
      reason: 'all_failed',
    });
  });
}
