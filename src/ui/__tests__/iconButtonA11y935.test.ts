/**
 * Храповик на кнопку из одного значка — любого, не только крестика.
 *
 * Дефект. Храповик `iconButtonA11y933` знал пять имён значков: `close`,
 * `close-outline`, `close-circle`, `chevron-back`, `arrow-back`. Всё
 * остальное он пропускал. За этой границей осталось сорок восемь нажимаемых
 * мест, внутри которых лежит только значок и ничего больше: карандаш и
 * корзина у шаблонов ответов, стрелки «предыдущее/следующее совпадение» в
 * поиске по переписке, скрепка и фотоаппарат, «отправить» в пересылке,
 * «открепить» в списке закреплённых, «правильный ответ» в создании опроса.
 * Одиннадцать из них имя уже имели, но не имели роли: озвучка читала слово,
 * не сообщая, что это можно нажать.
 *
 * Цена. Такая кнопка звучит как «кнопка» — и всё. В шапке переписки их
 * четыре подряд, в просмотре опроса две, в списке шаблонов по две на каждую
 * строку. Различить их на слух нечем; остаётся нажимать и смотреть, что
 * вышло, а часть из них удаляет.
 *
 * Правка. Имя даётся действию, а не рисунку. Раскладки «значок → слово» не
 * существует, и этот выпуск тому лишнее доказательство:
 * `close-circle-outline` значит «открепить» в списке закреплённых и
 * «закрыть» в остальных местах; `chevron-down` значит «следующее совпадение»
 * в поиске по группе и перелистывание в других; а у кнопки закреплённых
 * слово вообще зависит от числа — «Все закреплённые» при нескольких и
 * «Открепить» при одном. Переключателям (фильтры ленты, «показать один раз»,
 * «правильный ответ») добавлено `accessibilityState.selected`: без него
 * озвучка не скажет, включён фильтр или нет.
 *
 * Границы. Правило требует имя и роль только там, где внутри нажимаемого
 * нет нарисованного текста и нет вложенной кнопки. Есть `<Text>` — имя уже
 * нарисовано; есть вложенная кнопка — имя принадлежит ей, а не обёртке.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const UI = join(__dirname, '..');

/** Все семейства значков, которыми в доме рисуют кнопки. */
const ICON = /<(?:Ionicons|MaterialCommunityIcons|MaterialIcons|Feather)\b/;
const PRESSABLE = /(AppPressable|Pressable|TouchableOpacity)/;

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
 * Наивный поиск первой `>` ломается на обычном для дома коде: `size > 1 ?`
 * внутри фигурных скобок, `>` внутри строки, `${…}` внутри шаблона. Поэтому
 * считаем глубину фигурных скобок и помним, что мы внутри кавычек.
 */
export function openingTag(source: string, from: number): string {
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

/** Содержимое нажимаемого: от конца открывающего тега до своей закрывашки. */
function bodyOf(source: string, from: number, tag: string): string {
  const open = openingTag(source, from);
  if (/\/>\s*$/.test(open)) return '';
  let i = from + open.length;
  const start = i;
  let depth = 1;
  const openRe = new RegExp('<' + tag + '\\b', 'g');
  const closeRe = new RegExp('</' + tag + '>', 'g');
  while (depth > 0 && i < source.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(source);
    const c = closeRe.exec(source);
    if (!c) break;
    if (o && o.index < c.index) {
      // Вложенная кнопка того же имени: она закроется своей закрывашкой.
      if (!/\/>\s*$/.test(openingTag(source, o.index))) depth++;
      i = o.index + 1;
      continue;
    }
    depth--;
    i = c.index + c[0].length;
    if (depth === 0) return source.slice(start, c.index);
  }
  return source.slice(start, i);
}

export type Site = { file: string; line: number; tag: string; body: string };

/** Нажимаемое, внутри которого только значок: ни текста, ни вложенной кнопки. */
export function iconOnlySites(file: string, source: string): Site[] {
  const out: Site[] = [];
  const re = /<(AppPressable|Pressable|TouchableOpacity)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const body = bodyOf(source, m.index, m[1]);
    if (!ICON.test(body)) continue;
    if (body.includes('<Text')) continue;
    if (PRESSABLE.test(body.replace(/<(AppPressable|Pressable|TouchableOpacity)Props/g, ''))) continue;
    out.push({
      file,
      line: source.slice(0, m.index).split('\n').length,
      tag: openingTag(source, m.index),
      body,
    });
  }
  return out;
}

