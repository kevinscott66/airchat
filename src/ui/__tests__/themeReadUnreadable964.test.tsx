/**
 * Непрочитанный вид больше не выдаётся за выбор человека (v4.32.964).
 *
 * Дефект. Шесть настроек вида — тема, размер шрифта, акцент, выключатель и
 * часы ночного режима — читались при запуске через `kvGet`. Он отдаёт `null` и
 * когда записи нет, и когда база вообще не открылась: провайдер темы
 * поднимается самым первым, до опознания профиля, то есть ровно тогда, когда
 * база занята миграциями или держит паузу после неудачного открытия. Отказ
 * читался как «человек ничего не выбирал», и поверх выбора вставали запасные
 * значения. Переспросить было некому: эффект отрабатывал один раз.
 *
 * Цена. Светлая тема становится тёмной, акцент — общим, «очень крупный» шрифт
 * падает до среднего. Последнее хуже всего: крупный шрифт выбирают не для
 * красоты. И объяснить человеку нечего — настройки показывают ему те же
 * подставленные значения, а не его собственные.
 *
 * Отдельно про потерю насовсем. Часы ночной темы пишутся тремя ключами разом:
 * если после такого запуска человек всего лишь щёлкнет выключателем
 * авторежима, на диск уедут подставленные 21:00–07:00 поверх настоящих. Он
 * трогал выключатель, а лишился расписания.
 *
 * Правка. Чтение переведено на `kvTryGet`, который «нет записи» и «не
 * прочитали» разводит. Непрочитанное не подменяется — остаётся то, что уже
 * показано, — и база переспрашивается: она самолечится, пауза после отказа
 * длится две секунды.
 *
 * Границы. Читаемая база ведёт себя в точности как прежде: запасные значения
 * при пустых записях, проверка испорченного часа (v4.32.929) на месте, лишних
 * походов нет.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => { unmount: () => void };
};

/**
 * Что база отвечает на каждый ключ.
 *
 * `null` — не прочитали (база не открылась), `{ value: null }` — прочитали, а
 * записи нет. Именно эту разницу правка и вводит.
 */
type Answer = { value: string | null } | null;
let mockAnswers: Record<string, Answer> = {};
/** Сколько раз ходили в базу за видом — считаем оба чтения, старое и новое. */
let mockReads = 0;

jest.mock('../../core/storage/local', () => ({
  // Прежнее теряющее чтение оставлено в макете нарочно и ведёт себя как в
  // жизни: отказ базы приходит к вызывающему неотличимо от пустоты. Без него
  // проверки падали бы на старом коде из-за отсутствующей функции, а не из-за
  // поведения, и разницы между «до» и «после» было бы не видно.
  kvGet: jest.fn(async (key: string) => {
    mockReads += 1;
    return mockAnswers[key]?.value ?? null;
  }),
  kvTryGet: jest.fn(async (key: string) => {
    mockReads += 1;
    return key in mockAnswers ? mockAnswers[key] : { value: null };
  }),
  kvSetChecked: jest.fn(async () => true),
  kvSet: jest.fn(async () => undefined),
}));
jest.mock('../components/userFeedback', () => ({ showError: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { ThemeProvider, useTheme } from '../ThemeContext';

const SRC_PATH = path.join(__dirname, '..', 'ThemeContext.tsx');
/** Код без комментариев: слова из докблоков не должны считаться за проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim() ? l : ' ')).join('\n');
const SRC = codeOnly(fs.readFileSync(SRC_PATH, 'utf8'));

type Api = ReturnType<typeof useTheme>;

/** Весь сохранённый вид разом — то, что лежит на исправной базе. */
function saved(over: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    app_theme_mode: { value: 'light' },
    app_font_size: { value: '20' },
    auto_night_mode: { value: 'true' },
    auto_night_start: { value: '23' },
    auto_night_end: { value: '6' },
    app_accent_color: { value: '#2E7D32' },
    ...over,
  };
}

/** Ни один ключ не прочитался: база не открылась. */
function unreadable(): Record<string, Answer> {
  return {
    app_theme_mode: null,
    app_font_size: null,
    auto_night_mode: null,
    auto_night_start: null,
    auto_night_end: null,
    app_accent_color: null,
  };
}

/** Провайдер держит таймеры — снимаем даже после падения. */
const mounted: Array<{ unmount: () => void }> = [];

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** Прокрутить время на столько же, на сколько ждёт переспрос, и дать ответить. */
async function tickRetry(ms = 2600): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(ms); });
  await flush();
}

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
  await flush();
  mounted.push(tree);
  return {
    api: () => {
      if (!latest) throw new Error('провайдер не отдал значение');
      return latest;
    },
    unmount: () => {
      act(() => { tree.unmount(); });
      const at = mounted.indexOf(tree);
      if (at >= 0) mounted.splice(at, 1);
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockAnswers = {};
  mockReads = 0;
});

