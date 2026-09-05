/**
 * Колонка формы не растягивается на всю ширину окна.
 *
 * Экраны без аккаунта — знакомство, восстановление, показ 24 слов, сброс
 * пароля — верстались под телефон, где «во всю ширину» означает 350 точек.
 * В окне браузера на MacBook и на iPad в альбоме та же вёрстка давала кнопку
 * от края до края с подписью в середине и строку описания примерно на 160
 * знаков. Кнопку такой длины не с чем спутать, но и целиться в неё незачем:
 * нажимаемого там — слова посередине.
 *
 * Тест держит не красоту, а два измеримых утверждения: потолок ширины стоит на
 * длине строки, и он действительно применён на каждом из этих экранов.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { formColumn } from '../theme';

const SRC = join(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

describe('потолок ширины колонки', () => {
  it('стоит на длине строки, а не на ширине страницы', () => {
    // Нижняя граница: уже 360 колонка становится телефонной даже на десктопе.
    // Верхняя: при основном кегле 420 — это уже верх диапазона 60–75 знаков в
    // строке; после ~560 строку читать тяжело, и ограничение теряет смысл.
    expect(formColumn.maxWidth).toBeGreaterThanOrEqual(360);
    expect(formColumn.maxWidth).toBeLessThanOrEqual(560);
  });
});

describe.each([
  ['знакомство и восстановление', 'ui/screens/OnboardingScreen.tsx'],
  ['сброс пароля', 'ui/screens/ForgotPasswordScreen.tsx'],
])('%s', (_name, rel) => {
  it('берёт потолок из токена, а не вписывает число', () => {
    const src = read(rel);
    expect(src).toContain("formColumn");
    expect(src).toContain('maxWidth: formColumn.maxWidth');
    // Своё число рядом означало бы, что два экрана разъедутся по ширине.
    expect(src).not.toMatch(/maxWidth:\s*\d/);
  });

  it('ограничивает ширину, а не задаёт её', () => {
    // `width: '100%'` вместе с `maxWidth` — это «во всю ширину, но не шире».
    // Без первого колонка на телефоне схлопнулась бы по содержимому, без
    // второго ограничение не сработало бы вовсе.
    const src = read(rel);
    const blocks = src.split('maxWidth: formColumn.maxWidth');
    expect(blocks.length).toBeGreaterThan(1);
    for (const before of blocks.slice(0, -1)) {
      expect(before.slice(-160)).toContain("width: '100%'");
    }
  });
});

describe('экран знакомства', () => {
  const src = read('ui/screens/OnboardingScreen.tsx');

  it('держит обе кнопки внутри колонки', () => {
    // v4.32.591: колонка стала стеклянной карточкой, но утверждение то же —
    // обе кнопки внутри неё, а не во всю ширину окна.
    const at = src.indexOf('style={styles.card}');
    expect(at).toBeGreaterThan(0);
    const end = src.indexOf('testID="onboarding_restore"');
    const column = src.slice(at, end > at ? end : src.length);
    expect(column).toContain('testID="btn_create_new"');
    expect(column).toContain('testID="btn_restore"');
  });

  it('оставляет затемнение на весь экран', () => {
    // LoadingOverlay накрывает экран, а не форму: сузить его до колонки значило
    // бы оставить по бокам живые нажатия во время генерации ключей.
    const overlay = src.indexOf('message="Генерация ключей…"');
    const column = src.indexOf('style={styles.card}');
    expect(overlay).toBeGreaterThan(0);
    expect(column).toBeGreaterThan(overlay);
  });
});
