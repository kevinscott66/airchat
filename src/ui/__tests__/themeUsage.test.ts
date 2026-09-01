/**
 * Кто в интерфейсе берёт цвета мимо темы (v4.32.365).
 *
 * `colors` из theme.ts — это `darkColors`, экспортированный под общим именем
 * ради обратной совместимости. Импорт выглядит совершенно безобидно, а значит
 * «цвет из палитры», но на деле прибивает компонент к тёмной теме навсегда:
 * ни выбор светлой темы, ни выбранный пользователем цвет акцента до него не
 * доходят. Заметить это по коду нельзя — только увидев экран в светлой теме.
 *
 * Так и было: лента сторис и шторка GIF оставались тёмными кусками светлого
 * приложения, а подпись под кружком сторис давала 2.4:1 на светлом фоне при
 * пороге 3:1 — притом что themeContrast.test.ts «проверял палитру» и всё
 * сходилось. Тест проверял значения; ими просто не пользовались.
 *
 * Отсюда проверка не значений, а мест использования: список исключений
 * закрытый, и каждое в нём — с объяснением, почему теме там взяться неоткуда.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const UI_ROOT = join(__dirname, '..');

/**
 * Экраны, которые рисуются ДО того, как выбранная тема прочитана из
 * хранилища. Подписка на тему дала бы мигание «тёмное → светлое» на первом
 * кадре, поэтому тёмная палитра берётся напрямую и осознанно.
 */
const ALLOWED = new Set(['screens/LoadingScreen.tsx']);

/** Все .ts/.tsx под src/ui, кроме тестов, путями относительно src/ui. */
function uiSources(dir = UI_ROOT, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...uiSources(full, `${prefix}${name}/`));
      continue;
    }
    if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(`${prefix}${name}`);
  }
  return out;
}

/** Тянет ли файл из theme именно `colors` (не `darkColors`, не токены). */
function importsStaticColors(source: string): boolean {
  // Импорт из theme может быть многострочным и с любым числом соседей.
  const imports = source.match(/import\s*\{[^}]*\}\s*from\s*'[^']*theme'/g) ?? [];
  return imports.some((stmt) => {
    const names = (stmt.match(/\{([^}]*)\}/) ?? ['', ''])[1];
    return names.split(',').some((n) => n.trim().split(/\s+as\s+/)[0].trim() === 'colors');
  });
}

describe('использование палитры в интерфейсе', () => {
  const files = uiSources();

  it('src/ui вообще просматривается', () => {
    // Страховка от того, что обход тихо вернёт пустоту и тест «пройдёт».
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('theme.ts');
  });

  it('статическая тёмная палитра — только в объявленных исключениях', () => {
    const offenders = files
      .filter((f) => f !== 'theme.ts' && !ALLOWED.has(f))
      .filter((f) => importsStaticColors(readFileSync(join(UI_ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('каждое исключение существует и объясняет себя', () => {
    for (const f of ALLOWED) {
      const source = readFileSync(join(UI_ROOT, f), 'utf8');
      expect(importsStaticColors(source)).toBe(true);
      // Исключение без причины через полгода неотличимо от недосмотра.
      expect(source).toContain('без темы');
    }
  });
});

describe('importsStaticColors', () => {
  it('различает colors и darkColors', () => {
    expect(importsStaticColors("import { colors } from '../theme';")).toBe(true);
    expect(importsStaticColors("import { darkColors } from '../theme';")).toBe(false);
    expect(importsStaticColors("import { lightColors, darkColors } from '../theme';")).toBe(false);
  });

  it('видит colors среди соседей и в многострочном импорте', () => {
    expect(importsStaticColors("import { font, colors, radius } from '../../theme';")).toBe(true);
    expect(importsStaticColors('import {\n  spacing,\n  colors,\n} from "../theme";'.replace(/"/g, "'"))).toBe(true);
  });

  it('импорт из другого модуля не считается', () => {
    expect(importsStaticColors("import { colors } from './somewhereElse';")).toBe(false);
  });

  it('переименование при импорте всё равно ловится', () => {
    expect(importsStaticColors("import { colors as palette } from '../theme';")).toBe(true);
  });
});
