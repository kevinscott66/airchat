/**
 * Водяной знак в стекле шапки — это порядок рендера, а не стиль.
 *
 * `BlurView` размывает свою подложку, а подложка — это то, что нарисовано
 * РАНЬШЕ него в том же родителе. Слои разведены нарочно и в разные стороны:
 *
 *  - подкрас идёт РАНЬШЕ: размытие и есть источник его мягкости;
 *  - буквы идут ПОЗЖЕ. В v4.32.545 они лежали в подложке вместе с подкрасом, и
 *    на устройстве их не было видно вовсе: размытие силой 52 растирает
 *    восемнадцать точек высоты по всей капсуле. Переставь их обратно — и
 *    водяной знак снова исчезнет, причём молча и только на телефоне.
 *
 * Ни типов, ни линтера на такой порядок нет, поэтому его держит тест.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const GLASS = (): string => read('ui', 'components', 'GlassSurface.tsx');

describe('водяной знак в GlassSurface', () => {
  it('подкрас рисуется раньше BlurView — то есть попадает ему в подложку', () => {
    const source = GLASS();
    const wash = source.indexOf('<CapsuleWash');
    const blur = source.indexOf('<BlurView');
    expect(wash).toBeGreaterThan(-1);
    expect(blur).toBeGreaterThan(-1);
    expect(wash).toBeLessThan(blur);
  });

  it('буквы рисуются позже BlurView — иначе размытие стирает их насовсем', () => {
    const source = GLASS();
    const mark = source.indexOf('<AirChatWordmark');
    const blur = source.indexOf('<BlurView');
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(blur);
  });

  it('содержимое шапки остаётся поверх знака', () => {
    const source = GLASS();
    expect(source.indexOf('<AirChatWordmark')).toBeLessThan(source.indexOf('{children}'));
  });

  it('при выключенной прозрачности не рисуется вовсе: прятать не за что', () => {
    expect(GLASS()).toContain('watermark && !solid');
  });

  it('не перехватывает нажатия шапки', () => {
    // Оба слоя, а не один: знак переехал за BlurView, и забыть `pointerEvents`
    // на переехавшей половине — значит накрыть кнопки шапки прозрачным щитом.
    const source = GLASS();
    const parts = source.split('watermark && !solid').slice(1);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.slice(0, part.indexOf('</View>'))).toContain('pointerEvents="none"');
    }
  });

  it('подкрас берёт цвета из палитры, а не вписывает свои', () => {
    const source = GLASS();
    expect(source).toContain('<CapsuleWash primary={colors.primary} accent={colors.accent} />');
    const wash = source.slice(source.indexOf('function CapsuleWash'), source.indexOf('export function GlassSurface'));
    expect(wash).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('признак, а не всегда: знак стоит только на шапках', () => {
    const headers = [
      ['ui', 'screens', 'ChatListScreen.tsx'],
      ['ui', 'screens', 'FeedScreen.tsx'],
      ['ui', 'screens', 'GroupsScreen.tsx'],
      ['ui', 'screens', 'ChatScreen.tsx'],
    ];
    for (const p of headers) expect(read(...p)).toContain('watermark>');
    // В полосе статуса знака больше нет: там он был не водяным знаком,
    // а ещё одной надписью рядом с часами.
    expect(read('App.tsx')).not.toContain('AirChatWordmark');
  });
});
