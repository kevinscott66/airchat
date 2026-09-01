/**
 * Запустить действие с хранилищем так, чтобы отказ дошёл до человека.
 *
 * v4.32.531 (в GroupsScreen), v4.32.546 (общее). Действия над сообщениями
 * записаны в экранах как `void doSomething(...).then(перерисовать)` — без
 * `.catch`. Функции хранилища бросают: занятая база, сорванная транзакция,
 * отсутствующий профиль. Отказ уходил в неперехваченное отклонение обещания:
 * перерисовка не наступала, ошибка не показывалась, и «Удалить» выглядело как
 * кнопка, которая просто иногда не срабатывает.
 *
 * Один вход вместо тридцати повторов try/catch. В группах он уже стоял, но
 * жил внутри GroupsScreen — в переписке те же действия оставались открытыми.
 */
import { log } from '../../core/logger';
import { rawErrorText, userErrorText } from './userErrorText';
import { showError } from './userFeedback';

/**
 * @param op       действие; всё, что после него, кладите внутрь — тогда оно не
 *                 выполнится при отказе, а это обычно и нужно.
 * @param fallback что показать, если у ошибки нет своего человеческого текста.
 * @param tag      метка для журнала: по ней потом искать причину.
 */
export function runGuardedOp(op: () => Promise<unknown>, fallback: string, tag?: string): void {
  void (async () => {
    try {
      await op();
    } catch (e) {
      if (tag) log.error(tag, { err: rawErrorText(e) });
      showError(userErrorText(e, fallback));
    }
  })();
}
