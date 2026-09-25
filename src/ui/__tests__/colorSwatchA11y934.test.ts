/**
 * Образцы цвета: кружок без подписи (v4.32.934).
 *
 * Дефект. В приложении три сетки цветных кружков: цвет акцента в настройках,
 * цветовая метка переписки в списке чатов и фон текстовой сторис. Внутри
 * кружка нет ничего, кроме заливки и — иногда — галочки. Для озвучки такой
 * кружок пуст: у метки и у фона она читала «кнопка» и порядковый номер
 * («Фон 3»), а какой из семи выбран сейчас, не сообщала вовсе.
 *
 * Цена. Выбрать метку переписки вслепую было нельзя в принципе: семь
 * одинаковых «кнопка» подряд, и единственный способ узнать, какая где, —
 * нажать и посмотреть, что изменилось. У метки это ещё и запись в базу.
 *
 * Правка. Название цвета лежит рядом с самим цветом — в той же записи
 * палитры, — и в разметку попадает ссылкой на него, а не вторым набором слов.
 * Так уже был сделан акцент (v4.32.347: «Скринридер читал вслух
 * шестнадцатеричный код»), теперь так же сделаны метка и фон.
 *
 * Границы. Храповик стережёт три известные палитры и три места, где они
 * раскладываются в кружки. Он не требует подписи от всякого нажимаемого — на
 * это есть iconButtonA11y933; он требует, чтобы у образца цвета было имя,
 * чтобы имя приходило из палитры и чтобы выбранный образец объявлял себя
 * выбранным.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const THEME = read('ui/theme.ts');
const FOLDERS = read('core/storage/chatFolders.ts');

/** Записи палитры: имя поля с цветом и имя поля с названием. */
function paletteEntries(source: string, constName: string, hexKey: string, nameKey: string) {
  const start = source.indexOf(`export const ${constName} = [`);
  if (start < 0) return [];
  const end = source.indexOf('] as const;', start);
  const body = source.slice(start, end);
  // Порядок полей в записи разный (у метки название стоит первым), поэтому
  // разбирается запись целиком, а поля ищутся в ней по имени.
  const out: { hex: string; name: string }[] = [];
  for (const rec of body.matchAll(/\{[^{}]*\}/g)) {
    const hex = new RegExp(`\\b${hexKey}:\\s*'(#[0-9a-fA-F]{6})'`).exec(rec[0]);
    const nm = new RegExp(`\\b${nameKey}:\\s*'([^']*)'`).exec(rec[0]);
    if (hex && nm) out.push({ hex: hex[1], name: nm[1] });
  }
  return out;
}

/**
 * Открывающий тег элемента целиком, от `<` до парного `>`: скобка внутри
 * `{...}`, кавычек или шаблонной строки тегом не заканчивает.
 */
function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return source.slice(from, i + 1);
  }
  return '';
}

/** Первый нажимаемый элемент после раскладки палитры в кружки. */
function swatchTag(source: string, mapMarker: string): string {
  const at = source.indexOf(mapMarker);
  if (at < 0) return '';
  const press = source.indexOf('<AppPressable', at);
  if (press < 0) return '';
  return openingTag(source, press);
}

const PALETTES = [
  { name: 'ACCENT_SWATCHES', entries: paletteEntries(THEME, 'ACCENT_SWATCHES', 'hex', 'name'), least: 9 },
  { name: 'STORY_TEXT_BACKGROUNDS', entries: paletteEntries(THEME, 'STORY_TEXT_BACKGROUNDS', 'hex', 'name'), least: 6 },
  { name: 'FOLDER_COLORS', entries: paletteEntries(FOLDERS, 'FOLDER_COLORS', 'value', 'label'), least: 7 },
];

const SITES = [
  {
    what: 'цвет акцента',
    tag: swatchTag(read('ui/screens/SettingsScreen.tsx'), '...ACCENT_SWATCHES].map('),
    nameRef: 'entry.name',
  },
  {
    what: 'фон текстовой сторис',
    tag: swatchTag(read('ui/components/StoryComposerModal.tsx'), 'STORY_TEXT_BACKGROUNDS.map('),
    nameRef: 'bg.name',
  },
  {
    what: 'цветовая метка переписки',
    tag: swatchTag(read('ui/screens/ChatListScreen.tsx'), 'FOLDER_COLORS.map('),
    nameRef: 'ct.label',
  },
];

