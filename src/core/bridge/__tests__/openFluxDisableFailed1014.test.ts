/**
 * «Выключил туннель» в ответ на непогасшее ядро (v4.32.1014).
 *
 * Дефект. Зеркало v4.32.1009. `stopOpenFlux` глотал отказ ядра: он уходил в
 * `log.warn`, наружу возвращалось одно и то же `undefined`. Оба вызывающих —
 * мост внешнего агента и переключатель в настройках — объявляли туннель
 * выключенным, не спросив, выключился ли он: мост отвечал `ok: true` с
 * `state: 'off'`, экран рисовал серое «Выключен».
 *
 * Цена. Туннель выключают затем, чтобы выйти в сеть напрямую: домашний
 * принтер, местный сайт, сервис, который узел на выходе не пускает. Человеку
 * сказали «выключено», а трафик идёт по-прежнему через ядро, и почему ничего
 * не заработало — непонятно ровно потому, что настройки не врут только на
 * первый взгляд.
 *
 * Правка. `stopOpenFlux` отвечает, погасло или нет. Отказ на `stop()` сам по
 * себе ещё не неудача: «ядра уже нет» прилетает таким же отказом, поэтому
 * после него ядро спрашивают напрямую. Не погасло — мост отказывает и
 * называет обе половины словами, экран показывает «Включён» и говорит, что
 * помогает перезапуск.
 *
 * Границы. Решение всё равно записывается: при следующем запуске туннель
 * подниматься не должен, даже если сейчас погасить его не вышло. Главный
 * канал переподнимают в обоих исходах — иначе он остался бы в SOCKS5, про
 * который уже неизвестно, жив ли он.
 */
let mockOpenFluxAvailable = true;
jest.mock('../../../ui/platformCapabilities', () => ({
  get OPENFLUX_AVAILABLE() {
    return mockOpenFluxAvailable;
  },
}));

let mockRunning = false;
let mockStopped = true;
const mockStop = jest.fn(async () => mockStopped);
jest.mock('../../vpn/openFluxController', () => ({
  getOpenFluxRunning: jest.fn(async () => mockRunning),
  getOpenFluxSocksAddr: jest.fn(async () => (mockRunning ? '127.0.0.1:10808' : null)),
  retryOpenFlux: jest.fn(async () => 'on'),
  stopOpenFlux: () => mockStop(),
}));

let mockConfig: Record<string, unknown> = {};
jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => mockConfig),
  saveConfigOverride: jest.fn(async (patch: Record<string, unknown>) => {
    mockConfig = { ...mockConfig, ...patch };
    return mockConfig;
  }),
}));

const mockRestart = jest.fn(async () => {});
jest.mock('../../transport/internet/restartInternetTransport', () => ({
  restartInternetTransport: () => mockRestart(),
}));

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async () => null),
  kvSet: jest.fn(async () => undefined),
  kvSetChecked: jest.fn(async () => true),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { runBridgeCommand } from '../agentBridgeCommands';

type Refusal = { ok: false; cmd: string; error: string; message: string };

const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeEach(() => {
  mockOpenFluxAvailable = true;
  mockRunning = true;
  mockStopped = true;
  mockConfig = { openflux: { enabled: true, docUrl: 'https://example.invalid/doc' } };
  mockStop.mockClear();
  mockRestart.mockClear();
});

describe('не погасло — так и сказано', () => {
  beforeEach(() => {
    mockStopped = false;
  });

  it('ядро не погасло: отказ, а не «выключено»', async () => {
    const res = (await runBridgeCommand({ cmd: 'openflux.disable' })) as Refusal;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('on');
  });

  it('в отказе названы обе половины: решение записано, трафик идёт через туннель', async () => {
    const res = (await runBridgeCommand({ cmd: 'openflux.disable' })) as Refusal;

    expect(res.message).toContain('не погасло');
    expect(res.message).toContain('В настройках туннель выключен');
    expect(res.message).toContain('по-прежнему идёт через него');
  });

  it('решение записано на деле, а не на словах', async () => {
    // Держалось и до правки: это граница, а не ратчет. Отказ не должен был
    // превратиться в «ничего не сделали».
    await runBridgeCommand({ cmd: 'openflux.disable' });

    expect((mockConfig.openflux as { enabled: boolean }).enabled).toBe(false);
  });

  it('главный канал переподняли и здесь: SOCKS5 мог уже не отвечать', async () => {
    // Тоже держалось до правки — и обязано было удержаться после неё.
    await runBridgeCommand({ cmd: 'openflux.disable' });

    expect(mockRestart).toHaveBeenCalledTimes(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычное выключение', () => {
  it('ядро погасло — `ok`, состояние и адрес прежние', async () => {
    const res = await runBridgeCommand({ cmd: 'openflux.disable' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ state: 'off', socks: null });
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it('гасить пробовали ровно один раз', async () => {
    await runBridgeCommand({ cmd: 'openflux.disable' });

    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('на платформе без ядра отказ прежний и гасить не пробовали', async () => {
    mockOpenFluxAvailable = false;
    const res = (await runBridgeCommand({ cmd: 'openflux.disable' })) as Refusal;

    expect(res.error).toBe('unsupported');
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe('ГРАНИЦА', () => {
  it('вопрос остаётся вопросом: `openflux.status` на поднятый туннель — `ok`', async () => {
    const res = await runBridgeCommand({ cmd: 'openflux.status' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ state: 'on', socks: '127.0.0.1:10808' });
  });
});

describe('экран настроек не рисует «Выключен» без подтверждения', () => {
  const ui = () => codeOnly(readFileSync(join(__dirname, '..', '..', '..', 'ui', 'components', 'OpenFluxSettingsSection.tsx'), 'utf8'));

  it('ответ остановки читают и на нём ветвятся', () => {
    const body = ui();
    expect(body).toContain('const stopped = await stopOpenFlux();');
    expect(body).toContain('if (!stopped) {');
  });

  it('не погасло — надпись «Включён», а не «Выключен»', () => {
    const body = ui();
    const at = body.indexOf('if (!stopped) {');
    expect(at).toBeGreaterThan(-1);
    const branch = body.slice(at, body.indexOf('return;', at));
    expect(branch).toContain("setStatus('on');");
    expect(branch).not.toContain("setStatus('off');");
    expect(branch).toContain('showError(');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('«Выключен» по-прежнему рисуется серым и без оговорок', () => {
    // Надпись ничем не выдаёт сомнения — значит, сомнение обязано мешать ей
    // появиться, а не сопровождать её.
    const body = src('..', 'ui', 'components', 'OpenFluxSettingsSection.tsx');
    expect(body).toContain("off: 'Выключен',");
    expect(body).toContain('{ text: styles.offColor, dot: styles.dotOff }');
  });

  it('отказ моста по-прежнему не носит `result`: причину можно назвать только словами', () => {
    expect(src('bridge', 'agentBridgeCommands.ts')).toContain(
      '| { ok: false; cmd: string; error: string; message: string };',
    );
  });

  it('второго способа узнать о непогасшем ядре у человека нет', () => {
    // Счётчик соединений и адрес SOCKS5 лежат за режимом разработчика —
    // семь нажатий на номер версии.
    const body = src('..', 'ui', 'components', 'OpenFluxSettingsSection.tsx');
    expect(body).toContain('devMode && socks && status === ');
  });
});
