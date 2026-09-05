/**
 * Название приложения: марка плюс рукописная подпись.
 *
 * v4.32.592. Знак — контуры, а не текст, поэтому смотреть на него в тесте
 * нечем: рендерера в этом проекте нет (см. соседние тесты — все они читают
 * исходник или считают). Зато посчитать контуры можно, и это ловит ровно то,
 * что ломается молча.
 *
 * Три разных утверждения:
 *   1) подпись занимает свою рамку целиком — рассинхрон рамки со словом
 *      растянет или обрежет росчерк, и заметят это в сторе;
 *   2) марка совпадает с `assets/logo/airchat-mark.svg` числом в число. Файл —
 *      источник иконки приложения и favicon, компонент — тот же знак в
 *      интерфейсе; разойдись они, и в приложении окажется не та марка, что на
 *      домашнем экране, а увидеть это можно только глазами на двух экранах
 *      сразу;
 *   3) оба контура позиционированы (`position: relative`). Это не оформление:
 *      в браузере `react-native-svg` отдаёт статичный `<svg>`, и внутри
 *      `GlassSurface` абсолютные слои стекла красятся ПОВЕРХ него по правилам
 *      CSS — знак уходил размытию в подложку. Ровно так это и было найдено на
 *      сайте в 591-й.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const MARK = (): string => read('ui', 'components', 'AirChatMark.tsx');
const SIGN = (): string => read('ui', 'components', 'AirChatSignature.tsx');
const LOCKUP = (): string => read('ui', 'components', 'AirChatLockup.tsx');
const ASSET = (): string => fs.readFileSync(path.join(ROOT, 'assets', 'logo', 'airchat-mark.svg'), 'utf8');

/** Число из объявления `const NAME = 1.23;`. */
function constant(source: string, name: string): number {
  const m = source.match(new RegExp(`const ${name} = (-?[\\d.]+);`));
  expect(m).not.toBeNull();
  return Number(m![1]);
}

/** Склеенные куски `SIGNATURE_PATH` — в исходнике они разбиты по длине строки. */
function signaturePath(source: string): string {
  const body = source.match(/const SIGNATURE_PATH = \[([\s\S]*?)\]\.join/);
  expect(body).not.toBeNull();
  const chunks = body![1].match(/'[^']*'/g) ?? [];
  expect(chunks.length).toBeGreaterThan(0);
  return chunks.map((c) => c.slice(1, -1)).join(' ');
}

/** Склеенные куски `BUBBLE` — в исходнике они разбиты по длине строки. */
function BUBBLE_PATH(source: string): string {
  const body = source.match(/const BUBBLE = \[([\s\S]*?)\]\.join/);
  expect(body).not.toBeNull();
  const chunks = body![1].match(/'[^']*'/g) ?? [];
  expect(chunks.length).toBeGreaterThan(0);
  return chunks.map((c) => c.slice(1, -1)).join('');
}

/** Хвост — одной строкой: он короткий и переносить его незачем. */
function TAIL_PATH(source: string): string {
  const m = source.match(/const TAIL = '([^']+)';/);
  expect(m).not.toBeNull();
  return m![1];
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

describe('подпись AirChat', () => {
  it('росчерк занимает рамку целиком — без полей и без обрезки', () => {
    const source = SIGN();
    const b = pathBounds(signaturePath(source));
    const aspect = constant(source, 'ASPECT');
    // Рамка объявлена как `0 0 ${100 * ASPECT} 100`: высота росчерка равна
    // заданной высоте, а не кеглю с запасом сверху и снизу.
    expect(source).toContain('viewBox={`0 0 ${100 * ASPECT} 100`}');
    expect(b.minX).toBeCloseTo(0, 2);
    expect(b.minY).toBeCloseTo(0, 2);
    expect(b.maxY).toBeCloseTo(100, 2);
    expect(b.maxX).toBeCloseTo(100 * aspect, 2);
  });

  it('ширина считается из той же пропорции, что и рамка', () => {
    // Разойдись эти два места — росчерк растянется по горизонтали.
    expect(SIGN()).toContain('width={height * ASPECT}');
  });

  it('называет себя для озвучки — букв как текста здесь нет', () => {
    const source = SIGN();
    expect(source).toContain('accessibilityRole="image"');
    expect(source).toContain('accessibilityLabel="AirChat"');
  });
});

