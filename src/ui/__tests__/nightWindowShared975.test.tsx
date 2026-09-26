/**
 * Окно часов посчитано одной формулой на оба режима (v4.32.975).
 *
 * Дефект. Окон в приложении два — тишина «не беспокоить» и ночная тема, — и
 * формула «попадает ли час в [начало, конец) с переходом через полночь» была
 * выписана дважды: `isWithinDndWindow` в слое уведомлений и локальная
 * `isInNightWindow` внутри `ThemeContext`. Совпадали они до последней ветки,
 * но проверками была накрыта только первая.
 *
 * Цена. Ошибку в переходе через полночь замечают по одному из двух режимов —
 * «ночная тема включилась днём» или «уведомления молчат не в то время», — и
 * правят ту копию, из-за которой пожаловались. Вторая остаётся как была.
 *
 * Правка. Формула одна, в `core/time/hourOfDay`: у модуля нет импортов, а
 * тишину зовёт фоновый обработчик push в своём контексте. Оба режима зовут
 * её, в `ThemeContext` своей копии больше нет.
 *
 * Границы. Поведение прежнее у обоих: тот же полуоткрытый интервал, тот же
 * переход через полночь, те же пустые сутки при равных границах.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => { unmount: () => void };
};

let mockAnswers: Record<string, { value: string | null } | null> = {};

jest.mock('../../core/storage/local', () => ({
  kvGet: jest.fn(async (key: string) => mockAnswers[key]?.value ?? null),
  kvTryGet: jest.fn(async (key: string) => (key in mockAnswers ? mockAnswers[key] : { value: null })),
  kvSetChecked: jest.fn(async () => true),
  kvSet: jest.fn(async () => undefined),
}));
jest.mock('../components/userFeedback', () => ({ showError: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { isWithinHourWindow } from '../../core/time/hourOfDay';
import { isWithinDndWindow } from '../../notifications/dndWindow';
import { ThemeProvider, useTheme } from '../ThemeContext';

/** Код без комментариев: слова из докблоков не должны считаться за проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim() ? l : ' ')).join('\n');
const THEME_SRC = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'ThemeContext.tsx'), 'utf8'));
const DND_SRC = codeOnly(fs.readFileSync(path.join(__dirname, '..', '..', 'notifications', 'dndWindow.ts'), 'utf8'));

type Api = ReturnType<typeof useTheme>;

const mounted: Array<{ unmount: () => void }> = [];

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** Поднять провайдер на сохранённом виде и отдать то, что он показывает. */
async function mount(): Promise<() => Api> {
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
  await flush();
  mounted.push(tree);
  return () => {
    if (!latest) throw new Error('провайдер не отдал значение');
    return latest;
  };
}

/** Ночная тема с 21:00 до 07:00 поверх светлой темы человека. */
function nightFrom(start: string, end: string): Record<string, { value: string | null }> {
  return {
    app_theme_mode: { value: 'light' },
    app_font_size: { value: '15' },
    auto_night_mode: { value: 'true' },
    auto_night_start: { value: start },
    auto_night_end: { value: end },
    app_accent_color: { value: null },
  };
}

/** Который час на устройстве, когда поднимается провайдер. */
function atHour(hour: number): void {
  jest.setSystemTime(new Date(2026, 0, 15, hour, 30, 0));
}

beforeEach(() => {
  jest.useFakeTimers();
  mockAnswers = {};
});

afterEach(() => {
  while (mounted.length) act(() => { mounted.pop()?.unmount(); });
  jest.useRealTimers();
});

describe('ночная тема считает своё окно общей формулой', () => {
  it('в полночь внутри окна 21–7 показывается тёмная', async () => {
    mockAnswers = nightFrom('21', '7');
    atHour(0);
    const api = await mount();
    expect(api().scheme).toBe('dark');
  });

  it('вечером до начала окна остаётся выбранная светлая', async () => {
    mockAnswers = nightFrom('21', '7');
    atHour(20);
    const api = await mount();
    expect(api().scheme).toBe('light');
  });

  it('ГРАНИЦА: ровно в час начала окно уже действует', async () => {
    mockAnswers = nightFrom('21', '7');
    atHour(21);
    const api = await mount();
    expect(api().scheme).toBe('dark');
  });

  it('ГРАНИЦА: ровно в час конца окно уже кончилось', async () => {
    mockAnswers = nightFrom('21', '7');
    atHour(7);
    const api = await mount();
    expect(api().scheme).toBe('light');
  });

  it('ГРАНИЦА: равные границы — пустые сутки, а не круглосуточная ночь', async () => {
    mockAnswers = nightFrom('22', '22');
    atHour(22);
    const api = await mount();
    expect(api().scheme).toBe('light');
  });

  it('ГРАНИЦА: окно внутри суток, без перехода через полночь', async () => {
    mockAnswers = nightFrom('13', '15');
    atHour(14);
    const api = await mount();
    expect(api().scheme).toBe('dark');
  });
});

describe('тишина «не беспокоить» считает своё окно тем же', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: прежние ответы окна тишины не изменились', () => {
    expect(isWithinDndWindow(22, 8, 23)).toBe(true);
    expect(isWithinDndWindow(22, 8, 7)).toBe(true);
    expect(isWithinDndWindow(22, 8, 9)).toBe(false);
    expect(isWithinDndWindow(9, 18, 9)).toBe(true);
    expect(isWithinDndWindow(9, 18, 18)).toBe(false);
    expect(isWithinDndWindow(22, 22, 22)).toBe(false);
  });

  it('оба режима спрашивают одну и ту же функцию', () => {
    for (let start = 0; start < 24; start += 1) {
      for (let end = 0; end < 24; end += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
          expect(isWithinDndWindow(start, end, hour)).toBe(isWithinHourWindow(start, end, hour));
        }
      }
    }
  });
});

describe('второй копии формулы не осталось', () => {
  it('ЗАКРЕПКА: у вида темы больше нет своего окна', () => {
    expect(THEME_SRC).not.toContain('function isInNightWindow');
    expect(THEME_SRC).toContain('isWithinHourWindow(nStart, nEnd, new Date().getHours())');
  });

  it('ЗАКРЕПКА: тишина не считает окно сама', () => {
    expect(DND_SRC).toContain('return isWithinHourWindow(start, end, hour);');
    // Ветки перехода через полночь в слое уведомлений быть не должно.
    expect(DND_SRC).not.toContain('return hour >= start || hour < end;');
  });
});
