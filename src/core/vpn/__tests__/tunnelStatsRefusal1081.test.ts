/**
 * ДЕФЕКТ (v4.32.1081). Кнопка счётчика соединений выдавала отказ ядра за
 * отсутствие счётчика в сборке.
 *
 * `enableOpenFluxTunnelStats()` отвечал одним `false` на три разных случая:
 * платформа без ядра OpenFlux, ядро без метода `enableTunnelStats`, и ядро,
 * которое на этот метод бросило исключение. Инженерный раздел настроек на все
 * три говорил «В этой версии приложения счётчик недоступен».
 *
 * ЦЕНА. Счётчик — единственный способ узнать, что перехват HTTP не встал и
 * запросы тихо идут мимо туннеля: noteHttpLayer в том же файле объясняет, что
 * снаружи это выглядит как «Канал поднят», а проверить можно только через этот
 * счётчик. Человек, который до него добрался, получал утверждение о своей
 * сборке — счётчика тут нет, искать нечего, — и переставал пробовать там, где
 * помогло бы второе нажатие. Сам openFluxController в заголовке объясняет,
 * почему состояний туннеля намеренно шесть, а не четыре: «слить их в одно
 * `failed` означало бы отправить человека искать поломку там, где её нет».
 * Здесь была ровно та же ошибка, только в отладочном углу.
 *
 * ПРАВКА. Ядро отвечает разрядом: 'on', 'unsupported', 'refused'. Экран берёт
 * подпись по разряду и добавляет четвёртый, свой: включили, а первый отсчёт
 * ядро не отдало — прежде строка статистики просто не появлялась и нажатие
 * выглядело пустым.
 *
 * ГРАНИЦЫ. Ничего не повторяется само: включение счётчика печатает в журнал
 * адрес каждого соединения, потому кнопка и отдельная, и нажимает её человек.
 * Меняется только то, что́ ему сказано. Удачный путь — прежний.
 */
import fs from 'fs';
import path from 'path';

import {
  tunnelStatsRefusalText,
  type TunnelStatsRefusal,
} from '../tunnelStatsRefusal';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const CORE = () => read('core', 'vpn', 'openFluxController.ts');
const SECTION = () => read('ui', 'components', 'OpenFluxSettingsSection.tsx');

const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const ALL: TunnelStatsRefusal[] = ['unsupported', 'refused', 'silent'];

describe('отказ счётчика называет себя', () => {
  it('три разряда — три разные непустые подписи', () => {
    const texts = ALL.map(tunnelStatsRefusalText);
    texts.forEach((t) => expect(t.length).toBeGreaterThan(0));
    expect(new Set(texts).size).toBe(3);
  });

  it('про сборку говорит только «unsupported»', () => {
    expect(tunnelStatsRefusalText('unsupported')).toContain('сборке');
    expect(tunnelStatsRefusalText('refused')).not.toContain('сборке');
    expect(tunnelStatsRefusalText('silent')).not.toContain('сборке');
  });

  it('отказ ядра зовёт нажать ещё раз, а отсутствие счётчика — нет', () => {
    expect(tunnelStatsRefusalText('refused')).toContain('ещё раз');
    expect(tunnelStatsRefusalText('silent')).toContain('ещё раз');
    expect(tunnelStatsRefusalText('unsupported')).not.toContain('ещё раз');
  });

  it('молчание ядра не выдаётся за выключенный счётчик', () => {
    expect(tunnelStatsRefusalText('silent')).toContain('включён');
  });

  it('прежних слов про «эту версию приложения» нигде не осталось', () => {
    const texts = ALL.map(tunnelStatsRefusalText);
    texts.forEach((t) => expect(t).not.toContain('В этой версии приложения'));
    expect(SECTION()).not.toContain('В этой версии приложения счётчик недоступен');
  });

  it('решение о словах ничего не читает само: модуль без импортов', () => {
    expect(read('core', 'vpn', 'tunnelStatsRefusal.ts')).not.toContain('\nimport ');
  });
});

