/**
 * Значок со словом рядом — тоже кнопка, и озвучка обязана это слышать
 * (v4.32.982).
 *
 * Дефект. Правило v4.32.950 закрыло нажимаемые, внутри которых нет ничего,
 * кроме надписи. Следующий по частоте вид — значок и одна надпись рядом:
 * «Удалить» с корзиной, «Переслать» со стрелкой, «Открыть» с кружком
 * ожидания. Восемьдесят таких мест роли не имели вовсе, и озвучка читала их
 * обычным текстом: слово произносилось, «кнопка» после него — нет, в обход по
 * элементам управления место не попадало.
 *
 * Цена. Видно на одном диалоге. В настройках («Открыть зашифрованную копию»,
 * «Включить вход по лицу», «Привязать Apple ID») соседняя «Отмена» роль в
 * v4.32.950 получила — внутри у неё только надпись. А «Открыть», «Включить»,
 * «Продолжить» не получили: рядом с надписью стоит кружок ожидания. Итог —
 * диалог, в котором на ощупь находится только отказ. Подтвердить нечем.
 *
 * Правка. Роль на каждое из этих мест. Не всем «кнопка»: галочки опроса
 * («Режим викторины», «Скрыть имена голосовавших», «Несколько вариантов») —
 * это `checkbox` с `checked`, полосы вкладок в «Медиа и файлах» и во вложениях
 * — `tab` с `selected`, а две ссылки в профиле на 𝕏 и GitHub — `link`, потому
 * что они уводят из приложения. Переключатели, у которых нажатие не делает
 * дела, а меняет выбор («Канал»/«Группа», режим опроса, метка места, сердце
 * под комментарием), остались кнопками, но получили `selected`.
 *
 * Границы. Правило по-прежнему узкое: ровно одна надпись и ровно один спутник,
 * и спутник этот — значок известного семейства либо кружок ожидания. Место, где
 * внутри две надписи или своя разметка, под правило не попадает: там с равным
 * правом строка списка, и «кнопка» соврала бы не реже, чем молчание. Обёртка
 * `AppPressable` роли по умолчанию так и не выдаёт (см. её собственную запись)
 * — именно поэтому пропуск здесь означает тишину, а не значение по умолчанию.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const UI = join(__dirname, '..');

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Открывающий тег целиком: `{}` и кавычки внутри не обрывают его. */
function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return source.slice(from, i + 1);
  }
  return source.slice(from);
}

const PRESSABLE = /<(AppPressable|Pressable|TouchableOpacity)\b/g;
/** Семейства значков, которые в доме и используются. */
const ICON = /^(Ionicons|MaterialIcons|MaterialCommunityIcons|Feather|FontAwesome\d*|AntDesign|Entypo|Octicons)$/;

/** Спутник надписи: значок или кружок ожидания. */
function isCompanion(name: string): boolean {
  return name === 'ActivityIndicator' || ICON.test(name);
}

type Site = { file: string; line: number; label: string; tag: string };

/** Нажимаемые, внутри которых ровно одна надпись и ровно один её спутник. */
function scanIconButtons(): Site[] {
  const out: Site[] = [];
  for (const full of collect(UI)) {
    const src = readFileSync(full, 'utf8');
    const file = relative(UI, full);
    PRESSABLE.lastIndex = 0;
    for (let m = PRESSABLE.exec(src); m !== null; m = PRESSABLE.exec(src)) {
      const tag = openingTag(src, m.index);
      if (tag.endsWith('/>')) continue;
      const bodyStart = m.index + tag.length;
      const bodyEnd = src.indexOf(`</${m[1]}>`, bodyStart);
      if (bodyEnd === -1) continue;
      const body = src.slice(bodyStart, bodyEnd);
      const elements = [...body.matchAll(/<([A-Z][\w.]*)/g)].map((e) => e[1]);
      if (elements.length !== 2) continue;
      if (elements.filter((e) => e === 'Text').length !== 1) continue;
      if (!elements.some(isCompanion)) continue;
      const textAt = body.indexOf('<Text');
      const textTag = openingTag(body, textAt);
      const inner = body.slice(textAt + textTag.length, body.lastIndexOf('</Text>')).trim();
      out.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        label: inner.replace(/\s+/g, ' ').slice(0, 60),
        tag,
      });
    }
  }
  return out;
}

