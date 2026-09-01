/**
 * reactionScope — к какой переписке привязана реакция.
 *
 * v4.32.343. Реакция ищет своё сообщение по одному лишь id, и этого мало.
 * Конверт '\x0freact:' называет группу отдельным полем, права проверялись по
 * нему, а строка правилась по msgId — между ними не было связи никакой:
 *
 *   участник группы А ставил реакцию на сообщение в группе Б, зная его id;
 *   контакт ставил реакцию в переписке двух других людей — в неанонимном
 *   списке отреагировавших появлялось его имя.
 *
 * Личная ветка вдобавок искала строку вообще без owner_profile_id, то есть
 * реакция ложилась на сообщение любого профиля на устройстве — а профили здесь
 * заведены ровно затем, чтобы не пересекаться.
 *
 * Ту же проверку можно было сделать отдельным SELECT у вызывающего, но она
 * встроена в условие запроса намеренно: между «проверил» и «записал» нет щели,
 * а сама область больше не может быть забыта — без неё вызов не компилируется.
 *
 * Модуль без импортов: строит фрагмент SQL и его параметры, ничего не
 * выполняя. Имена таблиц и колонок здесь литеральные, в запрос не подставляется
 * ни одно значение из конверта.
 */

/** Переписка, к которой обязана относиться реакция. */
export type ReactionScope =
  | { group: true; groupId: string; ownerProfileId: number }
  | { group: false; contactPubB64: string; ownerProfileId: number };

export type ReactionScopeSql = {
  table: 'group_messages' | 'chat_messages';
  where: string;
  params: (string | number)[];
};

export function reactionScopeSql(messageId: string, scope: ReactionScope): ReactionScopeSql {
  return scope.group
    ? {
        table: 'group_messages',
        where: 'id = ? AND owner_profile_id = ? AND group_id = ?',
        params: [messageId, scope.ownerProfileId, scope.groupId],
      }
    : {
        table: 'chat_messages',
        where: 'id = ? AND owner_profile_id = ? AND contact_pub_b64 = ?',
        params: [messageId, scope.ownerProfileId, scope.contactPubB64],
      };
}
