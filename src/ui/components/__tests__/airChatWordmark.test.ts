/**
 * Знак — контуры, а не текст, поэтому смотреть на него в тесте нечем: рендерера
 * в этом проекте нет (см. соседние тесты — все они читают исходник или считают).
 * Зато посчитать контуры можно, и это ловит ровно то, что ломается молча:
 * рассинхрон рамки со словом растянет или обрежет знак, и заметят это в сторе.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const MARK = (): string => read('ui', 'components', 'AirChatWordmark.tsx');

/** Число из объявления `const NAME = 1.23;`. */
function constant(source: string, name: string): number {
  const m = source.match(new RegExp(`const ${name} = (-?[\\d.]+);`));
  expect(m).not.toBeNull();
  return Number(m![1]);
}

/** Склеенные куски `WORDMARK_PATH` — в исходнике они разбиты по длине строки. */
function wordmarkPath(source: string): string {
  const body = source.match(/const WORDMARK_PATH = \[([\s\S]*?)\]\.join/);
  expect(body).not.toBeNull();
  const chunks = body![1].match(/'[^']*'/g) ?? [];
  expect(chunks.length).toBeGreaterThan(0);
  return chunks.map((c) => c.slice(1, -1)).join(' ');
}

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

/**
 * Чернильные границы контура. Для квадратичной кривой берётся её собственный
 * экстремум, а не опорная точка: опорная лежит снаружи кривой и раздула бы
 * рамку — тест бы прошёл на неверной геометрии.
 */
function pathBounds(d: string): Bounds {
  const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
  const xs: number[] = [];
  const ys: number[] = [];
  let cmd = '';
  let i = 0;
  let x = 0;
  let y = 0;
  const num = (): number => Number(tokens[i++]);
  const quadExtremum = (p0: number, c: number, p1: number): number[] => {
    const denom = p0 - 2 * c + p1;
    if (denom === 0) return [];
    const t = (p0 - c) / denom;
    if (t <= 0 || t >= 1) return [];
    return [(1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * c + t * t * p1];
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'Z') continue;
    }
    if (cmd === 'M' || cmd === 'L') {
      x = num();
      y = num();
    } else if (cmd === 'H') {
      x = num();
    } else if (cmd === 'V') {
      y = num();
    } else if (cmd === 'Q') {
      const cx = num();
      const cy = num();
      const nx = num();
      const ny = num();
      xs.push(...quadExtremum(x, cx, nx));
      ys.push(...quadExtremum(y, cy, ny));
      x = nx;
      y = ny;
    } else {
      throw new Error(`неизвестная команда контура: ${cmd}`);
    }
    xs.push(x);
    ys.push(y);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('знак AirChat', () => {
  it('слово занимает рамку целиком — без полей и без обрезки', () => {
    const source = MARK();
    const b = pathBounds(wordmarkPath(source));
    const aspect = constant(source, 'ASPECT');
    // Рамка объявлена как `0 0 ${100 * ASPECT} 100`: высота букв равна
    // заданной высоте, а не кеглю с запасом сверху и снизу.
    expect(source).toContain('viewBox={`0 0 ${100 * ASPECT} 100`}');
    expect(b.minX).toBeCloseTo(0, 2);
    expect(b.minY).toBeCloseTo(0, 2);
    expect(b.maxY).toBeCloseTo(100, 2);
    expect(b.maxX).toBeCloseTo(100 * aspect, 2);
  });

  it('ширина считается из той же пропорции, что и рамка', () => {
    // Разойдись эти два места — знак растянется по горизонтали.
    expect(MARK()).toContain('width={height * ASPECT}');
  });

  it('красится палитрой, а не вписанными цветами', () => {
    const source = MARK();
    expect(source).toContain('stopColor={from ?? colors.accent}');
    expect(source).toContain('stopColor={to ?? colors.primary}');
    // Литералы здесь не подчинялись бы ни теме, ни выбранному акценту
    // (см. ui/__tests__/paletteLiterals).
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('у каждого экземпляра свой градиент', () => {
    // Общий id заливки забрал бы градиент у того знака, что нарисован позже.
    expect(MARK()).toContain('`airchat-wordmark-${useId()}`');
  });

  it('называет себя для озвучки — букв как текста здесь нет', () => {
    const source = MARK();
    expect(source).toContain('accessibilityRole="image"');
    expect(source).toContain('accessibilityLabel="AirChat"');
  });

  it('стоит на приветствии и на замке вместо системного шрифта', () => {
    for (const screen of ['OnboardingScreen.tsx', 'PasswordScreen.tsx']) {
      const source = read('ui', 'screens', screen);
      expect(source).toContain('<AirChatWordmark ');
      expect(source).not.toContain('>AirChat</Text>');
    }
  });
});