describe('образцы цвета названы', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: файлы читаются, все три сетки кружков найдены', () => {
    // Держится и до правки: образец акцента назван с 347-го, и по нему видно,
    // что разбор палитры работает, а не молча возвращает пустоту.
    expect(PALETTES).toHaveLength(3);
    expect(PALETTES[0].entries.length).toBeGreaterThanOrEqual(9);
    expect(SITES).toHaveLength(3);
    for (const s of SITES) {
      expect(s.tag.startsWith('<AppPressable')).toBe(true);
      expect(s.tag.endsWith('>')).toBe(true);
    }
  });

  it('в каждой палитре названы все образцы', () => {
    for (const p of PALETTES) {
      expect(`${p.name}: ${p.entries.length} названо`).toBe(`${p.name}: ${p.least} названо`);
    }
  });

  it('у каждого образца есть название по-русски, а не код цвета', () => {
    for (const p of PALETTES) {
      for (const e of p.entries) {
        expect(`${p.name}: ${e.hex} → «${e.name}»`).toBe(`${p.name}: ${e.hex} → «${e.name}»`);
        expect(e.name.trim().length).toBeGreaterThan(2);
        expect(e.name).toMatch(/^[а-яё-]+(?: [а-яё-]+)*$/i);
        expect(e.name).not.toMatch(/#|[0-9]/);
      }
    }
  });

  it('названия внутри палитры не повторяются — иначе выбор вслепую неразличим', () => {
    for (const p of PALETTES) {
      const names = p.entries.map((e) => e.name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: кружок пуст — подписи внутри него нет', () => {
    // Держится и до правки, и после: образец — это заливка, и единственное,
    // что там бывает нарисовано, — галочка выбранного. Значит имя может
    // прийти только из accessibilityLabel.
    for (const s of SITES) {
      expect(s.tag).not.toContain('<Text');
    }
  });

  it('образец объявлен кнопкой и назван', () => {
    for (const s of SITES) {
      expect(`${s.what}: ${/accessibilityRole="button"/.test(s.tag) ? 'роль есть' : 'роли нет'}`)
        .toBe(`${s.what}: роль есть`);
      expect(`${s.what}: ${/accessibilityLabel=/.test(s.tag) ? 'имя есть' : 'без имени'}`)
        .toBe(`${s.what}: имя есть`);
    }
  });

  it('имя образца берётся из палитры, а не набрано в разметке заново', () => {
    for (const s of SITES) {
      const label = /accessibilityLabel=(\{[\s\S]*?\}|"[^"]*")/.exec(s.tag);
      expect(label).not.toBeNull();
      const expr = label ? label[1] : '';
      expect(`${s.what}: ${expr.includes(s.nameRef) ? 'из палитры' : expr}`)
        .toBe(`${s.what}: из палитры`);
    }
  });

  it('порядковый номер именем не считается', () => {
    // Прежняя подпись фона сторис была `Фон ${i + 1}`: она не описывает
    // кружок и меняется от перестановки набора.
    for (const s of SITES) {
      const label = /accessibilityLabel=(\{[\s\S]*?\}|"[^"]*")/.exec(s.tag);
      const expr = label ? label[1] : '';
      expect(`${s.what}: ${/\bi\s*\+\s*1\b|\bindex\b/.test(expr) ? 'номер' : 'имя'}`)
        .toBe(`${s.what}: имя`);
    }
  });

  it('выбранный образец объявляет себя выбранным', () => {
    for (const s of SITES) {
      expect(`${s.what}: ${/accessibilityState=\{\{[^}]*selected/.test(s.tag) ? 'состояние есть' : 'состояния нет'}`)
        .toBe(`${s.what}: состояние есть`);
    }
  });

  it('разбор тега не обманывается скобкой внутри выражения', () => {
    const sample = '<AppPressable a={x > 1 ? "> " : `${y}`} b="c>d" />\n<Text>';
    expect(openingTag(sample, 0)).toBe('<AppPressable a={x > 1 ? "> " : `${y}`} b="c>d" />');
  });

  it('дословный вид до правки провалил бы проверку', () => {
    const before = [
      '<AppPressable',
      '  key={color}',
      '  accessibilityLabel={`Фон ${i + 1}`}',
      '  onPress={() => setBgIdx(i)}',
      '>',
    ].join('\n');
    expect(/accessibilityRole="button"/.test(before)).toBe(false);
    expect(/accessibilityState=\{\{[^}]*selected/.test(before)).toBe(false);
    const label = /accessibilityLabel=(\{[\s\S]*?\}|"[^"]*")/.exec(before);
    expect(label).not.toBeNull();
    expect(/\bi\s*\+\s*1\b/.test(label ? label[1] : '')).toBe(true);
  });
});
