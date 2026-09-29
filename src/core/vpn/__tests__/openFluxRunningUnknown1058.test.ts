/**
 * ДЕФЕКТ (v4.32.1058). Живое ядро OpenFlux показывалось как «Выключен», а
 * мост внешнего агента отдавал про него `state: 'off'`.
 *
 * `getOpenFluxRunning` перехватывала отказ ядра и возвращала `false` — тот же
 * ответ, что и у честно погашенного туннеля. Раздел настроек оставлял `status`
 * в `off`: серая лампочка, слово «Выключен». `catch` вокруг чтения не
 * срабатывал никогда: обёртка гасила отказ внутри себя, и следа в журнале не
 * оставалось.
 *
 * ЦЕНА. Туннель поднимают в той сети, где приложение иначе молчит, и надпись
 * — единственное, по чему человек решает, чинить сеть, ждать или бросить.
 * Хуже с мостом: по ту сторону не человек, а программа, и `off` она принимает
 * за факт — уводит трафик напрямую или поднимает канал заново поверх живого.
 * Третий читатель — сторож смены сети: у туннеля с ручным запуском он по
 * `false` решал «не стоял» и после переключения Wi-Fi/мобильной сети не
 * трогал ничего.
 *
 * ПРАВКА. Третий ответ `null` — «спросить не удалось». Экран пишет «Состояние
 * не удалось прочитать» и зажигает жёлтую лампочку вместо серой; мост отдаёт
 * `state: 'unknown'`; сторож пишет в журнал, что решение принято вслепую.
 * В `cmdOpenFluxEnable` непрочитанное считается за «стоял»: `retryOpenFlux`
 * гасит туннель перед попыткой, и иначе главный канал остался бы в мёртвом
 * SOCKS5.
 *
 * ГРАНИЦЫ. Тихий `false` остаётся там, где ядра нет по сборке или платформе:
 * это не отказ, а отсутствие туннеля. `OpenFluxUiStatus` не трогали — это тип
 * исхода нажатия, а не чтения. Сторож на непрочитанном по-прежнему ничего не
 * поднимает: решение человека «поднимаю руками» сильнее нашей догадки, — но
 * теперь это записанное решение, а не молчаливое совпадение с «не стоял».
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const mockWarn = jest.fn();
// Заглушка зовётся через стрелку, а не передаётся ссылкой: `jest.mock`
// поднимается выше объявления, и к моменту загрузки модуля `mockWarn` ещё
// `undefined` — журнал падал бы на первом же `log.warn`.
jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('airchat-openflux', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    isRunning: jest.fn(),
    socksAddr: jest.fn(),
  },
}));

import fs from 'fs';
import path from 'path';

import AirChatOpenFlux from 'airchat-openflux';
import { getOpenFluxRunning } from '../openFluxController';

const native = AirChatOpenFlux as unknown as { isRunning: jest.Mock };

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const bodyAt = (s: string, needle: string, len: number): string => {
  const at = s.indexOf(needle);
  expect(at).toBeGreaterThan(0);
  return s.slice(at, at + len);
};

beforeEach(() => {
  native.isRunning.mockReset();
  mockWarn.mockClear();
});

describe('«не знаем» не выдаётся за «выключено»', () => {
  it('отказ ядра — это null, а не false', async () => {
    native.isRunning.mockRejectedValue(new Error('openflux core: not responding'));
    await expect(getOpenFluxRunning()).resolves.toBeNull();
    // ПРОВЕРКА НЕ ПУСТАЯ: до ядра дошли, отказ пришёл именно от него.
    expect(native.isRunning).toHaveBeenCalledTimes(1);
  });

  it('отказ виден в журнале — раньше не оставалось даже следа', async () => {
    native.isRunning.mockRejectedValue(new Error('openflux core: not responding'));
    await getOpenFluxRunning();
    expect(mockWarn).toHaveBeenCalledWith('openflux_running_unknown', expect.anything());
  });

  it('три исхода — три разных ответа', async () => {
    native.isRunning.mockResolvedValueOnce(true);
    const up = await getOpenFluxRunning();
    native.isRunning.mockResolvedValueOnce(false);
    const down = await getOpenFluxRunning();
    native.isRunning.mockRejectedValueOnce(new Error('нет ответа'));
    const unknown = await getOpenFluxRunning();
    expect([up, down, unknown]).toEqual([true, false, null]);
  });

  it('ГРАНИЦА: поднятое и погашенное ядро называются по-прежнему', async () => {
    native.isRunning.mockResolvedValue(true);
    await expect(getOpenFluxRunning()).resolves.toBe(true);
    native.isRunning.mockResolvedValue(false);
    await expect(getOpenFluxRunning()).resolves.toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('что видит человек', () => {
  const SEC = codeOnly(read('ui', 'components', 'OpenFluxSettingsSection.tsx'));

  it('экран отличает null от погашенного ядра', () => {
    const body = bodyAt(SEC, 'const live = await getOpenFluxRunning();', 260);
    expect(body).toContain('setStatusUnknown(live === null);');
    expect(body).toContain('if (live === true) {');
  });

  it('мёртвый catch вокруг чтения убран', () => {
    expect(SEC).not.toContain('/* статус останется off */');
    expect(SEC).not.toContain('if (await getOpenFluxRunning())');
  });

  it('непрочитанное состояние названо своим словом, а не «Выключен»', () => {
    expect(SEC).toContain(
      "const statusText = statusUnknown ? 'Состояние не удалось прочитать' : STATUS_LABEL[status];",
    );
    expect(SEC).toContain('{statusText}</Text>');
    expect(SEC).not.toContain('{STATUS_LABEL[status]}</Text>');
  });

  it('лампочка на незнании жёлтая, а не серая', () => {
    const body = bodyAt(SEC, 'const tone = statusUnknown', 120);
    expect(body).toContain('{ text: styles.warnColor, dot: styles.dotWarn }');
  });

  it('узнали — отметку снимаем: и на переключателе, и на «Повторить»', () => {
    expect(SEC.match(/setStatusUnknown\(false\);/g)?.length).toBe(2);
  });
});

