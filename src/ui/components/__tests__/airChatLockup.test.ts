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
  /** Кружки из файла: `<circle cx="…" cy="…" r="…"/>`. */
  const assetCircles = (): { cx: number; cy: number; r: number }[] =>
    [...ASSET().matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"/g)].map((m) => ({
      cx: Number(m[1]),
      cy: Number(m[2]),
      r: Number(m[3]),
    }));

  it('лучи повторяют файл иконки один в один', () => {
    const asset = ASSET();
    const inFile = [...asset.matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(inFile.length).toBeGreaterThan(0);
    const source = MARK();
    for (const d of inFile) expect(source).toContain(`'${d}'`);
    // И обратно: лишнего луча в компоненте тоже быть не должно.
    const inCode = [...source.matchAll(/'(M\d[^']*)'/g)].map((m) => m[1]);
    expect(inCode.sort()).toEqual(inFile.sort());
  });

  it('узлы и кольцо повторяют файл иконки', () => {
    const circles = assetCircles();
    const ring = circles.find((c) => c.r !== 38);
    const nodes = circles.filter((c) => c.r === 38);
    expect(ring).toBeDefined();
    expect(nodes).toHaveLength(3);
    const source = MARK();
    expect(constant(source, 'NODE_R')).toBe(38);
    expect(constant(source, 'RING_R')).toBe(ring!.r);
    expect(constant(source, 'STROKE')).toBe(Number(/stroke-width="(\d+)"/.exec(ASSET())![1]));
    expect(constant(source, 'RING_STROKE')).toBe(
      Number(/<circle cx="\d+" cy="\d+" r="\d+" stroke-width="(\d+)"/.exec(ASSET())![1]),
    );
    for (const n of nodes) expect(source).toContain(`{ cx: ${n.cx}, cy: ${n.cy} }`);
    expect(source).toContain(`<Circle cx={${ring!.cx}} cy={${ring!.cy}} r={RING_R}`);
  });

  it('рамка обрезана по чернилам, а не по полям иконки', () => {
    // В файле вокруг знака оставлены поля под маску iOS. В строке рядом с
    // подписью они читались бы отступом непонятно откуда, поэтому компонент
    // берёт рамку по габаритам узлов — и обязан считать её от них же.
    const nodes = assetCircles().filter((c) => c.r === 38);
    const minX = Math.min(...nodes.map((n) => n.cx)) - 38;
    const minY = Math.min(...nodes.map((n) => n.cy)) - 38;
    const maxX = Math.max(...nodes.map((n) => n.cx)) + 38;
    const maxY = Math.max(...nodes.map((n) => n.cy)) + 38;
    expect(maxX - minX).toBe(maxY - minY);
    const source = MARK();
    expect(source).toContain(`const BOX = { x: ${minX}, y: ${minY}, size: ${maxX - minX} } as const;`);
    expect(source).toContain('viewBox={`${BOX.x} ${BOX.y} ${BOX.size} ${BOX.size}`}');
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
