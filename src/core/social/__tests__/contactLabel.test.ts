/**
 * Подпись собеседника и буква в кружке (v4.32.372).
 *
 * Оба правила были записаны в двух десятках мест поодиночке, и оба
 * ошибались на пустом имени: `??` его пропускает, а `[0]` у него —
 * undefined.
 */

import { contactLabel, nameInitial, nameInitials, nameOrNull } from '../contactLabel';

/** Имена, от которых на экране ничего не остаётся. */
const BLANK = [
  '',
  '   ',
  '\u200D',
  '\u200C\u200C',
  '\u2800\u2800\u2800',
  '\u3164',
  '\uFFA0',
  '\u115F\u1160',
  '\u180E',
  '\u17B4\u17B5',
  '\u00A0\u3000',
];

describe('contactLabel', () => {
  it('пустое имя уступает место запасному', () => {
    // Ровно то, чего не делал `??`: у Contact.displayName тип string, для
    // безымянного контакта это пустая строка, и подстановка не срабатывала.
    for (const n of BLANK) {
      expect([JSON.stringify(n), contactLabel(n, 'AAAA…')]).toEqual([JSON.stringify(n), 'AAAA…']);
    }
  });

  it('отсутствие имени — тоже запасное', () => {
    expect(contactLabel(null, 'Участник')).toBe('Участник');
    expect(contactLabel(undefined, 'Участник')).toBe('Участник');
    expect(contactLabel(42, 'Участник')).toBe('Участник');
  });

  it('настоящее имя доезжает как есть', () => {
    for (const n of ['Аня', 'Ivan Petrov', '.', '0', '\u{1F642} Кот', '\u{1F469}\u200D\u{1F467}']) {
      expect([n, contactLabel(n, 'запасное')]).toEqual([n, n]);
    }
  });

  it('имя с невидимыми внутри не считается пустым', () => {
    // U+200C нужен фарси, U+200D склеивает эмодзи — вырезать их нельзя,
    // речь только о строке, в которой кроме них ничего нет.
    expect(contactLabel('a\u200Db', 'x')).toBe('a\u200Db');
    expect(contactLabel(' Аня ', 'x')).toBe(' Аня ');
  });
});

describe('nameInitial', () => {
  it('пустое имя не роняет отрисовку', () => {
    // Было `(name ?? '?')[0].toUpperCase()`: у пустой строки [0] — undefined,
    // и .toUpperCase() на нём бросает исключение прямо в render.
    for (const n of BLANK) {
      expect([JSON.stringify(n), nameInitial(n)]).toEqual([JSON.stringify(n), '?']);
    }
    expect(nameInitial(null)).toBe('?');
    expect(nameInitial(undefined)).toBe('?');
    expect(nameInitial(42)).toBe('?');
  });

  it('запасное значение выбирает вызывающий', () => {
    expect(nameInitial('', 'Г')).toBe('Г');
  });

  it('буква берётся заглавной', () => {
    expect(nameInitial('аня')).toBe('А');
    expect(nameInitial('ivan')).toBe('I');
    expect(nameInitial('Пётр Иванов')).toBe('П');
  });

  it('эмодзи берётся целиком, а не половиной суррогатной пары', () => {
    // [0] у такого имени — одна единица UTF-16, и в кружке рисуется пустой
    // прямоугольник вместо картинки.
    expect(nameInitial('\u{1F642} Кот')).toBe('\u{1F642}');
    expect(nameInitial('\u{1F642}')).toBe('\u{1F642}');
    expect(nameInitial('\u{1F642}').length).toBe(2);
  });

  it('ведущие пробелы и невидимые пропускаются', () => {
    // У имени с пробелом впереди первой буквой была пустота.
    expect(nameInitial(' Аня')).toBe('А');
    expect(nameInitial('\u00A0\u200DАня')).toBe('А');
    expect(nameInitial('\u2800\u2800Bob')).toBe('B');
  });

  it('небуквенное имя даёт свой первый символ, а не запасное', () => {
    expect(nameInitial('_bot')).toBe('_');
    expect(nameInitial('7')).toBe('7');
  });
});

describe('nameOrNull', () => {
  it('пустое имя из старой строки базы — это отсутствие имени', () => {
    // Строки, записанные до v4.32.371, лежат с пустым именем; сорок мест в
    // экране групп пишут `?? 'Участник'`, и оно там не подставлялось.
    for (const n of BLANK) {
      expect([JSON.stringify(n), nameOrNull(n)]).toEqual([JSON.stringify(n), null]);
    }
    expect(nameOrNull(null)).toBeNull();
    expect(nameOrNull(undefined)).toBeNull();
  });

  it('настоящее имя доезжает без обрезки и без правок', () => {
    // Обрезать второй раз, другим пределом, нельзя: имя уже очищено при
    // записи, и в разных экранах показался бы разный его кусок.
    const long = 'Я'.repeat(300);
    expect(nameOrNull(long)).toBe(long);
    expect(nameOrNull(' Аня ')).toBe(' Аня ');
  });

  it('подстановка после него наконец работает', () => {
    expect(nameOrNull('') ?? 'Участник').toBe('Участник');
    expect(nameOrNull('Пётр') ?? 'Участник').toBe('Пётр');
  });
});

describe('nameInitials', () => {
  it('берёт по букве от двух первых слов', () => {
    expect(nameInitials('Иван Петров')).toBe('ИП');
    expect(nameInitials('иван петров сергеевич')).toBe('ИП');
  });

  it('одно слово — одна буква', () => {
    // Шторка вложений брала slice(0, 2) и писала «КИ» вместо «К».
    expect(nameInitials('Мама')).toBe('М');
    expect(nameInitials('Ким')).toBe('К');
  });

  it('две буквы берутся у РАЗНЫХ слов', () => {
    expect(nameInitials('Александр Пушкин')).toBe('АП');
  });

  it('двойной пробел не съедает вторую букву', () => {
    // split(' ') давал пустое «слово», и на экране звонка оставалась одна буква.
    expect(nameInitials('Анна  Петрова')).toBe('АП');
    expect(nameInitials('Анна\tПетрова')).toBe('АП');
  });

  it('эмодзи не разрезается пополам', () => {
    // w[0] вернул бы половину суррогатной пары — на экране квадратик.
    const rocket = nameInitials('🚀Ракета');
    expect(rocket.codePointAt(0)).toBe('🚀'.codePointAt(0));
    const astronaut = nameInitials('👩‍🚀 Аня');
    expect(astronaut.codePointAt(0)).toBe('👩'.codePointAt(0));
    expect(astronaut).toContain('А');
  });

  it('невидимый ведущий символ пропускается', () => {
    // Имя приходит по сети: ноль-ширины в начале давал пустой кружок.
    expect(nameInitials('\u200BАня')).toBe('А');
    expect(nameInitials('\u200B\u200B Аня Петрова')).toBe('АП');
  });

  it('показывать нечего — запасной знак', () => {
    for (const bad of ['', '   ', '\u200B', null, undefined, 42]) {
      expect(nameInitials(bad as unknown as string)).toBe('?');
    }
    expect(nameInitials('', 'X')).toBe('X');
  });
});