describe('форма правки', () => {
  it('ядро отвечает разрядом, а не «да/нет»', () => {
    const code = codeOnly(CORE());
    expect(code).toContain(
      "export type OpenFluxStatsStart = 'on' | 'unsupported' | 'refused';",
    );
    expect(code).toContain(
      'export async function enableOpenFluxTunnelStats(): Promise<OpenFluxStatsStart> {',
    );
  });

  it('каждая причина отказа названа своим разрядом', () => {
    const fn = slice(
      CORE(),
      'export async function enableOpenFluxTunnelStats(',
      '/** `null` — счётчика на этой платформе нет',
    );
    // Платформа без ядра и ядро без метода — обе про сборку.
    expect(fn.split("return 'unsupported';").length - 1).toBe(2);
    expect(fn).toContain("return 'on';");
    expect(fn).toContain("return 'refused';");
  });

  it('экран берёт подпись у разряда, а не сочиняет её на месте', () => {
    const btn = slice(SECTION(), 'const countBtn = useAsyncButton(', '\n  });');
    expect(btn).toContain('const start = await enableOpenFluxTunnelStats();');
    expect(btn).toContain("if (start !== 'on') {");
    expect(btn).toContain('showError(tunnelStatsRefusalText(start));');
  });

  it('включённый, но молчащий счётчик тоже назван', () => {
    const btn = slice(SECTION(), 'const countBtn = useAsyncButton(', '\n  });');
    expect(btn).toContain('const first = await getOpenFluxTunnelStats();');
    expect(btn).toContain('if (!first) {');
    expect(btn).toContain("showError(tunnelStatsRefusalText('silent'));");
    expect(btn).toContain('setStats(first);');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('счётчик по-прежнему включается только руками, и это объяснено', () => {
    const doc = slice(SECTION(), 'Включить подсчёт соединений.', 'const countBtn');
    expect(doc).toContain('отладочный режим без выключателя');
    expect(doc).toContain('адрес каждого соединения');
  });

  it('чтение счётчика по-прежнему отвечает `null`, а не нулём', () => {
    const code = codeOnly(CORE());
    expect(code).toContain(
      'export async function getOpenFluxTunnelStats(): Promise<OpenFluxTunnelStats | null> {',
    );
  });

  it('отказ ядра по-прежнему попадает в журнал', () => {
    const fn = slice(
      CORE(),
      'export async function enableOpenFluxTunnelStats(',
      '/** `null` — счётчика на этой платформе нет',
    );
    expect(fn).toContain("log.warn('openflux_stats_enable_failed'");
    expect(fn).toContain("log.info('openflux_stats_enabled')");
  });

  it('строка статистики на экране осталась на месте', () => {
    expect(SECTION()).toContain('Соединений через туннель: {stats.connections}');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отказ ядра — настоящая ветка, а не выдумка: он ловится try/catch', () => {
    const fn = slice(
      CORE(),
      'export async function enableOpenFluxTunnelStats(',
      '/** `null` — счётчика на этой платформе нет',
    );
    expect(fn).toContain('await mod.enableTunnelStats();');
    expect(fn).toContain('} catch (e) {');
  });

  it('счётчик — единственный способ узнать про перехват мимо туннеля', () => {
    // Если бы о том же говорило что-то ещё, цена вранья была бы меньше.
    // Комментарий рядом с noteHttpLayer ровно про это.
    const doc = slice(CORE(), 'Спросить у платформы, попал ли перехват HTTP', 'async function noteHttpLayer');
    expect(doc).toContain('включить счётчик соединений');
    expect(doc).toContain('практически никак');
  });

  it('тот же файл сам запрещает сливать разные причины в одну', () => {
    expect(CORE()).toContain('Состояний намеренно шесть, а не четыре');
  });
});
