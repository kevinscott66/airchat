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
 *  - штамп лежит под «островом», по центру полосы статуса. «Остров» — маска
 *    системы поверх окна, в снимок экрана она не попадает: на устройстве штампа
 *    не видно, на скриншоте он есть. Отсюда два условия — центр (это и есть
 *    центр «острова», полоса симметрична) и размер меньше самой маски. Больше
 *    маски — и из-под неё выглядывает край рамки, то есть штамп снова
 *    становится надписью рядом с часами.
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
const STAMP = (): string => read('ui', 'components', 'IslandStamp.tsx');
/** Число из объявления вида `const NAME = 12;` в исходнике штампа. */
const num = (name: string): number =>
  Number(new RegExp(`const ${name} = ([\\d.]+);`).exec(STAMP())?.[1]);

/** Габариты «острова» в точках (iPhone 14 Pro и новее). Знак обязан войти внутрь. */
const ISLAND_W = 125;
const ISLAND_H = 37;
/** Ширина подписи = высота × ASPECT; берётся из неё самой, а не переписывается. */
const ASPECT = Number(/const ASPECT = ([\d.]+);/.exec(read('ui', 'components', 'AirChatSignature.tsx'))?.[1]);

describe('подкрас стекла в GlassSurface', () => {
  it('рисуется раньше BlurView — то есть попадает ему в подложку', () => {
    const source = GLASS();
    const wash = source.indexOf('<CapsuleWash');
    const blur = source.indexOf('<BlurView');
    expect(wash).toBeGreaterThan(-1);
    expect(blur).toBeGreaterThan(-1);
    expect(wash).toBeLessThan(blur);
  });

  it('названия в стекле нет: под размытием его не видно, над ним оно спорит с шапкой', () => {
    const source = GLASS();
    for (const name of ['AirChatLockup', 'AirChatSignature', 'AirChatMark']) {
      expect(source).not.toContain(name);
    }
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

describe('штамп под «островом»', () => {
  it('стоит в оболочке, а не на экране: полоса одна на все вкладки', () => {
    expect(APP()).toContain('<IslandStamp />');
  });

  it('по центру полосы статуса — то есть по центру самого «острова»', () => {
    const source = APP();
    const style = source.slice(source.indexOf('islandMark: {'));
    expect(style.slice(0, style.indexOf('},'))).toContain("justifyContent: 'center'");
    expect(source).toContain('style={[styles.islandMark, { height: insets.top }]}');
  });

  it('капсула целиком помещается под маску: иначе видно её край', () => {
    expect(num('CAPSULE_W')).toBeLessThan(ISLAND_W);
    expect(num('CAPSULE_H')).toBeLessThan(ISLAND_H);
    // Запас, а не впритык: на разных аппаратах маска отличается на пару точек.
    expect(ISLAND_W - num('CAPSULE_W')).toBeGreaterThanOrEqual(6);
    expect(ISLAND_H - num('CAPSULE_H')).toBeGreaterThanOrEqual(4);
  });

  it('овал и ничего кроме: ни плашки под буквами, ни хвоста наружу', () => {
    const source = STAMP();
    expect(source).toContain('fill="none"');
    // Свешенный хвост торчал бы из-под маски — то есть был бы виден в работе.
    expect(source).not.toContain('tail');
    // Контур считается из тех же чисел, что и габарит: вписанный руками путь
    // разъезжается с рамкой на полтолщины обводки, и на снимке это видно.
    expect(source).not.toMatch(/d="M/);
  });

  it('перелив из цветов темы, и одинаковый у кольца и у букв', () => {
    const source = STAMP();
    expect(source).toContain('i % 2 === 0 ? colors.accent : colors.primary');
    // Больше одного прохода пары — иначе это обычный градиент, гаснущий к краю.
    expect(num('SHEEN_CYCLES')).toBeGreaterThan(1);
    // Тот же набор идёт в подпись: кольцо и росчерк обязаны играть заодно.
    expect(source).toContain('stops={sheen}');
    // Свой id на экземпляр — общий отобрал бы заливку у отрисованного позже.
    expect(source).toContain('useId()');
  });

  it('подпись помещается внутрь овала и не заходит в скругления', () => {
    expect(ASPECT).toBeGreaterThan(0);
    const markW = num('SIGNATURE') * ASPECT;
    expect(num('SIGNATURE')).toBeLessThan(num('CAPSULE_H'));
    // Скругления съедают по CAPSULE_H / 2 с каждой стороны — прямой участок это
    // всё, что остаётся; в него знак и должен войти.
    expect(markW).toBeLessThan(num('CAPSULE_W') - num('CAPSULE_H'));
  });

  it('не ловит касаний: полоса статуса принадлежит системе', () => {
    const source = APP();
    expect(source.slice(0, source.indexOf('styles.islandMark'))).toMatch(/pointerEvents="none"[^<]*$/);
    // И сам штамп тоже: он лежит поверх содержимого вкладки.
    expect(STAMP()).toContain('pointerEvents="none"');
  });

  it('только там, где есть «остров»: прятать штамп больше не за что', () => {
    const m = /insets\.top >= (\d+) \?/.exec(APP());
    expect(m).not.toBeNull();
    // Полоса с вырезом — 47 точек (iPhone 12–14), с «островом» — 59 и выше.
    expect(Number(m?.[1])).toBeGreaterThan(47);
    expect(Number(m?.[1])).toBeLessThanOrEqual(59);
  });

  it('цвета из палитры, а не свои: штамп ложится на любую тему', () => {
    expect(STAMP()).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
