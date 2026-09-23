/**
 * v4.32.729: отказ сохранить настройку больше не молчит.
 *
 * `saveConfigOverride` теперь вправе отказаться: прежние переопределения не
 * прочитались, слить с ними патч не с чем, а положить на место файла один патч
 * значило бы стереть всё остальное — адрес своего ретранслятора, настройки VPN
 * и туннеля. Отказ приходит исключением, и показать его обязан вызывающий:
 *
 * — `useAsyncButton` чужое исключение сводит к `console.warn`, то есть кнопка
 *   «Сохранить» молчала бы, а человек был бы уверен, что адрес записан;
 * — выключатель ретранслятора вовсе запускает сохранение через `void (async
 *   …)()` — там исключение некому поймать даже в журнал, это unhandled
 *   rejection;
 * — рычажок в обоих переключателях двигается ДО записи (иначе застывший
 *   рычажок читается как «не нажалось»), и если запись не прошла, его надо
 *   вернуть: иначе экран показывает не то, что настроено.
 *
 * Проверяется исходник: компоненты настроек в jest не поднимаются.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (name: string): string =>
  fs
    .readFileSync(path.join(__dirname, '..', name), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const RELAY = read('RelaySettingsSection.tsx');
const VPN = read('VpnSettingsSection.tsx');
const OPENFLUX = read('OpenFluxSettingsSection.tsx');

/** Все три экрана настроек, которые пишут переопределения конфига. */
const ALL: Array<[string, string]> = [
  ['ретранслятор', RELAY],
  ['VPN', VPN],
  ['туннель', OPENFLUX],
];

/** Стоит ли место `at` внутри try: ближайший `try {` ближе, чем ближайший `} catch`. */
function insideTry(src: string, at: number): boolean {
  const head = src.slice(0, at);
  return head.lastIndexOf('try {') > head.lastIndexOf('} catch');
}

describe('каждое сохранение настройки обёрнуто', () => {
  it('ретранслятор и VPN: ни одного голого вызова без перехвата', () => {
    for (const src of [RELAY, VPN]) {
      const calls = src.split('saveConfigOverride(').length - 1;
      expect(calls).toBeGreaterThan(0);
      for (let at = src.indexOf('saveConfigOverride('); at > 0; at = src.indexOf('saveConfigOverride(', at + 1)) {
        expect(insideTry(src, at)).toBe(true);
      }
    }
  });

  it('туннель: вызов спрятан в помощнике, и ждут его под перехватом', () => {
    // Здесь saveConfigOverride один и живёт в `persist`; ловит не он, а
    // единственное место, где `persist` ждут.
    expect(OPENFLUX.split('saveConfigOverride(').length - 1).toBe(1);
    expect(OPENFLUX).toContain(
      'const persist = useCallback(async (on: boolean): Promise<AppConfig> => {'
    );
    expect(OPENFLUX.split('await persist(').length - 1).toBe(1);
    const at = OPENFLUX.indexOf('const cfg = await persist(on);');
    expect(at).toBeGreaterThan(0);
    expect(insideTry(OPENFLUX, at)).toBe(true);
  });

  it.each(ALL)('%s: текст отказа показан человеку, а не только в журнал', (_name, src) => {
    expect(src).toContain("import { userErrorText } from './userErrorText';");
    expect(src).toContain('showError(userErrorText(e,');
  });
});

/** Тело обработчика переключателя ретранслятора целиком. */
function relayToggle(): string {
  const a = RELAY.indexOf('const onToggleEnabled = useCallback(');
  expect(a).toBeGreaterThan(0);
  const b = RELAY.indexOf('[activeBase, restartTransport],', a);
  expect(b).toBeGreaterThan(a);
  return RELAY.slice(a, b);
}

/** Тело обработчика переключателя туннеля целиком. */
function openfluxToggle(): string {
  const a = OPENFLUX.indexOf('const onToggle = useCallback(');
  expect(a).toBeGreaterThan(0);
  const b = OPENFLUX.indexOf('[persist, restartTransport],', a);
  expect(b).toBeGreaterThan(a);
  return OPENFLUX.slice(a, b);
}

describe('рычажок возвращается, когда запись не прошла', () => {
  it('выключатель ретранслятора: отказ ловится прямо в void-обещании', () => {
    // Рамка — сам обработчик: `void (async …)` в файле не один, и первый из них
    // к переключателю отношения не имеет.
    const body = relayToggle();
    expect(body).toContain('void (async () => {');
    expect(body).toContain('try {');
    expect(body).toContain('setEnabled(!next);');
    expect(body).toContain('showError(userErrorText(e,');
  });

  it('переключатель туннеля: положение возвращается вместе с «не вышло»', () => {
    const at = OPENFLUX.indexOf("setStatus('failed');\n        showError(userErrorText(e,");
    expect(at).toBeGreaterThan(0);
    expect(OPENFLUX.slice(at - 60, at)).toContain('setEnabled(!on);');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('useAsyncButton по-прежнему гасит исключение в console.warn', () => {
    const hook = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'core', 'hooks', 'useAsyncButton.ts'),
      'utf8'
    );
    expect(hook).toContain("console.warn('[useAsyncButton] Unhandled error:', e);");
  });

  it('сохранение вправду умеет отказать', () => {
    const config = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'core', 'config.ts'),
      'utf8'
    );
    expect(config).toContain('if (existingOverride === null) {');
    expect(config).toContain('прежние настройки целы');
  });

  it('рычажки по-прежнему двигаются до записи, а не после', () => {
    // Иначе возвращать было бы нечего: рычажок и так стоял бы на прежнем месте.
    const relay = relayToggle();
    expect(relay.indexOf('setEnabled(next);')).toBeLessThan(
      relay.indexOf('await saveConfigOverride(')
    );
    const openflux = openfluxToggle();
    expect(openflux.indexOf('setEnabled(on);')).toBeLessThan(
      openflux.indexOf('const cfg = await persist(on);')
    );
  });
});
