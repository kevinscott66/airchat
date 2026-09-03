/**
 * Водяной знак «AirChat»: где он лежит и почему его не видно.
 *
 * За шесть версий знак переехал четырежды, и каждый переезд стоил сборки на
 * устройстве. Тест держит итог, чтобы пятого не было:
 *
 *  - в стекле шапки знака НЕТ. Под размытием его не видно (545-я), а поверх
 *    размытия он спорит с заголовком экрана (573-я). В шапке остался только
 *    подкрас — он и задумывался фоном;
 *  - подкрас идёт РАНЬШЕ `BlurView`: подложка размытия — это то, что нарисовано
 *    раньше него в том же родителе, и мягкость у пятна оттуда, а не из чисел;
 *  - знак лежит под «островом», по центру полосы статуса. «Остров» — маска
 *    системы поверх окна, в снимок экрана она не попадает: на устройстве знака
 *    не видно, на скриншоте он есть. Отсюда два условия — центр (это и есть
 *    центр «острова», полоса симметрична) и размер меньше самой маски. Больше
 *    маски — и из-под неё выглядывают буквы, то есть знак снова становится
 *    надписью рядом с часами.
 *
 * Ни типов, ни линтера на это нет: всё держится на порядке детей и на трёх
 * числах. Отсюда тест по исходнику.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const GLASS = (): string => read('ui', 'components', 'GlassSurface.tsx');
const APP = (): string => read('App.tsx');

/** Габариты «острова» в точках (iPhone 14 Pro и новее). Знак обязан войти внутрь. */
const ISLAND_W = 125;
const ISLAND_H = 37;
/** Ширина знака = высота × ASPECT; берётся из самого знака, а не переписывается. */
const ASPECT = Number(/const ASPECT = ([\d.]+);/.exec(read('ui', 'components', 'AirChatWordmark.tsx'))?.[1]);

describe('подкрас стекла в GlassSurface', () => {
  it('рисуется раньше BlurView — то есть попадает ему в подложку', () => {
    const source = GLASS();
    const wash = source.indexOf('<CapsuleWash');
    const blur = source.indexOf('<BlurView');
    expect(wash).toBeGreaterThan(-1);
    expect(blur).toBeGreaterThan(-1);
    expect(wash).toBeLessThan(blur);
  });

  it('букв в стекле нет: под размытием их не видно, над ним они спорят с шапкой', () => {
    expect(GLASS()).not.toContain('AirChatWordmark');
  });

  it('при выключенной прозрачности не рисуется вовсе: прятать не за что', () => {
    expect(GLASS()).toContain('wash && !solid');
  });

  it('не перехватывает нажатия шапки', () => {
    const source = GLASS();
    const parts = source.split('wash && !solid').slice(1);
    expect(parts).toHaveLength(1);
    expect(parts[0].slice(0, parts[0].indexOf('</View>'))).toContain('pointerEvents="none"');
  });

  it('берёт цвета из палитры, а не вписывает свои', () => {
    const source = GLASS();
    expect(source).toContain('<CapsuleWash primary={colors.primary} accent={colors.accent} />');
    const wash = source.slice(source.indexOf('function CapsuleWash'), source.indexOf('export function GlassSurface'));
    expect(wash).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('признак, а не всегда: подкрас стоит только на шапках', () => {
    const headers = [
      ['ui', 'screens', 'ChatListScreen.tsx'],
      ['ui', 'screens', 'FeedScreen.tsx'],
      ['ui', 'screens', 'GroupsScreen.tsx'],
      ['ui', 'screens', 'ChatScreen.tsx'],
    ];
    for (const p of headers) expect(read(...p)).toContain('wash>');
  });
});

describe('знак под «островом»', () => {
  it('стоит в оболочке, а не на экране: полоса одна на все вкладки', () => {
    expect(APP()).toContain('<AirChatWordmark');
  });

  it('по центру полосы статуса — то есть по центру самого «острова»', () => {
    const source = APP();
    const style = source.slice(source.indexOf('islandMark: {'));
    expect(style.slice(0, style.indexOf('},'))).toContain("justifyContent: 'center'");
    expect(source).toContain('style={[styles.islandMark, { height: insets.top }]}');
  });

  it('целиком помещается под маску: иначе из-под неё выглядывают буквы', () => {
    const m = /<AirChatWordmark height=\{(\d+)\}/.exec(APP());
    expect(m).not.toBeNull();
    const height = Number(m?.[1]);
    expect(ASPECT).toBeGreaterThan(0);
    expect(height).toBeLessThan(ISLAND_H);
    expect(height * ASPECT).toBeLessThan(ISLAND_W);
  });

  it('не ловит касаний: полоса статуса принадлежит системе', () => {
    const source = APP();
    const block = source.slice(source.indexOf('styles.islandMark'));
    expect(source.slice(0, source.indexOf('styles.islandMark'))).toMatch(/pointerEvents="none"[^<]*$/);
    expect(block.indexOf('<AirChatWordmark')).toBeGreaterThan(-1);
  });

  it('только там, где есть «остров»: прятать знак больше не за что', () => {
    const m = /insets\.top >= (\d+) \?/.exec(APP());
    expect(m).not.toBeNull();
    // Полоса с вырезом — 47 точек (iPhone 12–14), с «островом» — 59 и выше.
    expect(Number(m?.[1])).toBeGreaterThan(47);
    expect(Number(m?.[1])).toBeLessThanOrEqual(59);
  });
});
