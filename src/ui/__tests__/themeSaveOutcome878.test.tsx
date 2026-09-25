/**
 * v4.32.878. Тема, акцент, размер шрифта и часы ночного режима сохранялись
 * вслепую.
 *
 * Дефект. Все четыре настройки вида писались через `kvSet`, а он гасит отказ
 * базы внутри себя и возвращает `void`: у вызывающего не было даже возможности
 * узнать, легло ли. Экран перекрашивался сразу и навсегда — до перезапуска.
 *
 * Цена. Человек выбирает светлую тему, видит светлую тему, закрывает
 * приложение — и открывает его тёмным. Ни слова о том, что выбор не сохранён,
 * и никакой связи между выбором и откатом: между ними целый запуск. То же с
 * размером шрифта (важен тем, кто плохо видит), акцентом и расписанием ночи.
 *
 * Правка. Записи переведены на `kvSetChecked`, который отказ возвращает.
 * Настройки отвечают за себя сами: не легло — вид возвращается прежний и об
 * этом говорят теми же словами, что и остальные настройки. Проверка стоит
 * внутри контекста, а не у вызывающих: их пятеро, все зовут через `void`, и
 * каждый новый забыл бы проверить так же.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => { unmount: () => void };
};

/** Ключи, которые база откажется принимать; пусто — принимает всё. */
let mockRefuse = new Set<string>();
let mockWrites: Array<[string, string]> = [];
jest.mock('../../core/storage/local', () => ({
  kvGet: jest.fn(async () => null),
  // v4.32.964: чтение вида при запуске спрашивает базу трёхсловно —
  // «нет записи» и «не прочитали» перестали быть одним и тем же ответом.
  kvTryGet: jest.fn(async () => ({ value: null })),
  // Прежняя слепая запись оставлена в макете нарочно: без неё проверки
  // «не пустая» падали бы на старом коде из-за отсутствия функции, а не
  // из-за поведения, и разницу между до и после было бы не видно.
  kvSet: jest.fn(async (key: string, value: string) => { mockWrites.push([key, value]); }),
  kvSetChecked: jest.fn(async (key: string, value: string) => {
    mockWrites.push([key, value]);
    return !mockRefuse.has(key);
  }),
}));
const mockError = jest.fn();
jest.mock('../components/userFeedback', () => ({ showError: (m: string) => mockError(m) }));

import { ThemeProvider, THEME_SAVE_FAILED_TEXT, useTheme } from '../ThemeContext';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');
/** Код без комментариев: слова из докблоков не должны считаться за проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim() ? l : ' ')).join('\n');

type Api = ReturnType<typeof useTheme>;

/**
 * Живой провайдер и доступ к его значению снаружи.
 *
 * Чтение сохранённого при запуске дожидается здесь же: в приложении человек
 * доходит до настроек заведомо позже, а в тесте его ответ иначе приезжает
 * поверх выбора и затирает его.
 */