describe('что видит внешний агент', () => {
  const BR = codeOnly(read('core', 'bridge', 'agentBridgeCommands.ts'));

  it('«не ответило» — своё значение, а не off', () => {
    expect(BR).toContain(
      "export type BridgeOpenFluxState = Exclude<OpenFluxUiStatus, 'starting'> | 'unknown';",
    );
    const body = bodyAt(BR, 'const running = await getOpenFluxRunning();', 260);
    const unknownAt = body.indexOf("if (running === null) return { state: 'unknown', socks: null };");
    const offAt = body.indexOf("if (!running) return { state: 'off', socks: null };");
    expect(unknownAt).toBeGreaterThan(-1);
    // Порядок важен: `!null` истинно, и после `off` ветка про `unknown` была бы
    // недостижима.
    expect(offAt).toBeGreaterThan(unknownAt);
  });

  it('непрочитанное перед включением считается за «стоял»', () => {
    expect(BR).toContain('const wasRunning = (await getOpenFluxRunning()) !== false;');
  });

  it('текст отказа разбирает и это значение, а не падает в «попыток N»', () => {
    const body = bodyAt(BR, 'function openFluxEnableFailure(', 800);
    expect(body).toContain("if (status === 'unknown') return");
    expect(body).toContain('попыток: ${tries}');
  });
});

describe('что делает сторож смены сети', () => {
  const GUARD = codeOnly(read('core', 'vpn', 'openFluxNetworkGuard.ts'));

  it('решение вслепую теперь записано, а не молчит', () => {
    const body = bodyAt(GUARD, "if (!cfg.openflux?.autoStart) {", 320);
    expect(body).toContain('const up = await getOpenFluxRunning();');
    expect(body).toContain("log.warn('openflux_net_change_state_unknown');");
    expect(body).toContain('if (!up) return');
  });

  it('ГРАНИЦА: ручной туннель по-прежнему не поднимается сам', () => {
    const from = GUARD.indexOf('if (!cfg.openflux?.autoStart) {');
    const to = GUARD.indexOf('const status = await retryOpenFlux(cfg);', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const block = GUARD.slice(from, to);
    // Ни одна из веток этого блока ничего не поднимает — обе выходят.
    expect(block.match(/return 'skipped';/g)?.length).toBe(2);
    expect(block).not.toContain('retryOpenFlux');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: серая лампочка подписана словом «Выключен»', () => {
    expect(codeOnly(read('ui', 'components', 'OpenFluxSettingsSection.tsx'))).toContain(
      "off: 'Выключен',",
    );
  });

  it('ЗАКРЕПКА: тип исхода нажатия неизвестного значения не завёл', () => {
    const CTRL = read('core', 'vpn', 'openFluxController.ts');
    const from = CTRL.indexOf('export type OpenFluxUiStatus =');
    expect(from).toBeGreaterThan(0);
    // Конец объявления ищем по пустой строке, а не по первой `;`: точка с
    // запятой есть и внутри пояснения к `unsupported`.
    const decl = CTRL.slice(from, CTRL.indexOf('\n\n', from));
    const members = [...decl.matchAll(/\| '(\w+)'/g)].map((m) => m[1]);
    expect(members).toEqual(['off', 'starting', 'on', 'unsupported', 'unconfigured', 'failed']);
  });

  it('ЗАКРЕПКА: соседи по файлу три ответа умели и раньше', () => {
    const CTRL = codeOnly(read('core', 'vpn', 'openFluxController.ts'));
    expect(CTRL).toContain('export function getOpenFluxHttpLayerActive(): boolean | null {');
    expect(CTRL).toContain('export async function stopOpenFlux(): Promise<boolean> {');
  });

  it('ЗАКРЕПКА: читателей состояния ровно трое, и все разобраны выше', () => {
    const hits: string[] = [];
    for (const f of [
      ['ui', 'components', 'OpenFluxSettingsSection.tsx'],
      ['core', 'bridge', 'agentBridgeCommands.ts'],
      ['core', 'vpn', 'openFluxNetworkGuard.ts'],
      ['core', 'vpn', 'ipfsFetch.ts'],
      ['App.tsx'],
    ]) {
      if (read(...f).includes('getOpenFluxRunning')) hits.push(f[f.length - 1]);
    }
    expect(hits).toEqual([
      'OpenFluxSettingsSection.tsx',
      'agentBridgeCommands.ts',
      'openFluxNetworkGuard.ts',
    ]);
  });
});