const FILES = collect(UI);
const SOURCES = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
const SITES = FILES.flatMap((f) => iconOnlySites(f, SOURCES.get(f) as string));

function short(s: Site): string {
  return `${s.file.slice(s.file.indexOf('/src/') + 1)}:${s.line}`;
}

function read(rel: string): string {
  return readFileSync(join(UI, rel), 'utf8');
}

describe('кнопка из одного значка называет своё действие', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: экраны читаются, кнопки-значки находятся', () => {
    expect(FILES.length).toBeGreaterThan(120);
    expect(SITES.length).toBeGreaterThan(100);
    expect(new Set(SITES.map((s) => s.file)).size).toBeGreaterThan(30);
  });

  it('разбор открывающего тега не спотыкается о `>` в скобках и кавычках', () => {
    const src = '<AppPressable a={x > 1 ? "> " : `${y}`} b="c>d" />\n<Foo />';
    expect(openingTag(src, 0)).toBe('<AppPressable a={x > 1 ? "> " : `${y}`} b="c>d" />');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: AppPressable не подставляет роль за вызывающего', () => {
    const src = read('components/AppPressable.tsx');
    expect(src).not.toMatch(/accessibilityRole\s*=\s*['"]button['"]/);
    expect(src).not.toMatch(/accessibilityRole\s*:\s*['"]button['"]/);
  });

  it('у каждой такой кнопки есть роль', () => {
    const mute = SITES.filter((s) => !/accessibilityRole=\{?["']button["']/.test(s.tag));
    expect(mute.map(short)).toEqual([]);
  });

  it('у каждой такой кнопки есть имя', () => {
    const mute = SITES.filter((s) => !/accessibilityLabel[=\s]/.test(s.tag));
    expect(mute.map(short)).toEqual([]);
  });

  it('имя называет действие, а не просит нажать', () => {
    const bad = SITES.filter((s) => /accessibilityLabel="[^"]*(?:[Нн]ажм|кнопк)/.test(s.tag));
    expect(bad.map(short)).toEqual([]);
  });

  it('у переключателей озвучен выбор', () => {
    const marks: Array<[string, string]> = [
      ['screens/FeedScreen.tsx', 'Только закладки'],
      ['screens/FeedScreen.tsx', 'Архив'],
      ['components/MediaPreviewModal.tsx', 'Показать один раз'],
      ['components/modals/chat/ChatPollCreatorModal.tsx', 'Правильный ответ'],
      ['components/modals/groups/GroupPollCreatorModal.tsx', 'Правильный ответ'],
    ];
    for (const [rel, label] of marks) {
      const hit = SITES.filter(
        (s) => s.file.endsWith(rel) && s.tag.includes(`accessibilityLabel="${label}"`),
      );
      expect({ rel, label, found: hit.length }).toEqual({ rel, label, found: 1 });
      expect(hit[0].tag).toMatch(/accessibilityState=\{\{[^}]*selected/);
    }
  });

  it('один значок — два действия: слово зависит от числа закреплённых', () => {
    const src = read('screens/ChatScreen.tsx');
    expect(src).toContain("accessibilityLabel={total > 1 ? 'Все закреплённые' : 'Открепить'}");
    expect(read('screens/GroupsScreen.tsx')).toMatch(
      /accessibilityLabel=\{[^}]*\?\s*'Все закреплённые'\s*:\s*'Открепить'\}/,
    );
  });

  it('одинаковый значок назван по-разному там, где делает разное', () => {
    const pinned = read('components/modals/chat/ChatPinnedListModal.tsx');
    expect(pinned).toMatch(/name="close-circle-outline"/);
    const unpin = SITES.find(
      (s) => s.file.endsWith('ChatPinnedListModal.tsx') && s.body.includes('close-circle-outline'),
    );
    expect(unpin?.tag).toContain('accessibilityLabel="Открепить"');
  });

  it('имя стоит на нажимаемой области, а не на значке внутри', () => {
    const src = read('screens/chat-components/MessageStatusIcon.tsx');
    expect(src).toContain('accessibilityLabel="Отправить ещё раз"');
    expect(src).not.toContain('accessibilityLabel="Нажмите для повтора"');
    for (const s of SITES) {
      expect(s.body).not.toMatch(/<(?:Ionicons|MaterialCommunityIcons|MaterialIcons|Feather)\b[^>]*accessibilityLabel/);
    }
  });
});