describe('марка AirChat', () => {
  /** Строки `d` из файла — их же обязан содержать компонент. */
  const assetPaths = (): string[] => [...ASSET().matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]);

  it('повторяет файл иконки один в один', () => {
    // Из этого файла растеризуется иконка приложения и favicon. Разойдись он
    // с компонентом — в интерфейсе окажется не тот знак, что на домашнем
    // экране, и заметить это можно только глазами на двух экранах сразу.
    const inFile = assetPaths();
    expect(inFile).toHaveLength(2);
    const source = MARK();
    const inCode = [BUBBLE_PATH(source), TAIL_PATH(source)];
    expect(inCode.sort()).toEqual([...inFile].sort());
  });

  it('дырка реплики — второй обход того же контура, а не отдельная фигура', () => {
    // Второй <Path> закрасил бы первый, а не вырезал: правило nonzero делает
    // дырку только внутри одного `d`.
    const bubble = BUBBLE_PATH(MARK());
    expect(bubble.match(/M/g)).toHaveLength(2);
    expect(bubble.match(/Z/g)).toHaveLength(2);
  });

  it('буквы в знаке нет: рядом с подписью она бы удвоилась', () => {
    // Подпись сама начинается с росчерковой «A»; знак-буква читался бы как
    // «A AirChat» — опиской, а не знаком.
    const source = MARK();
    expect(source).not.toContain('<Circle');
    expect(source).toContain('Почему не буква');
  });

  it('рамка обрезана по чернилам, а не по полям файла', () => {
    // В файле вокруг знака оставлены поля под маску iOS. В строке рядом с
    // подписью они читались бы отступом ниоткуда, поэтому рамка компонента
    // равна габаритам самих контуров — и обязана пересчитываться из них.
    const bs = assetPaths().map(pathBounds);
    const minX = Math.min(...bs.map((b) => b.minX));
    const minY = Math.min(...bs.map((b) => b.minY));
    const w = Math.max(...bs.map((b) => b.maxX)) - minX;
    const h = Math.max(...bs.map((b) => b.maxY)) - minY;
    const source = MARK();
    const box = /const BOX = \{ x: ([\d.]+), y: ([\d.]+), w: ([\d.]+), h: ([\d.]+) \}/.exec(source);
    expect(box).not.toBeNull();
    expect(Number(box![1])).toBeCloseTo(minX, 1);
    expect(Number(box![2])).toBeCloseTo(minY, 1);
    expect(Number(box![3])).toBeCloseTo(w, 1);
    expect(Number(box![4])).toBeCloseTo(h, 1);
    expect(source).toContain('viewBox={`${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`}');
  });

  it('знак не квадратный, и ширина берётся из пропорции', () => {
    // Округли ширину до высоты — и реплику расплющит по горизонтали.
    const source = MARK();
    expect(source).toContain('const MARK_ASPECT = BOX.w / BOX.h;');
    expect(source).toContain('width={size * MARK_ASPECT}');
    expect(source).toContain('height={size}');
  });
});

describe('знак и подпись вместе', () => {
  it('красятся палитрой, а не вписанными цветами', () => {
    for (const source of [MARK(), SIGN()]) {
      expect(source).toContain('from ?? colors.accent');
      expect(source).toContain('to ?? colors.primary');
      // Литералы здесь не подчинялись бы ни теме, ни выбранному акценту
      // (см. ui/__tests__/paletteLiterals).
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  it('у каждого экземпляра свой градиент', () => {
    // Общий id заливки забрал бы градиент у того знака, что нарисован позже.
    expect(MARK()).toContain('`airchat-mark-${useId()}`');
    expect(SIGN()).toContain('`airchat-signature-${useId()}`');
  });

  it('оба контура позиционированы — иначе стекло забирает их в подложку', () => {
    // Найдено на сайте в 591-й: `BlurView` внутри GlassSurface лежит абсолютом,
    // а `<svg>` в потоке статичен, и по правилам отрисовки CSS размытие
    // красится поверх него. На устройстве этого нет — там порядок задаёт дерево.
    for (const source of [MARK(), SIGN()]) expect(source).toContain("position: 'relative'");
  });

  it('в связке марка идёт перед подписью', () => {
    const source = LOCKUP();
    const mark = source.indexOf('<AirChatMark');
    const sign = source.indexOf('<AirChatSignature');
    expect(mark).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(mark);
  });

  it('стоит на приветствии и на замке вместо системного шрифта', () => {
    for (const screen of ['OnboardingScreen.tsx', 'PasswordScreen.tsx']) {
      const source = read('ui', 'screens', screen);
      expect(source).toContain('<AirChatLockup ');
      expect(source).not.toContain('>AirChat</Text>');
    }
  });
});
