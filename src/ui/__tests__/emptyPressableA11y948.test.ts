/**
 * Невидимое нажимаемое обязано называться (v4.32.948).
 *
 * Дефект. Храповики `iconButtonA11y933` и `935` требуют имя там, где внутри
 * нажимаемого нарисован значок. За их границей осталось то, внутри чего не
 * нарисовано вообще НИЧЕГО: пустое `<AppPressable>` на пол-экрана. Таких мест
 * было семь.
 *
 * Пять из них — подложки модальных листов: прозрачный прямоугольник во весь
 * экран, тап по которому закрывает лист. Два — полосы перелистывания в
 * просмотре сторис: левые 40 % экрана листают назад, правые 60 % вперёд.
 *
 * Цена. Озвучка объявляет такое место, но назвать его не может: имени нет, а
 * взять его неоткуда — внутри пусто. Человек слышит безымянную область поверх
 * всего остального. В подложке это досадно, в сторис — непроходимо: полосы
 * перелистывания были ЕДИНСТВЕННЫМ способом перейти к соседней сторис, и
 * способа этого у озвучки не было вовсе.
 *
 * Правка. Имя и роль на все семь. У сторис подписи разные по смыслу: правая
 * полоса на последней сторис не листает, а закрывает просмотр, и обещать
 * «следующая» там нельзя; левая на первой не делает ничего — это `disabled`,
 * а не молчание.
 *
 * Границы. Правило узкое: оно требует имя только там, где внутри нажимаемого
 * пусто. Нарисован текст — имя уже есть; нарисован значок — за это отвечают
 * храповики 933 и 935. Роль по умолчанию `AppPressable` не задаёт намеренно
 * (обёрткой сделаны и кнопки, и строки списков), и это правило её умолчания
 * не отменяет: оно говорит только про пустые.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const UI = join(__dirname, '..');
const PRESSABLE = /<(AppPressable|Pressable|TouchableOpacity)\b/g;

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
 * Первая попавшаяся `>` не годится: внутри тега встречаются и `n > 1 ?` в
 * фигурных скобках, и `>` внутри строки.
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

type Pressed = { at: string; tag: string; empty: boolean };

function scan(): Pressed[] {
  const out: Pressed[] = [];
  for (const full of collect(UI)) {
    const src = readFileSync(full, 'utf8');
    const where = relative(UI, full);
    PRESSABLE.lastIndex = 0;
    for (let m = PRESSABLE.exec(src); m; m = PRESSABLE.exec(src)) {
      const tag = openingTag(src, m.index);
      let body = '';
      if (!tag.endsWith('/>')) {
        const end = src.indexOf(`</${m[1]}>`, m.index + tag.length);
        if (end === -1) continue;
        body = src.slice(m.index + tag.length, end);
      }
      // Пусто — это когда внутри нет ни своей разметки, ни текста.
      const empty = !/<[A-Za-z]/.test(body) && body.trim() === '';
      out.push({ at: `${where}:${src.slice(0, m.index).split('\n').length}`, tag, empty });
    }
  }
  return out;
}

const ALL = scan();
const EMPTY = ALL.filter((p) => p.empty);

describe('ПРОВЕРКА НЕ ПУСТАЯ: обход что-то находит', () => {
  it('нажимаемых мест в разметке много', () => {
    expect(ALL.length).toBeGreaterThan(400);
  });

  it('пустые среди них есть — правило не про воображаемое', () => {
    expect(EMPTY.length).toBeGreaterThanOrEqual(7);
  });

  it('разбор тега не съедает `>` внутри выражения', () => {
    expect(openingTag('<Pressable style={{ w: n > 1 ? 2 : 1 }}>x', 0))
      .toBe('<Pressable style={{ w: n > 1 ? 2 : 1 }}>');
    expect(openingTag('<Pressable a="b>c" />x', 0)).toBe('<Pressable a="b>c" />');
  });
});

describe('у пустого нажимаемого есть имя и роль', () => {
  it('без подписи не осталось ни одного', () => {
    const nameless = EMPTY.filter((p) => !p.tag.includes('accessibilityLabel')).map((p) => p.at);
    expect(nameless).toEqual([]);
  });

  it('без роли не осталось ни одного', () => {
    const roleless = EMPTY.filter((p) => !p.tag.includes('accessibilityRole')).map((p) => p.at);
    expect(roleless).toEqual([]);
  });
});

describe('просмотр сторис: перелистывание названо честно', () => {
  const SRC = readFileSync(join(UI, 'components/StoriesRow.tsx'), 'utf8');

  it('левая полоса на первой сторис объявлена недоступной, а не молчит', () => {
    expect(SRC).toContain('accessibilityLabel="Предыдущая сторис"');
    expect(SRC).toContain('accessibilityState={{ disabled: index === 0 }}');
  });

  it('правая полоса на последней сторис не обещает следующую', () => {
    expect(SRC).toContain(
      "accessibilityLabel={index < stories.length - 1 ? 'Следующая сторис' : 'Закрыть просмотр'}",
    );
  });

  it('кнопка-эмодзи называет оба последствия нажатия', () => {
    expect(SRC).toContain('accessibilityLabel={`Ответить ${emoji} и листать дальше`}');
  });

  it('место в череде читается словами, а не полосками', () => {
    expect(SRC).toContain('accessibilityLabel={`Сторис ${index + 1} из ${stories.length}`}');
  });

  it('вопросительный знак у счётчика просмотров расшифрован', () => {
    expect(SRC).toContain('accessibilityLabel="Сколько человек посмотрело — неизвестно"');
    expect(SRC).toContain('accessibilityLabel={`Посмотрело: ${viewerCount(viewerList)}`}');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: границы правила', () => {
  it('нажимаемых с нарисованным внутри по-прежнему большинство, и их не трогали', () => {
    const filled = ALL.filter((p) => !p.empty);
    expect(filled.length).toBeGreaterThan(EMPTY.length * 20);
    // Роли у них нет сплошь и рядом, и это решение AppPressable, а не упущение.
    expect(filled.some((p) => !p.tag.includes('accessibilityRole'))).toBe(true);
  });

  it('AppPressable по-прежнему не выдаёт роль по умолчанию', () => {
    const src = readFileSync(join(UI, 'components/AppPressable.tsx'), 'utf8');
    expect(src).not.toMatch(/accessibilityRole\s*=\s*['"]button['"]/);
    expect(src).toContain('По умолчанию роли НЕТ, и это намеренно');
  });
});
