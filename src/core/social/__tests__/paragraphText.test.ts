/**
 * Чужой многострочный текст мимо пузыря сообщения (v4.32.373).
 *
 * Описание группы и текст сторис рисуются обычным <Text>, то есть мимо
 * FormattedText, который чистит тело сообщения. В обоих конвертах стояла одна
 * проверка длины.
 */

import { sanitizeParagraphText } from '../sysLineGuard';

/** RIGHT-TO-LEFT OVERRIDE — ради него stripBidiControls и написан. */
const RLO = '\u202E';

describe('sanitizeParagraphText', () => {
  it('метки направления письма вырезаются', () => {
    // «отчет<RLO>exe.pdf» показывается как «отчетfdp.exe»: на экране читается
    // не то, что написано.
    expect(sanitizeParagraphText(`отчет${RLO}exe.pdf`, 512)).toBe('отчетexe.pdf');
    expect(sanitizeParagraphText('a\u200Bb\uFEFF', 512)).toBe('ab');
    expect(sanitizeParagraphText('\u202Aх\u202C', 512)).toBe('х');
  });

  it('управляющие символы вырезаются, а перевод строки и табуляция — нет', () => {
    expect(sanitizeParagraphText('a\u0000b\u0007c\u001Bd\u007Fe', 512)).toBe('abcde');
    expect(sanitizeParagraphText('строка\nвторая\tтретья', 512)).toBe('строка\nвторая\tтретья');
  });

  it('префикс системной строки не подделать', () => {
    // '\x0b' — первый байт SYS_LINE_PREFIX; из тела сообщения его убирает
    // sanitizeBodyForRender, а описание группы шло мимо неё.
    expect(sanitizeParagraphText('\x0bsys:Группа переименована', 512)).toBe('sys:Группа переименована');
  });

  it('три вида перевода строки приводятся к одному', () => {
    expect(sanitizeParagraphText('a\r\nb', 512)).toBe('a\nb');
    expect(sanitizeParagraphText('a\rb', 512)).toBe('a\nb');
    expect(sanitizeParagraphText('a\u2028b', 512)).toBe('a\nb');
    expect(sanitizeParagraphText('a\u2029b', 512)).toBe('a\nb');
  });

  it('пустых строк подряд остаётся не больше одной', () => {
    // Описание в 512 символов может состоять из 512 переводов строки: это не
    // текст, а способ растянуть карточку группы на весь экран у всех.
    expect(sanitizeParagraphText('a\n\n\n\n\n\nb', 512)).toBe('a\n\nb');
    expect(sanitizeParagraphText('a\n\nb', 512)).toBe('a\n\nb');
    expect(sanitizeParagraphText('a\nb', 512)).toBe('a\nb');
    expect(sanitizeParagraphText('a\n  \n\t\nb', 512)).toBe('a\n\nb');
    expect(sanitizeParagraphText('\n'.repeat(512) + 'хвост', 512)).toBe('хвост');
  });

  it('текст из одних переводов строки — это отсутствие текста', () => {
    for (const v of ['', '   ', '\n\n\n', '\r\n\r\n', '\u2028\u2029', '\u200D\u2800', '\x00\x07']) {
      expect([JSON.stringify(v), sanitizeParagraphText(v, 512)]).toEqual([JSON.stringify(v), null]);
    }
  });

  it('не строка — тоже отсутствие текста', () => {
    for (const v of [null, undefined, 42, {}, ['a']]) {
      expect(sanitizeParagraphText(v, 512)).toBeNull();
    }
  });

  it('длина ограничивается, хвостовой пробел не остаётся', () => {
    expect(sanitizeParagraphText('я'.repeat(600), 512)).toBe('я'.repeat(512));
    // Обрезка может оставить на конце пробел или перевод строки — их не видно,
    // а высоту карточки они меняют.
    expect(sanitizeParagraphText('абв   \nгд', 5)).toBe('абв');
  });

  it('обычное описание не меняется', () => {
    const s = 'Клуб любителей чая.\n\nВстречаемся по четвергам в 19:00.';
    expect(sanitizeParagraphText(s, 512)).toBe(s);
    expect(sanitizeParagraphText('\u{1F642} привет', 512)).toBe('\u{1F642} привет');
    // Арабский и иврит от вырезания меток не страдают: направление задаёт сам
    // текст.
    expect(sanitizeParagraphText('\u0645\u0631\u062D\u0628\u0627', 512)).toBe('\u0645\u0631\u062D\u0628\u0627');
  });
});
