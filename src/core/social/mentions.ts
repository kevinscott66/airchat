/**
 * Распознавание @упоминаний в тексте сообщения.
 *
 * Вынесено в отдельный модуль, потому что проверка была в двух местах и
 * разошлась: groupMessaging.ts считал по полному тексту без учёта регистра,
 * а pushNotifications.ts — по уже обрезанному до 80 символов превью и с
 * учётом регистра. Из-за этого упоминание в замьюченной группе (единственный
 * случай, когда флаг вообще что-то решает) не срабатывало, если написано в
 * другом регистре или дальше 80-го символа.
 *
 * Имя здесь — это `user_username`, свободная строка из профиля: в ней могут
 * быть пробелы, регистр и знаки препинания. Поэтому не регулярка по имени,
 * а посимвольный поиск с проверкой границ.
 */

/**
 * Символы, из которых «слово» состоит. Нужны, чтобы @аня не срабатывало
 * внутри @анна, а bob@anna.example не считалось упоминанием anna.
 * Без флага 'u' и без \p{...} — Hermes на старых Android их не гарантирует.
 */
const NAME_CHAR = /[0-9a-zа-яё_]/;

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && NAME_CHAR.test(ch);
}

/**
 * Упомянут ли владелец имени `username` в тексте `text`.
 *
 * Имя короче двух символов игнорируется: с однобуквенным именем упоминанием
 * становился бы почти любой '@'.
 */
export function isMentionOf(text: string, username: string | null | undefined): boolean {
  const name = (username ?? '').trim().toLowerCase();
  if (name.length < 2) return false;
  const hay = text.toLowerCase();
  const needle = `@${name}`;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    // Слева от '@' не должно быть буквы — иначе это хвост адреса почты.
    if (isNameChar(hay[i - 1])) continue;
    // Справа не должно продолжаться слово — иначе @аня матчит @анну.
    if (isNameChar(hay[i + needle.length])) continue;
    return true;
  }
  return false;
}