const sites = scanIconButtons();
const at = (...parts: string[]): Site | undefined => {
  const line = Number(parts[parts.length - 1]);
  const file = join(...parts.slice(0, -1));
  return sites.find((s) => s.file === file && s.line === line);
};

describe('ПРОВЕРКА НЕ ПУСТАЯ: обход находит значок с надписью', () => {
  it('таких мест в доме не меньше девяноста', () => {
    expect(sites.length).toBeGreaterThanOrEqual(90);
  });

  it('разбор тега не обрывается на «>» внутри выражения и кавычек', () => {
    expect(openingTag('<A n={x > 1 ? 2 : 3} b="c>d">тело', 0)).toBe('<A n={x > 1 ? 2 : 3} b="c>d">');
  });

  it('спутником считается значок или кружок ожидания, но не что угодно', () => {
    expect(isCompanion('Ionicons')).toBe(true);
    expect(isCompanion('ActivityIndicator')).toBe(true);
    expect(isCompanion('FontAwesome5')).toBe(true);
    expect(isCompanion('View')).toBe(false);
    expect(isCompanion('Text')).toBe(false);
  });

  it('часть таких мест роль имела и до правки — обход не «всё подряд»', () => {
    // Если бы обход собирал только безролевые, пустой список ниже ничего бы
    // не доказывал: он был бы пуст и на неправленом дереве.
    const withRole = sites.filter((s) => /accessibilityRole=/.test(s.tag));
    expect(withRole.length).toBeGreaterThanOrEqual(10);
  });

  it('роль берётся из короткого списка, а не придумывается на месте', () => {
    const allowed = new Set(['button', 'link', 'checkbox', 'tab', 'radio', 'text', 'switch']);
    const odd = sites
      .map((s) => [s, /accessibilityRole="([^"]+)"/.exec(s.tag)] as const)
      .filter(([, m]) => m !== null && !allowed.has(m[1]))
      .map(([s, m]) => `${s.file}:${s.line} ${m?.[1]}`);
    expect(odd).toEqual([]);
  });

  it('найдены и «Удалить», и кружок ожидания в настройках', () => {
    expect(sites.filter((s) => s.label === 'Удалить').length).toBeGreaterThanOrEqual(2);
    expect(at('screens', 'SettingsScreen.tsx', '2961')?.label).toBe('Открыть');
  });
});

describe('ЗАКРЕПКА: у каждого такого места роль есть', () => {
  it('без роли не осталось ни одного', () => {
    const bad = sites
      .filter((s) => !/accessibilityRole=/.test(s.tag))
      .map((s) => `${s.file}:${s.line} (${s.label})`);
    expect(bad).toEqual([]);
  });

  it('«Открыть» и «Включить» в настройках слышны так же, как соседняя «Отмена»', () => {
    // Ровно тот диалог, на котором виден перекос: отказ находился на ощупь,
    // подтверждение — нет.
    for (const line of ['2961', '2988', '3017']) {
      expect(at('screens', 'SettingsScreen.tsx', line)?.tag).toContain('accessibilityRole="button"');
    }
  });

  it('заглушка «нажмите, чтобы загрузить» тоже кнопка — она вне обхода', () => {
    // Внутри у неё `View` с надписью, спутника-значка нет: правило её не
    // ловит, поэтому сторожим по имени.
    for (const rel of [['screens', 'chat-components', 'GroupPhotoGrid.tsx'],
                       ['screens', 'chat-components', 'MediaStrip.tsx']]) {
      const src = readFileSync(join(UI, ...rel), 'utf8');
      expect(src).toContain('<AppPressable accessibilityRole="button" onPress={() => setWanted(true)}>');
    }
  });
});

