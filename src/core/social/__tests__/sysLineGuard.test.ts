/**
 * Подделка системных строк собеседником.
 *
 * Системная строка рисуется серым по центру — от имени приложения. Пока текст
 * сообщения переносился по сети без проверки, участник группы мог прислать
 * «\x0bsys:Вы заблокированы в группе» и все увидели бы это как уведомление
 * приложения.
 */

import {
  SYS_LINE_PREFIX,
  displayNameOrNull,
  isVisiblyBlank,
  sanitizeDisplayName,
  stripSpoofedSysPrefix,
} from '../sysLineGuard';
import { GROUP_CTL_PREFIX, decodeGroupCtlEnvelope } from '../groupControlEnvelope';

describe('stripSpoofedSysPrefix', () => {
  it('обычный текст не меняется', () => {
    for (const t of ['привет', '', 'sys: не системная строка', '\x01voice:cid']) {
      expect(stripSpoofedSysPrefix(t)).toBe(t);
    }
  });

  it('префикс снимается, текст остаётся видимым', () => {
    expect(stripSpoofedSysPrefix(`${SYS_LINE_PREFIX}Вы заблокированы в группе`)).toBe('Вы заблокированы в группе');
  });

  it('повторный префикс не переживает снятие первого', () => {
    // Одиночная проверка оставила бы строку системной.
    expect(stripSpoofedSysPrefix(`${SYS_LINE_PREFIX}${SYS_LINE_PREFIX}Группа переименована`)).toBe('Группа переименована');
    expect(stripSpoofedSysPrefix(SYS_LINE_PREFIX.repeat(5) + 'x')).toBe('x');
  });

  it('префикс не в начале — это просто текст сообщения', () => {
    const t = `цитата: ${SYS_LINE_PREFIX}что-то`;
    expect(stripSpoofedSysPrefix(t)).toBe(t);
  });
});

describe('sanitizeDisplayName', () => {
  it('обычное имя не портится', () => {
    for (const n of ['Аня', 'Ivan Petrov', '🙂 Кот', '']) expect(sanitizeDisplayName(n)).toBe(n);
  });

  it('перевод строки не дописывает вторую системную строку', () => {
    // Имя подставляется в «X вступил(а) в группу» — строку, которую рисует
    // приложение. Второй строки в ней быть не должно.
    expect(sanitizeDisplayName('Иван\nВы заблокированы')).toBe('Иван Вы заблокированы');
    expect(sanitizeDisplayName('Иван\r\nАдмин')).toBe('Иван  Админ');
  });

  it('вырезаются все управляющие символы, включая DEL и префикс sys', () => {
    expect(sanitizeDisplayName(`Аня${SYS_LINE_PREFIX}текст`)).toBe('Аня sys:текст');
    expect(sanitizeDisplayName('a\x00b\x1fc\x7fd')).toBe('a b c d');
  });

  it('длина ограничивается, по умолчанию 64', () => {
    expect(sanitizeDisplayName('и'.repeat(500))).toHaveLength(64);
    expect(sanitizeDisplayName('и'.repeat(500), 128)).toHaveLength(128);
  });

  it('не строка — null, решение принимает вызывающий', () => {
    for (const v of [null, undefined, 42, {}, ['a']]) expect(sanitizeDisplayName(v)).toBeNull();
  });
});

