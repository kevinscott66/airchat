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

describe('название на экранах без аккаунта', () => {
  it('это связка знака с подписью, а не системный шрифт', () => {
    // Системный шрифт в этом месте читается как заголовок раздела, а не как
    // имя приложения: на первом экране узнать приложение больше не по чему.
    for (const rel of ['ui/screens/OnboardingScreen.tsx', 'ui/screens/PasswordScreen.tsx']) {
      const src = read(rel);
      expect(src).toContain('<AirChatLockup ');
      expect(src).not.toContain('AirChatWordmark');
    }
  });

  it('лежит внутри карточки, а не поверх стекла отдельным слоем', () => {
    const src = read('ui/screens/OnboardingScreen.tsx');
    const card = src.indexOf('<GlassSurface');
    const lockup = src.indexOf('<AirChatLockup');
    expect(card).toBeGreaterThan(-1);
    expect(lockup).toBeGreaterThan(card);
  });
});

describe('переключатель темы', () => {
  const src = read('ui/components/ThemeSwitchButton.tsx');

  it('стоит на приветствии — оттуда до настроек ещё нет дороги', () => {
    const screen = read('ui/screens/OnboardingScreen.tsx');
    expect(screen).toContain('<ThemeSwitchButton />');
    // Ровно один: восстановление и показ 24 слов начинаются карточкой у
    // верхней кромки, и кнопка 44×44 справа вверху легла бы на неё.
    expect(screen.split('<ThemeSwitchButton />')).toHaveLength(2);
  });

  it('решает по тому, что нарисовано, а не по тому, что записано', () => {
    // При «как в системе» и при авторежиме ночи `mode` и `scheme` расходятся,
    // а человек смотрит на второе: значок обязан обещать видимый результат.
    expect(src).toContain("scheme === 'light'");
    expect(src).not.toMatch(/\bmode ===/);
  });

  it('ставит тему явно, без третьего состояния', () => {
    // «Как в системе» одним значком не выражается: солнце при нём обещало бы
    // светлую тему, а дало бы системную.
    expect(src).toContain("setMode(toDark ? 'dark' : 'light')");
    expect(src).not.toContain("'system'");
  });

  it('цель касания не меньше нормы и не вписана числом', () => {
    expect(src).toContain('width: TOUCH_TARGET_MIN');
    expect(src).toContain('height: TOUCH_TARGET_MIN');
    expect(src).toContain('borderRadius: radius.full');
  });

  it('называет себя для озвучки: значок один и подписи рядом нет', () => {
    expect(src).toContain('accessibilityRole="button"');
    expect(src).toContain('accessibilityLabel={');
  });

  it('не заводит второе стекло на экране, где оно уже есть', () => {
    expect(src).not.toContain('<GlassSurface');
    expect(src).not.toContain('BlurView');
    // Кромка — та же, что у полей и вторичной кнопки внутри карточки: токен
    // `border` на этих фонах даёт около 1.2:1 при пороге графики 3:1.
    expect(src).toContain('authCardRim(colors)');
    expect(src).not.toContain('colors.border');
  });

  it('не перехватывает нажатия мимо себя', () => {
    expect(src).toContain('pointerEvents="box-none"');
  });
});
