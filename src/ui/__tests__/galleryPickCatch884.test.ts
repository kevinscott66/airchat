/**
 * v4.32.884 — галерея не открылась, и никто об этом не сказал.
 *
 * Дефект: три входа в галерею звали асинхронный обработчик через `void` —
 * «приложить фото» в личной переписке (`pickImage`), те же три кнопки в
 * группах (`pickGroupImage`) и выбор кадра для сторис (`pick`). Обещание
 * отпускали без ловца: разрешение спросить не удалось, модуль выбора не
 * отозвался, галерея упала на возврате — отклонение уходило в пустоту.
 *
 * Цена: нажатие не делает ровно ничего. Ни окна, ни ошибки, ни строчки в
 * журнале — разбираться потом не по чему. Человек жмёт второй раз, третий, и
 * решает, что сломано приложение целиком. На Android отказ здесь не редкость:
 * системный выбор живёт отдельной активностью, и нашу при этом вправе убить.
 *
 * Правка: общая обёртка `runGalleryPick` — по образцу фона чата (v4.32.717) и
 * буфера обмена (v4.32.883). Ждёт обещание, отказ называет по-русски и кладёт
 * причину в журнал. Стоит она на вызове, а не внутри обработчика: тела
 * `pickImage`/`pickGroupImage` закреплены проверкой v4.32.871 вплоть до
 * отступов, и оборачивать их в try — значит её сломать.
 */
import fs from 'fs';
import path from 'path';

const mockShowError = jest.fn();
jest.mock('../components/userFeedback', () => ({
  showError: (m: string) => mockShowError(m),
  showSuccess: jest.fn(),
}));

const mockWarn = jest.fn();
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: (m: string, meta?: unknown) => mockWarn(m, meta), debug: jest.fn(), error: jest.fn() },
}));

import { GALLERY_PICK_FAILED, runGalleryPick } from '../galleryPick';

/** Обёртка ничего не возвращает — отклонение она гасит у себя внутри. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockShowError.mockClear();
  mockWarn.mockClear();
});

describe('v4.32.884 — отказ галереи доходит до человека', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
    it('удачный выбор молчит — лишних окон обёртка не приносит', async () => {
      runGalleryPick(async () => { /* выбрали и разобрали */ });
      await settle();
      expect(mockShowError).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('запасной текст написан по-русски и человеку понятен', () => {
      expect(GALLERY_PICK_FAILED).toMatch(/[А-Яа-яЁё]/);
      expect(GALLERY_PICK_FAILED.length).toBeGreaterThan(10);
    });
  });

  describe('отказ не остаётся без слов', () => {
    it('обещание отклонили — человек видит русский текст', async () => {
      runGalleryPick(() => Promise.reject(new Error('Network request failed')));
      await settle();
      expect(mockShowError).toHaveBeenCalledWith(GALLERY_PICK_FAILED);
    });

    it('машинный текст ошибки на экран не выносят', async () => {
      runGalleryPick(() => Promise.reject(new Error('NoSuchMethodError: getImageLoader()')));
      await settle();
      expect(String(mockShowError.mock.calls[0][0])).not.toContain('NoSuchMethodError');
    });

    it('причина уходит в журнал — иначе разбирать нечего', async () => {
      runGalleryPick(() => Promise.reject(new Error('picker did not respond')));
      await settle();
      expect(mockWarn).toHaveBeenCalledWith('gallery_pick_failed', expect.anything());
    });

    it('отказ до первого await приходит броском — его тоже ловят', async () => {
      runGalleryPick(() => {
        throw new Error('ImagePicker is not available');
      });
      await settle();
      expect(mockShowError).toHaveBeenCalledWith(GALLERY_PICK_FAILED);
      expect(mockWarn).toHaveBeenCalledWith('gallery_pick_failed', expect.anything());
    });

    it('свой русский текст исключения обёртка не затирает', async () => {
      runGalleryPick(() => Promise.reject(new Error('Нет доступа к галерее')));
      await settle();
      expect(mockShowError).toHaveBeenCalledWith('Нет доступа к галерее');
    });
  });
});

const SRC_ROOT = path.join(__dirname, '..', '..');

/** Только код: в докблоках прежняя запись упоминается как цитата. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const ENTRIES = [
  ['личная переписка', path.join('ui', 'screens', 'ChatScreen.tsx'), 'pickImage'],
  ['группы', path.join('ui', 'screens', 'GroupsScreen.tsx'), 'pickGroupImage'],
  ['сторис', path.join('ui', 'components', 'StoryComposerModal.tsx'), 'pick'],
] as const;

const codeOf = (rel: string): string => codeOnly(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'));

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it.each(ENTRIES)('%s: обработчик по-прежнему асинхронный, и ловца внутри у него нет', (name, rel, fn) => {
    const code = codeOf(rel);
    const at = code.indexOf(`const ${fn} = useCallback(async (`);
    expect([name, at]).not.toEqual([name, -1]);
    // Запуск галереи стоит до любого `try` в теле обработчика — значит отказ
    // самого выбора внутри не ловится и обязан быть пойман на вызове.
    const launch = code.indexOf('await ImagePicker.launchImageLibraryAsync(', at);
    expect([name, launch]).not.toEqual([name, -1]);
    const tryAt = code.indexOf('try {', at);
    expect([name, tryAt === -1 || tryAt > launch]).toEqual([name, true]);
  });

  it('образец правильной записи стоит с v4.32.717 — фон чата', () => {
    const code = codeOf(path.join('ui', 'components', 'modals', 'chat', 'ChatWallpaperPickerModal.tsx'));
    expect(code).toContain('showError(userErrorText(e,');
  });
});

describe('ни один вход в галерею не остался без ловца', () => {
  it.each(ENTRIES)('%s зовёт обработчик через runGalleryPick', (name, rel) => {
    const code = codeOf(rel);
    expect([name, /import \{ runGalleryPick \} from '[^']*galleryPick';/.test(code)]).toEqual([name, true]);
    expect([name, code.includes('runGalleryPick(')]).toEqual([name, true]);
  });

  it.each(ENTRIES)('%s: прежней записи `void pick…()` не осталось', (name, rel, fn) => {
    const code = codeOf(rel);
    expect([name, new RegExp(`void ${fn}\\(`).test(code)]).toEqual([name, false]);
  });

  it('в группах обёрнуты все три кнопки, а не первая попавшаяся', () => {
    const code = codeOf(path.join('ui', 'screens', 'GroupsScreen.tsx'));
    expect(code.split('runGalleryPick(pickGroupImage)').length - 1).toBe(3);
  });

  it('в сторис обёрнуты оба входа — и пустой холст, и замена кадра', () => {
    const code = codeOf(path.join('ui', 'components', 'StoryComposerModal.tsx'));
    expect(code.split('runGalleryPick(() => pick(').length - 1).toBe(2);
  });
});
