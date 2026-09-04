/**
 * Из нижнего листа и из карточки профиля есть выход (v4.32.579).
 *
 * Проверка по исходнику: у обоих файлов нет рендер-теста, а утверждения тут
 * структурные — «касание мимо доходит до затемнения» и «жест закрывает
 * верхнее, а не экран под ним». Оба ломались молча и одинаково: разметка
 * выглядела правильной, а нажатие просто ничего не делало.
 *
 * Что именно было. Полка листа растянута на весь экран (лист прижат к её
 * низу) и лежит поверх затемнения. Обработчика у полки нет, у затемнения он
 * есть — но затемнение полке сосед, а не предок, и всплывать событию было
 * некуда: над листом экран становился глухим. А в стек `backStack` ни лист, ни
 * карточка не вставали вовсе, поэтому свайп пролистывал их насквозь до
 * обработчика экрана — из переписки это закрывало саму переписку.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const UI = join(__dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(UI, ...p), 'utf8');

const SHEET = (): string => read('components', 'SheetShell.tsx');
const PEEK = (): string => read('components', 'UserProfilePeek.tsx');

describe('выход из нижнего листа', () => {
  it('полка не забирает касание мимо листа', () => {
    const src = SHEET();
    // Порядок важен: `box-none` должен стоять именно у полки — у той
    // Animated.View, которая растянута во весь экран поверх затемнения.
    const dock = src.indexOf('styles.dock');
    expect(dock).toBeGreaterThan(0);
    const before = src.slice(0, dock);
    expect(before.lastIndexOf('pointerEvents="box-none"')).toBeGreaterThan(
      before.lastIndexOf('<Animated.View'),
    );
  });

  it('затемнение по-прежнему закрывает лист по нажатию', () => {
    expect(SHEET()).toContain('style={styles.scrim} onPress={onClose}');
  });

  it('лист встаёт в стек «Назад», пока он виден', () => {
    const src = SHEET();
    expect(src).toContain("import { useBackHandler } from '../../core/hooks/useBackHandler'");
    expect(src).toContain('useBackHandler(visible, back);');
  });
});

describe('выход из карточки профиля', () => {
  it('карточка тоже встаёт в стек «Назад»', () => {
    expect(PEEK()).toContain('useBackHandler(visible, back);');
  });

  it('«Назад» закрывает открытое в карточке раньше самой карточки', () => {
    const src = PEEK();
    const start = src.indexOf('const back = useCallback(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('useBackHandler(visible, back);'));
    // Всё, что открывается поверх карточки или внутри неё, закрывается первым;
    // сама карточка — последней, и только если больше закрывать нечего.
    for (const state of ['moreOpen', 'wallpaperOpen', 'qrOpen', 'editOpen', 'mediaTab', 'postsMode', 'openSection']) {
      expect(body.indexOf(state)).toBeGreaterThan(0);
      expect(body.indexOf(state)).toBeLessThan(body.indexOf('onClose();'));
    }
    expect(body).toContain('onClose();');
  });
});