afterEach(() => {
  while (mounted.length) act(() => { mounted.pop()?.unmount(); });
  jest.useRealTimers();
});

describe('база не открылась — вид переспрашивают, а не подменяют', () => {
  it('тема, шрифт и акцент доезжают со второй попытки', async () => {
    mockAnswers = unreadable();
    const t = await mount();

    mockAnswers = saved();
    await tickRetry();

    expect(t.api().mode).toBe('light');
    expect(t.api().fontSize).toBe(20);
    expect(t.api().accentColor).toBe('#2e7d32');
  });

  it('расписание ночи доезжает настоящее, а не запасное', async () => {
    mockAnswers = unreadable();
    const t = await mount();
    // До ответа базы показано начальное — это не выбор человека, и записывать
    // его некуда; важно лишь, что оно не остаётся навсегда.
    mockAnswers = saved();
    await tickRetry();

    expect(t.api().autoNightEnabled).toBe(true);
    expect(t.api().autoNightStart).toBe(23);
    expect(t.api().autoNightEnd).toBe(6);
  });

  it('не прочитался один ключ из шести — переспрашивают всё равно', async () => {
    mockAnswers = saved({ app_font_size: null });
    const t = await mount();
    expect(t.api().fontSize).toBe(15);

    mockAnswers = saved();
    await tickRetry();
    expect(t.api().fontSize).toBe(20);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Переспрос обязан остаться редким и конечным. Читаемая база не должна ловить
 * ни одного лишнего похода, пустая запись — по-прежнему означать «человек не
 * выбирал», а испорченный час — попадать на запасной (v4.32.929).
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: читаемая база ведёт себя как прежде', () => {
  it('сохранённый вид поднимается с первого раза', async () => {
    mockAnswers = saved();
    const t = await mount();
    expect(t.api().mode).toBe('light');
    expect(t.api().fontSize).toBe(20);
    expect(t.api().accentColor).toBe('#2e7d32');
    expect(t.api().autoNightStart).toBe(23);
  });

  it('записей нет — запасные значения, и это не отказ базы', async () => {
    mockAnswers = {
      app_theme_mode: { value: null },
      app_font_size: { value: null },
      auto_night_mode: { value: null },
      auto_night_start: { value: null },
      auto_night_end: { value: null },
      app_accent_color: { value: null },
    };
    const t = await mount();
    expect(t.api().mode).toBe('dark');
    expect(t.api().fontSize).toBe(15);
    expect(t.api().accentColor).toBeNull();
    expect(t.api().autoNightEnabled).toBe(false);
  });

  it('ГРАНИЦА: шесть чтений и ни одного лишнего похода после них', async () => {
    mockAnswers = saved();
    await mount();
    expect(mockReads).toBe(6);
    await tickRetry(3 * 2600);
    expect(mockReads).toBe(6);
  });

  it('ГРАНИЦА: испорченный час по-прежнему падает на запасной', async () => {
    mockAnswers = saved({ auto_night_start: { value: 'без четверти' } });
    const t = await mount();
    expect(t.api().autoNightStart).toBe(21);
    expect(t.api().autoNightEnd).toBe(6);
  });

  it('ГРАНИЦА: снятый провайдер в базу больше не ходит', async () => {
    mockAnswers = unreadable();
    const t = await mount();
    const before = mockReads;
    t.unmount();
    await tickRetry(5 * 2600);
    expect(mockReads).toBe(before);
  });
});

describe('форма исходников: чтение вида различает отказ и пустоту', () => {
  it('вид читается трёхсловно, теряющего чтения в файле не осталось', () => {
    expect(SRC).toContain("kvTryGet('app_theme_mode')");
    expect(SRC).toContain("kvTryGet('app_font_size')");
    expect(SRC).toContain("kvTryGet('app_accent_color')");
    expect(SRC).not.toContain('kvGet(');
  });

  it('переспрос конечен и снимается вместе с провайдером', () => {
    expect(SRC).toContain('THEME_READ_ATTEMPTS');
    expect(SRC).toContain('THEME_READ_RETRY_MS');
    expect(SRC).toContain('clearTimeout(timer)');
  });
});
