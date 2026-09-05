/**
 * Форма без аккаунта лежит на подсветке и ровно на одном стекле (v4.32.591).
 *
 * Числа этого слоя проверяет themeContrast.test.ts — там считается, что видно
 * глазом. Здесь проверяется устройство: подсветка действительно подложена под
 * каждый из четырёх экранов, стеклянная панель на экране одна, и её собственная
 * документация («стекло — только навигации и важным панелям: много независимых
 * blur-контейнеров дорого и хуже читается») не нарушена вложенностью.
 *
 * Проверка по исходнику, а не по рендеру: `expo-blur` и `react-native-svg` в
 * тестовой среде подменены, и дерево ничего не скажет ни о числе размытий, ни
 * о том, что фон лежит ПОД формой, а не над ней.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const SCREENS: Array<[string, string]> = [
  ['знакомство, восстановление и 24 слова', 'ui/screens/OnboardingScreen.tsx'],
  ['сброс пароля', 'ui/screens/ForgotPasswordScreen.tsx'],
];

describe.each(SCREENS)('%s', (_name, rel) => {
  const src = read(rel);

  it('подсветка подложена под каждый экран', () => {
    expect(src).toContain("import { AuthBackdrop } from '../components/AuthBackdrop';");
    const screens = src.split('<SafeScreen');
    // Первый кусок — всё до первого <SafeScreen>, экранов среди него нет.
    expect(screens.length).toBeGreaterThan(1);
    for (const screen of screens.slice(1)) {
      expect(screen).toContain('<AuthBackdrop />');
    }
  });

  it('фон идёт первым ребёнком, а не поверх формы', () => {
    // Порядок здесь и есть слой: RN рисует детей подряд, и подсветка,
    // поставленная после формы, накрыла бы её целиком.
    for (const screen of src.split('<SafeScreen').slice(1)) {
      const backdrop = screen.indexOf('<AuthBackdrop />');
      const glass = screen.indexOf('<GlassSurface');
      if (glass >= 0) expect(backdrop).toBeLessThan(glass);
    }
  });

  it('стекло на экране одно и не вложено в стекло', () => {
    let depth = 0;
    for (const token of src.match(/<\/?GlassSurface/g) ?? []) {
      depth += token.startsWith('</') ? -1 : 1;
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
  });

  it('карточка берёт выраженность стекла, рассчитанную на произвольный фон', () => {
    // `prominent` — не вкус: `clear` и `regular` названы для однородной
    // подложки и навигации, а под этой карточкой лежит цветная подсветка.
    for (const opening of src.match(/<GlassSurface[^>]*>/g) ?? []) {
      expect(opening).toContain('variant="prominent"');
    }
  });

  it('фон и контур на карточке не берутся из палитры напрямую', () => {
    // Заливка `background` под стеклом закрыла бы подсветку, а `border` на
    // карточке даёт около 1.2:1 — см. themeContrast.test.ts.
    expect(src).not.toContain('backgroundColor: c.background');
    expect(src).not.toContain('borderColor: c.border');
  });
});

describe('слой подсветки', () => {
  const src = read('ui/components/AuthBackdrop.tsx');

  it('стоит при выключенном движении', () => {
    expect(src).toContain('isReducedMotion()');
  });

  it('не вписывает свои числа', () => {
    // Геометрия и непрозрачности живут в `authWash` вместе с замерами, из
    // которых взяты; литерал здесь означал бы, что тест контраста стережёт
    // не то, что нарисовано.
    expect(src).toContain('authWash');
    // Кроме нуля на дальней остановке: он не замер, а конец градиента.
    expect(src).not.toMatch(/stopOpacity=\{(?!0\})[\d.]/);
    expect(src).not.toMatch(/c[xy]=\{`\$\{[\d.]/);
  });

  it('клипует себя, потому что дрейф выводит пятна за края', () => {
    expect(src).toContain("overflow: 'hidden'");
  });

  it('не трогает нажатия', () => {
    expect(src).toContain('pointerEvents="none"');
  });
});