describe('ЗАКРЕПКА: выбор не назван командой', () => {
  it('галочки опроса объявлены галочками и говорят, отмечены ли', () => {
    const boxes: [string[], string][] = [
      [['components', 'modals', 'chat', 'ChatPollCreatorModal.tsx', '109'], 'isQuiz'],
      [['components', 'modals', 'chat', 'ChatPollCreatorModal.tsx', '113'], 'anonymous'],
      [['components', 'modals', 'groups', 'GroupPollCreatorModal.tsx', '123'], 'isQuiz'],
      [['components', 'modals', 'groups', 'GroupPollCreatorModal.tsx', '132'], 'allowMultiple'],
      [['components', 'modals', 'groups', 'GroupPollCreatorModal.tsx', '138'], 'anonymous'],
      [['screens', 'FeedScreen.tsx', '3716'], 'pollAnonymous'],
      [['screens', 'FeedScreen.tsx', '3724'], 'pollMultiSelect'],
    ];
    for (const [parts, flag] of boxes) {
      const tag = at(...parts)?.tag;
      expect(tag).toContain('accessibilityRole="checkbox"');
      expect(tag).toContain(`accessibilityState={{ checked: ${flag} }}`);
    }
  });

  it('полосы вкладок объявлены вкладками и говорят, какая открыта', () => {
    expect(at('components', 'AttachSheet.tsx', '295')?.tag)
      .toContain('accessibilityRole="tab" accessibilityState={{ selected: isActive }}');
    for (const parts of [['components', 'modals', 'chat', 'ChatSharedMediaModal.tsx', '454'],
                         ['components', 'modals', 'groups', 'GroupSharedMediaModal.tsx', '154']]) {
      expect(at(...parts)?.tag)
        .toContain('accessibilityRole="tab" accessibilityState={{ selected: activeTab === tab.id }}');
    }
  });

  it('«Канал»/«Группа» — выбор, и озвучка слышит, какой сделан', () => {
    expect(at('components', 'modals', 'groups', 'GroupCreateModal.tsx', '208')?.tag)
      .toContain('accessibilityState={{ selected: type === t }}');
  });

  it('ссылки на 𝕏 и GitHub названы ссылками: они уводят из приложения', () => {
    // По надписи, а не по номеру строки: номер съезжал от любой правки выше
    // по файлу, и закрепка падала там, где роль была на месте (v4.32.993).
    for (const label of ['𝕏 @{twitterHandle}', '⌥ {githubHandle}']) {
      const site = sites.find((s) => s.file === join('screens', 'ProfileScreen.tsx') && s.label === label);
      expect(site?.tag).toContain('accessibilityRole="link"');
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('обёртка по-прежнему не выдаёт роль по умолчанию', () => {
    // Без этого пропуск роли был бы безобидным: «кнопка» звучала бы сама.
    const wrapper = readFileSync(join(UI, 'components', 'AppPressable.tsx'), 'utf8');
    expect(wrapper).toContain('По умолчанию роли НЕТ, и это намеренно');
    expect(wrapper).not.toContain('accessibilityRole="button"');
  });

  it('правило v4.32.950 этот вид намеренно не ловило', () => {
    // Оно требовало РОВНО одну надпись и ничего больше. Значок рядом выводил
    // место из-под правила — отсюда и диалог с одной найденной кнопкой.
    const src = readFileSync(join(UI, '__tests__', 'wordedButtonRoleA11y950.test.ts'), 'utf8');
    expect(src).toContain("if (elements.length !== 1 || elements[0] !== 'Text') continue;");
    const settings = readFileSync(join(UI, 'screens', 'SettingsScreen.tsx'), 'utf8');
    const open = settings.indexOf('>Открыть</Text>');
    expect(open).toBeGreaterThan(0);
    const start = settings.lastIndexOf('<AppPressable', open);
    expect(openingTag(settings, start).length).toBeGreaterThan(0);
    // Внутри — и кружок ожидания, и надпись: две сущности, не одна.
    expect(settings.slice(start, open)).toContain('<ActivityIndicator');
  });

  it('правило остаётся узким: место с двумя надписями роли не требует', () => {
    let wide = 0;
    for (const full of collect(UI)) {
      const src = readFileSync(full, 'utf8');
      PRESSABLE.lastIndex = 0;
      for (let m = PRESSABLE.exec(src); m !== null; m = PRESSABLE.exec(src)) {
        const tag = openingTag(src, m.index);
        if (tag.endsWith('/>') || /accessibilityRole=/.test(tag)) continue;
        const bodyStart = m.index + tag.length;
        const bodyEnd = src.indexOf(`</${m[1]}>`, bodyStart);
        if (bodyEnd === -1) continue;
        const body = src.slice(bodyStart, bodyEnd);
        const elements = [...body.matchAll(/<([A-Z][\w.]*)/g)].map((e) => e[1]);
        if (elements.filter((e) => e === 'Text').length >= 2) wide += 1;
      }
    }
    expect(wide).toBeGreaterThanOrEqual(20);
  });
});