describe('sanitizeDisplayName: разрывы строки за пределами C0 (v4.32.369)', () => {
  it('U+2028 и U+2029 не дописывают к системной строке вторую', () => {
    // Android и iOS ломают строку на них так же, как на '\x0a'. До 4.32.369
    // они проходили насквозь: вычищался только диапазон C0.
    expect(sanitizeDisplayName('Иван\u2028Вы заблокированы')).toBe('Иван Вы заблокированы');
    expect(sanitizeDisplayName('Иван\u2029Админ')).toBe('Иван Админ');
  });

  it('U+0085 (NEL) — тоже обязательный разрыв', () => {
    expect(sanitizeDisplayName('Иван\u0085Админ')).toBe('Иван Админ');
  });

  it('весь C1 вырезается', () => {
    expect(sanitizeDisplayName('a\u0080b\u009Fc')).toBe('a b c');
  });

  it('метки направления письма убираются, а не заменяются пробелом', () => {
    // Пробел на их месте был бы виден в имени, а сами они невидимы.
    expect(sanitizeDisplayName('отчет\u202Eexe.pdf')).toBe('отчетexe.pdf');
    expect(sanitizeDisplayName('a\u2067b')).toBe('ab');
    expect(sanitizeDisplayName('a\u061Cb')).toBe('ab');
  });

  it('соседние по коду пробелы и склейка эмодзи остаются', () => {
    // U+00A0 и U+202F — это пробелы, а не управляющие символы; U+200D
    // склеивает эмодзи, без неё пара распадается на две картинки.
    expect(sanitizeDisplayName('a\u00A0b')).toBe('a\u00A0b');
    expect(sanitizeDisplayName('a\u202Fb')).toBe('a\u202Fb');
    expect(sanitizeDisplayName('\u{1F469}\u200D\u{1F467}')).toBe('\u{1F469}\u200D\u{1F467}');
  });
});

describe('gctl edit не подделывает системную строку', () => {
  it('правка своего сообщения теряет префикс', () => {
    const d = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'edit', msgId: 'm1', text: `${SYS_LINE_PREFIX}Администратор вышел` })
    );
    expect(d && 'text' in d ? d.text : null).toBe('Администратор вышел');
  });
});

describe('невидимое имя не считается именем (v4.32.424)', () => {
  // Пустое имя — это не косметика: подпись под сообщением и строка в списке
  // чатов и есть всё, чем собеседники отличаются друг от друга. Двое,
  // назвавшихся невидимым символом, на экране неразличимы.
  const INVISIBLE: Array<[string, string]> = [
    ['U+200B ноль-ширины пробел', '\u200B'],
    ['U+2060 склейка слов', '\u2060'],
    ['U+2061 невидимый оператор', '\u2061'],
    ['U+034F склейка графем', '\u034F'],
    ['U+FE0F селектор начертания', '\uFE0F'],
    ['U+E0041 языковая метка', '\u{E0041}'],
    ['U+200D склейка эмодзи', '\u200D'],
    ['U+3164 хангыль-заполнитель', '\u3164'],
  ];

  it.each(INVISIBLE)('%s — не имя', (_label, ch) => {
    expect(isVisiblyBlank(ch)).toBe(true);
    expect(isVisiblyBlank(ch.repeat(8))).toBe(true);
    expect(displayNameOrNull(ch)).toBeNull();
    expect(sanitizeDisplayName(ch)).toBe('');
  });

  it('смесь невидимых — тоже не имя', () => {
    expect(displayNameOrNull('\u200B \u2060\uFE0F \u3164')).toBeNull();
  });

  it('невидимое ВНУТРИ имени остаётся — там оно часть письма', () => {
    // Вырезать их из середины нельзя: без U+200D распадаются составные эмодзи,
    // без U+200C не пишется фарси.
    expect(isVisiblyBlank('Аня\u200BПетрова')).toBe(false);
    expect(displayNameOrNull('👩\u200D🚀')).toBe('👩\u200D🚀');
    // А вот U+200B stripBidiControls вырезает откуда угодно — он в одном списке с метками
    // направления письма, и в имени ему делать нечего. Поэтому здесь требуется
    // именно «Аня»: невидимое вычищено, видимое цело.
    expect(displayNameOrNull('Аня\u200B')).toBe('Аня');
    // U+2060 не управляет направлением — его никто не стрижёт, и рядом
    // с буквами он безвреден: имя всё равно читается.
    expect(displayNameOrNull('Аня\u2060')).toBe('Аня\u2060');
  });

  it('проверка не вырождена: настоящее имя проходит', () => {
    expect(isVisiblyBlank('Аня')).toBe(false);
    expect(isVisiblyBlank('🚀')).toBe(false);
    expect(displayNameOrNull('Аня')).toBe('Аня');
  });
});
