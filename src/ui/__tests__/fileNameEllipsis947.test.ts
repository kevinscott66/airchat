/**
 * Имя файла обрезается посередине, а не по хвосту (v4.32.947).
 *
 * Дефект. `ellipsizeMode` в проекте не задан ни разу: ни одного вхождения на
 * весь `src`. React Native в этом случае обрезает по хвосту, и для имени
 * человека или группы это верно — отличают их начало. Для имени файла всё
 * наоборот: «Договор аренды квартиры на Ленина подписанный.pdf» в строке на
 * сорок знаков превращается в «Договор аренды квартиры на Ленина под…», и
 * пропадает ровно то, по чему файл узнают, — расширение. В списке общих
 * файлов, где рядом лежат `.pdf`, `.docx` и `.zip` с похожими началами,
 * различить их становится нечем; значок слева рисует «документ» для всего
 * подряд.
 *
 * Цена. Озвучка читает полное имя из свойства, а глазами человек видит
 * обрубок. Нажать приходится наугад, а нажатие здесь открывает файл во
 * внешнем приложении — то есть цена промаха не «не туда посмотрел», а
 * «открыл не тот файл не той программой».
 *
 * Правка. `ellipsizeMode="middle"` на тех и только тех строках, которые рисуют
 * имя файла. В доме такое имя зовут `doc.name` или `meta.name`; имя человека,
 * группы и канала приходит под другими именами и обрезается по-прежнему.
 *
 * Границы. Правило узкое намеренно, и вот чего оно НЕ трогает:
 *
 *   • Адрес ссылки (`link.url` в общих ссылках группы). Обрезка по хвосту
 *     сохраняет схему и хост — ровно ту часть, по которой человек решает,
 *     безопасно ли открывать. Середина съела бы хост.
 *   • Имя файла в две строки (`DocBubble`, крупный вид). На Android
 *     `middle` при `numberOfLines > 1` не работает вовсе, и обещать его там
 *     значило бы разойтись с тем, что видно на устройстве.
 *   • Имена людей, групп и каналов — их узнают по началу.
 *
 * Храповик держит границу с обеих сторон: новое `{что-то.name}` в одну строку
 * под неизвестным именем переменной роняет проверку, пока его не отнесли к
 * файлам или к не-файлам осознанно.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const UI = join(__dirname, '..');

/** Имена переменных, под которыми в доме ездит описание файла. */
const FILE_VARS = new Set(['doc', 'meta']);
/**
 * Имена, под которыми ездит человек, группа или профиль. Их узнают по началу,
 * и обрезка по хвосту там верна.
 */
const OTHER_VARS = new Set(['item', 'who', 'profile', 'g', 'group']);

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Открывающий тег целиком — от `<` до отвечающей ему `>`.
 *
 * Первая попавшаяся `>` не годится: в доме внутри тега встречаются и `size >
 * 1 ?` в фигурных скобках, и `>` внутри строки. Считаем глубину скобок и
 * помним, что мы внутри кавычек.
 */
function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (c === '>' && depth === 0) return source.slice(from, i + 1);
  }
  return source.slice(from);
}

/** Строка `<Text>`, всё содержимое которой — одно выражение `{что-то.name}`. */
type NameText = {
  file: string;
  line: number;
  /** Имя переменной слева от `.name`. */
  variable: string;
  /** Значение `numberOfLines`, как оно написано в теге (или null). */
  lines: string | null;
  tag: string;
};

function scanNameTexts(): NameText[] {
  const out: NameText[] = [];
  for (const full of collect(UI)) {
    const src = readFileSync(full, 'utf8');
    const file = relative(UI, full);
    for (let i = src.indexOf('<Text'); i !== -1; i = src.indexOf('<Text', i + 1)) {
      // `<TextInput` — не тот тег.
      if (/[A-Za-z]/.test(src[i + 5] ?? '')) continue;
      const tag = openingTag(src, i);
      if (tag.endsWith('/>')) continue;
      const bodyStart = i + tag.length;
      const bodyEnd = src.indexOf('</Text>', bodyStart);
      if (bodyEnd === -1) continue;
      const body = src.slice(bodyStart, bodyEnd).trim();
      const hit = /^\{\s*([A-Za-z_$][\w$]*)\.name\s*\}$/.exec(body);
      if (!hit) continue;
      const nl = /numberOfLines=\{([^}]*)\}/.exec(tag);
      out.push({
        file,
        line: src.slice(0, i).split('\n').length,
        variable: hit[1],
        lines: nl ? nl[1].trim() : null,
        tag,
      });
    }
  }
  return out;
}

const FOUND = scanNameTexts();
const at = (n: NameText): string => `${n.file}:${n.line}`;

describe('ПРОВЕРКА НЕ ПУСТАЯ: обход экранов что-то находит', () => {
  it('файлов с разметкой набралось много', () => {
    expect(collect(UI).length).toBeGreaterThan(80);
  });

  it('строки «имя чего-то» найдены, и их несколько', () => {
    expect(FOUND.length).toBeGreaterThanOrEqual(7);
  });

  it('разбор тега не съедает `>` внутри выражения', () => {
    expect(openingTag('<Text numberOfLines={n > 1 ? 2 : 1}>x', 0))
      .toBe('<Text numberOfLines={n > 1 ? 2 : 1}>');
    expect(openingTag('<Text a="b>c">x', 0)).toBe('<Text a="b>c">');
  });
});

describe('имя файла в одну строку обрезается посередине', () => {
  const single = FOUND.filter((n) => FILE_VARS.has(n.variable) && n.lines === '1');

  it('такие строки вообще есть', () => {
    expect(single.length).toBeGreaterThanOrEqual(5);
  });

  for (const n of FOUND.filter((x) => FILE_VARS.has(x.variable) && x.lines === '1')) {
    it(`${at(n)}: ellipsizeMode="middle"`, () => {
      expect(n.tag).toContain('ellipsizeMode="middle"');
    });
  }
});

describe('чего правка не касается', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: имя группы по-прежнему обрезается по хвосту', () => {
    const others = FOUND.filter((n) => OTHER_VARS.has(n.variable));
    expect(others.length).toBeGreaterThan(0);
    for (const n of others) expect(n.tag).not.toContain('ellipsizeMode');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: крупное имя файла в две строки не трогали', () => {
    const multi = FOUND.filter((n) => FILE_VARS.has(n.variable) && n.lines !== '1');
    expect(multi.length).toBeGreaterThan(0);
    for (const n of multi) expect(n.tag).not.toContain('ellipsizeMode');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: адрес ссылки сохраняет начало', () => {
    const src = readFileSync(
      join(UI, 'components/modals/groups/GroupSharedMediaModal.tsx'), 'utf8',
    );
    expect(src).toContain('numberOfLines={1}>{link.url}</Text>');
    expect(src).not.toMatch(/ellipsizeMode[^\n]*\n?[^\n]*\{link\.url\}/);
  });
});

describe('храповик: незнакомое имя переменной надо отнести руками', () => {
  it('других имён, кроме разобранных, не появилось', () => {
    const unknown = [...new Set(
      FOUND.filter((n) => !FILE_VARS.has(n.variable) && !OTHER_VARS.has(n.variable))
        .map((n) => `${n.variable} (${at(n)})`),
    )];
    expect(unknown).toEqual([]);
  });
});
