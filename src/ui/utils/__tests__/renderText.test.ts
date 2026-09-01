/**
 * Подготовка чужого текста к показу (v4.32.327).
 */
import { MAX_RENDER_SEGMENTS, sanitizeBodyForRender } from '../renderText';

const RLO = '\u202E';
const LRO = '\u202D';
const ZWSP = '\u200B';
const BOM = '\uFEFF';

describe('символы направления письма', () => {
  it('переворот строки не доезжает до экрана', () => {
    // Так подделывается видимое расширение: человек читает «…fdp.exe».
    expect(sanitizeBodyForRender(`http://a.tld/otchet${RLO}exe.pdf`)).toBe(
      'http://a.tld/otchetexe.pdf'
    );
  });

  it('вырезаются и соседние метки, и невидимая длина', () => {
    expect(sanitizeBodyForRender(`${LRO}a${ZWSP}b${BOM}`)).toBe('ab');
  });

  it('арабский и иврит не страдают', () => {
    const s = 'مرحبا שלום';
    expect(sanitizeBodyForRender(s)).toBe(s);
  });

  it('склейка эмодзи остаётся', () => {
    // U+200D держит вместе составные эмодзи — без неё семья распадается.
    const family = '\u{1F469}\u200D\u{1F467}';
    expect(sanitizeBodyForRender(family)).toBe(family);
  });
});

describe('управляющие символы', () => {
  it('переводы строк, возврат каретки и табуляция сохраняются', () => {
    expect(sanitizeBodyForRender('a\nb\r\nc\td')).toBe('a\nb\r\nc\td');
  });

  it('остальные C0 и DEL уходят', () => {
    expect(sanitizeBodyForRender('a\u0000b\u0007c\u001Bd\u007Fe')).toBe('abcde');
  });

  it('префикс системной строки перестаёт быть невидимым', () => {
    // '\x0bsys:' — метка «это голос приложения»; сам \x0b невидим.
    expect(sanitizeBodyForRender('\x0bsys:Группа переименована')).toBe(
      'sys:Группа переименована'
    );
  });
});

describe('края', () => {
  it('не строка — пустая строка', () => {
    expect(sanitizeBodyForRender(undefined as unknown as string)).toBe('');
    expect(sanitizeBodyForRender(null as unknown as string)).toBe('');
    expect(sanitizeBodyForRender(42 as unknown as string)).toBe('');
  });

  it('обычный текст не меняется', () => {
    const s = 'Привет! **жирный** и http://example.com/a?b=1';
    expect(sanitizeBodyForRender(s)).toBe(s);
  });

  it('предел разметки задан и вменяем', () => {
    expect(MAX_RENDER_SEGMENTS).toBeGreaterThan(50);
    expect(MAX_RENDER_SEGMENTS).toBeLessThan(2000);
  });
});
