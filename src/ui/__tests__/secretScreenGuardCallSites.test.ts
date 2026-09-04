/**
 * v4.32.581: двадцать четыре слова восстанавливают аккаунт целиком, вместе со
 * всей перепиской. Нативный щит от снимка и записи экрана в проекте есть с
 * v4.32.570, но подключён был только к переписке — то есть к содержимому,
 * которое человек и так согласился показать собеседнику. Сами слова, самый
 * дорогой кадр в приложении, оставались открытыми: на Android их снимало любое
 * приложение с разрешением на запись экрана, на iOS — обычный снимок.
 *
 * Проверяем исходник, а не поведение: экраны заведения и восстановления
 * аккаунта в тесте не поднять (навигация, хранилище, криптография), зато
 * пропажу обёртки видно сразу и стоит она одну строку. Так же устроены
 * copyGuardCallSites и paletteLiterals.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const screens = join(__dirname, '..', 'screens');
const onboarding = readFileSync(join(screens, 'OnboardingScreen.tsx'), 'utf8');
const forgot = readFileSync(join(screens, 'ForgotPasswordScreen.tsx'), 'utf8');
const guard = readFileSync(join(__dirname, '..', 'components', 'SecretScreenGuard.tsx'), 'utf8');

/** Отрезок исходника вокруг testID — там и должна стоять обёртка. */
function around(src: string, testId: string, before: number, after: number): string {
  const i = src.indexOf(`testID="${testId}"`);
  expect(i).toBeGreaterThan(0);
  return src.slice(Math.max(0, i - before), i + after);
}

describe('секретные слова закрыты щитом от снимка экрана', () => {
  it('показ 24 слов при заведении аккаунта — под щитом', () => {
    expect(onboarding).toContain("import { SecretScreenGuard } from '../components/SecretScreenGuard';");
    expect(onboarding).toContain('<SecretScreenGuard style={styles.grid} testID="seed_words">');
    expect(onboarding).toContain('</SecretScreenGuard>');
  });

  it('поле ввода слов при восстановлении — под щитом', () => {
    expect(around(onboarding, 'seed_input', 1200, 200)).toContain('<SecretScreenGuard>');
  });

  it('поле ввода слов при забытом пароле — под щитом', () => {
    expect(forgot).toContain("import { SecretScreenGuard } from '../components/SecretScreenGuard';");
    expect(around(forgot, 'forgot_seed_input', 900, 200)).toContain('<SecretScreenGuard>');
  });

  it('оба поля ввода слов закрыты от автозаполнения и словаря клавиатуры', () => {
    // Без этих запретов фраза уходит в подсказки клавиатуры и в менеджер
    // паролей — то есть за пределы приложения, куда щит уже не достаёт.
    for (const [src, id] of [
      [onboarding, 'seed_input'],
      [forgot, 'forgot_seed_input'],
    ] as const) {
      const block = around(src, id, 1200, 200);
      expect(block).toContain('autoComplete="off"');
      expect(block).toContain('textContentType="none"');
      expect(block).toContain('autoCorrect={false}');
    }
  });

  it('щит считает участки, а не гасит окно за всех сразу', () => {
    // Флаг окна на Android один на приложение и его ставит не только этот
    // компонент. Снятие по уходу одного участка погасило бы щит у остальных.
    expect(guard).toContain('secureWindowRefs += 1');
    expect(guard).toContain('if (secureWindowRefs === 1) void setWindowSecure(true);');
    expect(guard).toContain('if (secureWindowRefs === 0) void setWindowSecure(false);');
  });
});
