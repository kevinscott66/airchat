/**
 * Имя, которого не видно (v4.32.371).
 *
 * Правило «имени нет» во всём приложении — это проверка на истинность:
 * `displayName || peerName` в списке контактов, `senderName ?? '?'` под
 * сообщением группы, `actorName ?? 'Администратор'` в системной строке.
 * Пустая строка её проходит правильно. Строка из невидимых символов — нет:
 * для кода это полноценное имя, на экране от него не остаётся ничего, и двое
 * назвавшихся так неразличимы между собой.
 *
 * Вычистка имени такие символы пропускает намеренно: U+200C нужен фарси и
 * деванагари, U+200D склеивает составные эмодзи, а вырезать их из середины
 * имени нельзя. Значит решать должно место, где имя состоит из них целиком.
 */

import {
  displayNameOrNull,
  isVisiblyBlank,
  sanitizeDisplayName,
} from '../sysLineGuard';

/** Чем набивают пустое имя. Пробелами эти символы не считаются. */
const BLANKS: Array<[string, string]> = [
  ['склейка эмодзи U+200D', '\u200D'],
  ['разделитель фарси U+200C', '\u200C'],
  ['пустой символ Брайля U+2800', '\u2800'],
  ['хангыль-заполнитель U+3164', '\u3164'],
  ['полуширинный хангыль-заполнитель U+FFA0', '\uFFA0'],
  ['заполнители чосон и чунсон', '\u115F\u1160'],
  ['монгольский разделитель U+180E', '\u180E'],
  ['кхмерские гласные U+17B4…U+17B5', '\u17B4\u17B5'],
  ['неразрывный и идеографический пробелы', '\u00A0\u3000'],
  ['обычные пробелы', '   '],
  ['всё вместе', '\u200D\u2800\u3164 \u00A0\u180E'],
];

describe('isVisiblyBlank', () => {
  it('строка из одних невидимых символов пуста на экране', () => {
    for (const [name, s] of BLANKS) {
      expect([name, isVisiblyBlank(s)]).toEqual([name, true]);
    }
    expect(isVisiblyBlank('')).toBe(true);
  });

  it('одной видимой точки достаточно, чтобы имя было именем', () => {
    for (const s of ['а', '.', '_', '-', '0', '\u{1F600}', 'Аня', '\u200D\u2800.']) {
      expect([s, isVisiblyBlank(s)]).toEqual([s, false]);
    }
  });

  it('настоящее письмо этими символами не портится', () => {
    // Без U+200C не пишется фарси, без U+200D распадается составное эмодзи —
    // и то, и другое видимо целиком.
    expect(isVisiblyBlank('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645')).toBe(false);
    expect(isVisiblyBlank('\u{1F469}\u200D\u{1F467}')).toBe(false);
  });
});

describe('sanitizeDisplayName: имя из одного невидимого', () => {
  it('отдаётся пустой строкой', () => {
    for (const [name, s] of BLANKS) {
      expect([name, sanitizeDisplayName(s)]).toEqual([name, '']);
    }
  });

  it('обычные имена не меняются', () => {
    for (const n of ['Аня', 'Ivan Petrov', '\u{1F642} Кот', '']) {
      expect(sanitizeDisplayName(n)).toBe(n);
    }
    expect(sanitizeDisplayName('\u{1F469}\u200D\u{1F467}')).toBe('\u{1F469}\u200D\u{1F467}');
  });

  it('пробелы внутри имени остаются, по краям — срезаются', () => {
    // «Пусто» — это про строку целиком, а не про отдельный символ в ней.
    expect(sanitizeDisplayName('a\u00A0b')).toBe('a\u00A0b');
    expect(sanitizeDisplayName('Иван Петров')).toBe('Иван Петров');
    // v4.32.374: края обрезаются. Пробел по краю функция ставит сама — вместо
    // управляющего символа, — а шесть десятков пробелов перед буквой уводят
    // имя за правый край строки в списке чатов.
    expect(sanitizeDisplayName(' Аня ')).toBe('Аня');
    expect(sanitizeDisplayName('\nАня')).toBe('Аня');
    expect(sanitizeDisplayName(' '.repeat(60) + 'Аня')).toBe('Аня');
    // Обрезка по длине сама оставляет пробел на конце — его тоже нет.
    expect(sanitizeDisplayName('Аня Петрова', 4)).toBe('Аня');
  });

  it('видимая часть за пределом длины — это тоже пустое имя', () => {
    // Проверка обязана стоять ПОСЛЕ обрезки: строка видима целиком, а в
    // предел попадает только невидимая её часть.
    expect(sanitizeDisplayName('\u200D'.repeat(64) + 'Аня')).toBe('');
    expect(sanitizeDisplayName('\u2800'.repeat(200) + 'Аня', 128)).toBe('');
    // А если видимое в предел укладывается — имя остаётся именем.
    expect(sanitizeDisplayName('\u200D'.repeat(10) + 'Аня')).toContain('Аня');
  });

  it('не строка — по-прежнему null, а не пустая строка', () => {
    // Вызывающие на этом стоят: null у них значит «конверт негодный».
    for (const v of [null, undefined, 42, {}, ['a']]) {
      expect(sanitizeDisplayName(v)).toBeNull();
    }
  });
});

describe('displayNameOrNull', () => {
  it('невидимое имя — это отсутствие имени', () => {
    for (const [name, s] of BLANKS) {
      expect([name, displayNameOrNull(s)]).toEqual([name, null]);
    }
    expect(displayNameOrNull('')).toBeNull();
    expect(displayNameOrNull(null)).toBeNull();
    expect(displayNameOrNull(42)).toBeNull();
  });

  it('настоящее имя доезжает целиком', () => {
    expect(displayNameOrNull('Аня')).toBe('Аня');
    expect(displayNameOrNull('\u{1F469}\u200D\u{1F467}')).toBe('\u{1F469}\u200D\u{1F467}');
  });

  it('подстановка по умолчанию наконец срабатывает', () => {
    // Ровно то, ради чего функция и заведена: до неё «Администратор» не
    // подставлялся никогда — невидимое имя истинно.
    const label = (v: unknown): string => displayNameOrNull(v) ?? 'Администратор';
    expect(label('\u200D\u200D')).toBe('Администратор');
    expect(label('\u3164')).toBe('Администратор');
    expect(label('Пётр')).toBe('Пётр');
  });

  it('местная подпись не вытесняется невидимым именем из сети', () => {
    // `displayName || peerName` в списке контактов: до правила выигрывала
    // подпись из одних склеек, и вместо имени собеседника не было ничего.
    const shown = (local: unknown, fromNetwork: string): string =>
      (displayNameOrNull(local, 128) ?? '') || fromNetwork;
    expect(shown('\u200D\u200D\u200D', 'Аня')).toBe('Аня');
    expect(shown('Аня', 'Анна')).toBe('Аня');
  });
});
