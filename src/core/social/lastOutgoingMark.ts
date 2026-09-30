/**
 * Значок последней исходящей реплики в строке списка чатов.
 *
 * ДЕФЕКТ (до v4.32.1086). В списке чатов значок рисовался правилом
 * `unreadCount === 0 ? 'checkmark-done' : 'checkmark'`. `unreadCount` — это
 * счётчик МОИХ непрочитанных входящих; к судьбе моей реплики он не имеет
 * отношения вовсе. Совпадение выходило почти всегда: если последнее сообщение
 * моё, то входящих непрочитанных обычно нет, и строка показывала двойную
 * галочку — «прочитано» — в ту же секунду, когда я нажал «отправить».
 *
 * ЦЕНА. Двойная галочка — это утверждение о другом человеке: «он это видел».
 * Она стояла и когда отправка провалилась (`failed`), и когда сообщение ещё
 * лежит в очереди (`sent` без cid), и когда собеседник неделю не открывал
 * приложение. Тот же чат, открытый на экран ниже, показывал правду: красный
 * значок ошибки или одиночную галочку. Список и переписка говорили разное об
 * одном сообщении, и список говорил то, что человек хотел услышать.
 *
 * ПРАВКА. Настоящий статус лежит в `chat_messages.status` и уже рисуется в
 * переписке (см. MessageStatusIcon). Здесь он разворачивается в тот же набор
 * значков, чтобы список и переписка не могли разъехаться.
 *
 * ГРАНИЦЫ. Цвет отдаётся ИМЕНЕМ токена палитры, не значением: палитру знает
 * экран, ядро — нет (то же правило, что в groupAdminLog, v4.32.390). Если
 * исходящей реплики не нашлось или её статус незнаком — это отдельный ответ,
 * а не молчаливое «прочитано»: третье состояние здесь такое же полноправное,
 * как два первых.
 */

/** Последняя исходящая реплика диалога: её статус и адрес в сети. */
export interface LastOutgoing {
  status: string;
  /** null — тела ещё нет в сети; вместе со статусом `sent` это «в очереди». */
  cid: string | null;
}

export type LastOutgoingIcon =
  | 'checkmark-done'
  | 'checkmark-done-outline'
  | 'checkmark-outline'
  | 'cloud-upload-outline'
  | 'time-outline'
  | 'alert-circle-outline'
  | 'help-circle-outline';

/** Имена токенов палитры — не значения. */
export type LastOutgoingTone = 'accent' | 'textMuted' | 'error';

export interface LastOutgoingMark {
  icon: LastOutgoingIcon;
  tone: LastOutgoingTone;
  /** Что значок значит словами: и для озвучки, и чтобы значки не путались. */
  label: string;
}

/**
 * @param last — последняя исходящая реплика диалога; `null`/`undefined`, если
 *   её не нашли. Тогда ответ тоже `null`: рисовать нечего, а выдумывать —
 *   ровно тот дефект, ради которого этот модуль написан.
 */
export function lastOutgoingMark(last: LastOutgoing | null | undefined): LastOutgoingMark | null {
  if (!last) return null;
  // Отдано в исходящую очередь, но тела ещё нет в сети. В переписке это
  // отдельный значок с v4.32.344 — список обязан говорить то же самое.
  if (last.status === 'sent' && !last.cid) {
    return { icon: 'cloud-upload-outline', tone: 'textMuted', label: 'В очереди на отправку' };
  }
  switch (last.status) {
    case 'read':
      return { icon: 'checkmark-done', tone: 'accent', label: 'Прочитано' };
    case 'delivered':
      return { icon: 'checkmark-done-outline', tone: 'textMuted', label: 'Доставлено' };
    case 'sent':
      return { icon: 'checkmark-outline', tone: 'textMuted', label: 'Отправлено' };
    case 'sending':
      return { icon: 'time-outline', tone: 'textMuted', label: 'Отправляется' };
    case 'failed':
      return { icon: 'alert-circle-outline', tone: 'error', label: 'Не отправлено' };
    default:
      // Незнакомое слово в столбце статуса. Это не «прочитано» и не
      // «отправлено» — это «мы не знаем», и выглядеть оно должно иначе.
      return { icon: 'help-circle-outline', tone: 'textMuted', label: 'Статус неизвестен' };
  }
}
