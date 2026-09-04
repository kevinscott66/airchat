/**
 * Состав меню действий с сообщением: что видно сразу, а что под «Ещё».
 *
 * v4.32.578. Меню выросло до четырнадцати пунктов подряд — «Ответить,
 * Переслать, Реакция, Редактировать, Копировать, Перевести, Копировать ссылку,
 * В избранное, Закрепить, Напомнить, Подробнее, Выбрать, Удалить у себя,
 * Удалить у всех». Список во всю высоту экрана: чтобы дотянуться до «Удалить»,
 * надо прочесть тринадцать строк, а самое частое действие — «Ответить» — тонет
 * среди редких наравне с ними. Порядок при этом ничего не значил: он сложился
 * из того, в каком порядке пункты добавляли.
 *
 * Здесь состав разложен на два уровня. Сразу видно шесть действий, которыми
 * пользуются каждый день; остальное лежит за одной строкой «Ещё» и никуда не
 * пропадает. Это не сокрытие функций, а порядок: `primary ∪ more` — ровно тот
 * же набор, что был, и тест это проверяет.
 *
 * Файл чистый (без React) намеренно: состав меню — утверждение о продукте, и
 * проверяться оно должно тестом, а не глазами на телефоне.
 */

export type MessageMenuAction =
  | 'reply'
  | 'copy'
  | 'forward'
  | 'edit'
  | 'pin'
  | 'delete'
  | 'translate'
  | 'copyLink'
  | 'star'
  | 'remind'
  | 'info'
  | 'markUnread'
  | 'select'
  | 'closePoll';

export interface MessageMenuFlags {
  /** Своё сообщение. */
  isOut: boolean;
  /** Медиасообщение: текста нет, копировать и переводить нечего. */
  isMedia: boolean;
  /** По переписке включён запрет копирования и пересылки (copyGuard). */
  copyBlocked: boolean;
  /** Свой опрос, ещё открытый. */
  canClosePoll: boolean;
}

export interface MessageMenu {
  /** Видно сразу. */
  primary: MessageMenuAction[];
  /** Под строкой «Ещё». */
  more: MessageMenuAction[];
}

/**
 * Сколько действий держим на виду.
 *
 * Шесть — не круглое число, а граница: ровно столько пунктов помещается на
 * экране вместе с рядом реакций, не требуя прокрутки, на самом узком из
 * поддерживаемых экранов.
 */
export const MESSAGE_MENU_PRIMARY_MAX = 6;

/**
 * Что видно сразу, что под «Ещё».
 *
 * «Удалить» остаётся на виду, хотя действие и редкое: искать его в свёрнутом
 * списке — хуже, чем видеть. Оно рисуется последним и отдельно от остальных.
 */
export function messageMenu(f: MessageMenuFlags): MessageMenu {
  const canCopy = !f.isMedia && !f.copyBlocked;
  const primary: MessageMenuAction[] = ['reply'];
  if (canCopy) primary.push('copy');
  if (canCopy) primary.push('forward');
  if (f.isOut && !f.isMedia) primary.push('edit');
  primary.push('pin');
  primary.push('delete');

  const more: MessageMenuAction[] = [];
  if (!f.isMedia) more.push('translate');
  more.push('copyLink');
  more.push('star');
  more.push('remind');
  more.push('info');
  if (!f.isOut) more.push('markUnread');
  more.push('select');
  if (f.canClosePoll) more.push('closePoll');

  return { primary, more };
}
