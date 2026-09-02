/**
 * Водяной знак под стеклом шапки — это порядок рендера, а не стиль.
 *
 * `BlurView` размывает свою подложку, а подложка — это то, что нарисовано
 * РАНЬШЕ него в том же родителе. Переставь знак ниже — и он окажется поверх
 * стекла: чёткая надпись посреди шапки, ровно то, что просили убрать. Ни
 * типов, ни линтера на такой порядок нет, поэтому его держит тест.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const GLASS = (): string => read('ui', 'components', 'GlassSurface.tsx');

describe('водяной знак в GlassSurface', () => {
  it('рисуется раньше BlurView — то есть попадает ему в подложку', () => {
    const source = GLASS();
    const mark = source.indexOf('<AirChatWordmark');
    const wash = source.indexOf('<CapsuleWash');
    const blur = source.indexOf('<BlurView');
    expect(mark).toBeGreaterThan(-1);
    expect(wash).toBeGreaterThan(-1);
    expect(blur).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(blur);
    expect(wash).toBeLessThan(blur);
  });

  it('при выключенной прозрачности не рисуется вовсе: прятать не за что', () => {
    expect(GLASS()).toContain('watermark && !solid');
  });

  it('не перехватывает нажатия шапки', () => {
    const source = GLASS();
    const block = source.slice(source.indexOf('watermark && !solid'), source.indexOf('<BlurView'));
    expect(block).toContain('pointerEvents="none"');
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
