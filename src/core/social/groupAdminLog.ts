/**
 * Классификация строк журнала действий группы.
 *
 * v4.32.390. Журнал показывает те же системные строки, что и лента чата, но
 * рядом со значком и цветом — чтобы отличить исключение от вступления, не
 * вчитываясь. Разбор жил внутри `renderItem` модалки лестницей из девяти
 * `else if` по `includes`, и лестница была неверна в трёх местах сразу:
 *
 * 1. Первое правило ловило `includes('администратор')` — то есть срабатывало
 *    на «Режим «только для администраторов» включён», на «Закреплять сообщения
 *    могут только администраторы» и, что хуже всего, на «X снят(а) с
 *    администраторов и ограничен(а) в отправке сообщений». Разжалование с
 *    ограничением показывалось значком назначения администратором — событие
 *    читалось ровно наоборот.
 * 2. По той же причине последнее правило (`includes('администраторов')`) было
 *    недостижимо.
 * 3. Правило исключения проверяло `includes('исключён') ||
 *    includes('исключён')` — одну и ту же строку дважды.
 *
 * Плюс половина словаря событий не была расписана вовсе: блокировка,
 * разблокировка, ограничение отправки, смена аватара, сброс пригласительной
 * ссылки, порядок входа по ссылке, скрытие имён, исчезающие сообщения — всё
 * это падало в общий значок «информация».
 *
 * Здесь правила лежат упорядоченным списком, и порядок — часть смысла:
 * назначение проверяется раньше ограничения, потому что строка «ограничение
 * снято, назначен(а) администратором» содержит оба слова, а событие в ней
 * одно. Список чистый и проверяется тестом на полном словаре событий —
 * добавить событие и забыть про значок теперь стоит красного теста.
 *
 * Цвет возвращается ИМЕНЕМ токена, а не значением: модалка знает палитру,
 * ядро — нет (то же правило, что у ролей отправителя в v4.32.383).
 */

export type AdminLogIcon =
  | 'shield-checkmark-outline'
  | 'shield-outline'
  | 'person-add-outline'
  | 'person-remove-outline'
  | 'ban-outline'
  | 'chatbubble-outline'
  | 'star-outline'
  | 'pencil-outline'
  | 'image-outline'
  | 'pin-outline'
  | 'lock-closed-outline'
  | 'timer-outline'
  | 'flame-outline'
  | 'link-outline'
  | 'eye-off-outline'
  | 'information-circle-outline';

/** Имена токенов палитры — не значения. */
export type AdminLogTone =
  | 'primary'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'star'
  | 'textSecondary'
  | 'textMuted';

export interface AdminLogEvent {
  icon: AdminLogIcon;
  tone: AdminLogTone;
}

interface Rule {
  /** Совпадения по любому из фрагментов; порядок правил решает конфликты. */
  any: readonly string[];
  icon: AdminLogIcon;
  tone: AdminLogTone;
}

const RULES: readonly Rule[] = [
  // Назначение — раньше ограничения: «ограничение снято, назначен(а)
  // администратором» содержит оба слова, но событие в нём одно.
  { any: ['назначен'], icon: 'shield-checkmark-outline', tone: 'primary' },
  // «разблокирован» раньше «заблокирован» — на случай, если формулировка
  // однажды станет «за/разблокирован».
  { any: ['разблокирован'], icon: 'person-add-outline', tone: 'success' },
  { any: ['заблокирован'], icon: 'ban-outline', tone: 'error' },
  { any: ['исключён', 'исключен'], icon: 'person-remove-outline', tone: 'error' },
  // Ловит и «ограничен(а) в отправке», и «снят(а) с администраторов и
  // ограничен(а)»: ограничение — более сильное следствие, чем разжалование.
  { any: ['ограничен'], icon: 'ban-outline', tone: 'warning' },
  { any: ['с должности администратора', 'разжалован'], icon: 'shield-outline', tone: 'warning' },
  { any: ['снова может писать'], icon: 'chatbubble-outline', tone: 'success' },
  { any: ['вступил'], icon: 'person-add-outline', tone: 'success' },
  { any: ['создал'], icon: 'star-outline', tone: 'star' },
  { any: ['переименована'], icon: 'pencil-outline', tone: 'primary' },
  { any: ['Аватар группы'], icon: 'image-outline', tone: 'primary' },
  // Всё про закрепление — раньше правила «только для администраторов»:
  // «Закреплять сообщения могут только администраторы» содержит и то и другое.
  { any: ['закреплено', 'откреплено', 'Закреплять сообщения'], icon: 'pin-outline', tone: 'accent' },
  { any: ['только для администраторов'], icon: 'lock-closed-outline', tone: 'warning' },
  { any: ['Медленный режим'], icon: 'timer-outline', tone: 'textSecondary' },
  { any: ['Исчезающие сообщения'], icon: 'flame-outline', tone: 'textSecondary' },
  { any: ['Пригласительная ссылка'], icon: 'link-outline', tone: 'warning' },
  { any: ['Вход по ссылке'], icon: 'link-outline', tone: 'primary' },
  { any: ['Имена отправителей'], icon: 'eye-off-outline', tone: 'textSecondary' },
];

const UNKNOWN: AdminLogEvent = { icon: 'information-circle-outline', tone: 'textMuted' };

/**
 * @param eventText — текст события БЕЗ служебного префикса (то, что вернул
 *   parseGroupSysText).
 */
export function adminLogEvent(eventText: string): AdminLogEvent {
  for (const rule of RULES) {
    for (const needle of rule.any) {
      if (eventText.includes(needle)) return { icon: rule.icon, tone: rule.tone };
    }
  }
  return UNKNOWN;
}