async function mount(): Promise<{ api: () => Api; unmount: () => void }> {
  let latest: Api | null = null;
  function Probe(): null {
    latest = useTheme();
    return null;
  }
  let tree: { unmount: () => void } = { unmount: () => {} };
  await act(async () => {
    tree = TestRenderer.create(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  mockWrites = [];
  mounted.push(tree);
  return {
    api: () => {
      if (!latest) throw new Error('провайдер не отдал значение');
      return latest;
    },
    unmount: () => tree.unmount(),
  };
}

/** Провайдер держит таймер ночного режима — снимаем даже после падения. */
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (mounted.length) act(() => { mounted.pop()?.unmount(); });
});

beforeEach(() => {
  mockRefuse = new Set();
  mockWrites = [];
  mockError.mockClear();
});

describe('v4.32.878 — настройки вида отвечают за себя', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ (проходит и на старом коде)', () => {
    it('провайдер и правда меняет вид, когда база принимает запись', async () => {
      const t = await mount();
      let ok: unknown;
      await act(async () => { ok = await t.api().setMode('light'); });
      expect(t.api().mode).toBe('light');
      expect(mockWrites).toContainEqual(['app_theme_mode', 'light']);
      expect(mockError).not.toHaveBeenCalled();
      expect(ok === true || ok === undefined).toBe(true);
    });

    it('размер шрифта и акцент доезжают до записи', async () => {
      const t = await mount();
      await act(async () => { await t.api().setFontSize(20); });
      await act(async () => { await t.api().setAccentColor('#2E7D32'); });
      expect(t.api().fontSize).toBe(20);
      expect(mockWrites.map(([k]) => k)).toEqual(
        expect.arrayContaining(['app_font_size', 'app_accent_color']),
      );
    });

    it('ночной режим пишет все три ключа', async () => {
      const t = await mount();
      await act(async () => { await t.api().setAutoNight(true, 22, 6); });
      expect(mockWrites).toEqual(
        expect.arrayContaining([
          ['auto_night_mode', 'true'],
          ['auto_night_start', '22'],
          ['auto_night_end', '6'],
        ]),
      );
    });
  });

  describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
    it('kvSet по-прежнему глотает отказ и возвращает void', () => {
      const src = fs.readFileSync(path.join(UI, '../core/storage/local.ts'), 'utf8');
      expect(src).toContain('export async function kvSet(');
      expect(src).toMatch(/export async function kvSet\([^)]*\): Promise<void>/);
      expect(src).toMatch(/export async function kvSetChecked\([^)]*\): Promise<boolean>/);
    });

    it('вызывающие результат не проверяют — значит, отвечать должен контекст', () => {
      const settings = codeOnly(read('screens/SettingsScreen.tsx'));
      expect(settings).toContain('void setFontSize(');
      expect(settings).toContain('void setAutoNight(');
      expect(settings).toContain('void setAccentColor(');
      expect(codeOnly(read('components/ThemeSwitchButton.tsx'))).toContain('void setMode(');
    });
  });

  describe('отказ базы виден на экране', () => {
    it('тема возвращается прежней и об этом говорят', async () => {
      const t = await mount();
      await act(async () => { await t.api().setMode('light'); });
      mockError.mockClear();
      mockRefuse = new Set(['app_theme_mode']);
      let ok: unknown;
      await act(async () => { ok = await t.api().setMode('dark'); });
      expect(ok).toBe(false);
      expect(t.api().mode).toBe('light');
      expect(mockError).toHaveBeenCalledTimes(1);
      expect(mockError).toHaveBeenCalledWith(THEME_SAVE_FAILED_TEXT);
    });

    it('размер шрифта возвращается прежним', async () => {
      const t = await mount();
      await act(async () => { await t.api().setFontSize(17); });
      mockRefuse = new Set(['app_font_size']);
      let ok: unknown;
      await act(async () => { ok = await t.api().setFontSize(13); });
      expect(ok).toBe(false);
      expect(t.api().fontSize).toBe(17);
      expect(mockError).toHaveBeenCalledWith(THEME_SAVE_FAILED_TEXT);
    });

    it('акцент возвращается прежним', async () => {
      const t = await mount();
      await act(async () => { await t.api().setAccentColor('#2E7D32'); });
      const before = t.api().accentColor;
      mockRefuse = new Set(['app_accent_color']);
      let ok: unknown;
      await act(async () => { ok = await t.api().setAccentColor('#1565C0'); });
      expect(ok).toBe(false);
      expect(t.api().accentColor).toBe(before);
      expect(mockError).toHaveBeenCalledWith(THEME_SAVE_FAILED_TEXT);
    });

    it('расписание ночи откатывается целиком, даже если не легла одна запись', async () => {
      const t = await mount();
      await act(async () => { await t.api().setAutoNight(true, 22, 6); });
      mockWrites = [];
      mockRefuse = new Set(['auto_night_end']);
      let ok: unknown;
      await act(async () => { ok = await t.api().setAutoNight(true, 1, 5); });
      expect(ok).toBe(false);
      expect(t.api().autoNightEnabled).toBe(true);
      expect(t.api().autoNightStart).toBe(22);
      expect(t.api().autoNightEnd).toBe(6);
      // Начало легло, конец — нет: на диске осталось бы получасовое чудище
      // «с 1:00 до 6:00», которого никто не выбирал. Возвращаем прежние.
      expect(mockWrites).toEqual(
        expect.arrayContaining([
          ['auto_night_mode', 'true'],
          ['auto_night_start', '22'],
          ['auto_night_end', '6'],
        ]),
      );
      expect(mockError).toHaveBeenCalledWith(THEME_SAVE_FAILED_TEXT);
    });

    it('удачная запись молчит', async () => {
      const t = await mount();
      await act(async () => { await t.api().setAutoNight(true, 22, 6); });
      await act(async () => { await t.api().setMode('light'); });
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  describe('слепой записи в теме не осталось', () => {
    it('ThemeContext не зовёт kvSet вовсе', () => {
      const src = codeOnly(read('ThemeContext.tsx'));
      expect(src).not.toMatch(/\bkvSet\(/);
      expect(src).toContain('kvSetChecked');
    });

    it('слова те же, что у остальных настроек', () => {
      expect(THEME_SAVE_FAILED_TEXT).toBe('Настройка не сохранилась. Попробуйте ещё раз.');
      expect(codeOnly(read('screens/SettingsScreen.tsx'))).toContain(THEME_SAVE_FAILED_TEXT);
    });
  });
});
