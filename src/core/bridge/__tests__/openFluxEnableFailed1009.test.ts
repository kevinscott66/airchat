/**
 * «Включил туннель» в ответ на неподнявшийся туннель (v4.32.1009).
 *
 * Дефект. `openflux.enable` отвечал `ok: true` с `state: 'failed'` и
 * `socks: null`. Тот же самый ответ — «команда выполнена» — приходил и когда
 * туннель поднялся. Мост при этом отказывает на «нет ядра» и «нет ссылки»
 * ровно потому, что агент по `ok` докладывает о сделанном; третья причина не
 * поднять туннель — ядро не отозвалось — оставалась согласием с примечанием.
 *
 * Цена. Агент докладывает «включил», человек считает, что трафик идёт
 * туннелем, и узнаёт правду по тому, что не изменилось ничего. Хуже другое:
 * `retryOpenFlux` гасит туннель перед первой же попыткой. Значит, у команды
 * есть исход «до неё туннель был, после неё его нет» — а перезапуск главного
 * канала стоял под `status === 'on'`, и веб-сокет оставался в уже погашенном
 * SOCKS5. Ровно то, ради чего перезапуск делают при выключении.
 *
 * Правка. Не поднялся — отказ, с кодом по состоянию (`failed`, `off`,
 * `unconfigured`, `unsupported`). Отказной ответ моста не носит `result`,
 * поэтому оба факта названы словами: решение записано, туннеля нет. Главный
 * канал переподнимают и тогда, когда попытка уронила работавший туннель.
 *
 * Границы. `openflux.status` — вопрос, а не команда: «выключен» для него
 * законный ответ, и он остаётся `ok: true`.
 */
let mockOpenFluxAvailable = true;
jest.mock('../../../ui/platformCapabilities', () => ({
  get OPENFLUX_AVAILABLE() {
    return mockOpenFluxAvailable;
  },
}));

let mockRunning = false;
const mockRetry = jest.fn(async (_cfg: unknown) => 'on');
const mockStop = jest.fn(async () => true);
jest.mock('../../vpn/openFluxController', () => ({
  getOpenFluxRunning: jest.fn(async () => mockRunning),
  getOpenFluxSocksAddr: jest.fn(async () => (mockRunning ? '127.0.0.1:10808' : null)),
  retryOpenFlux: (c: unknown) => mockRetry(c),
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

/** Туннель включается: договорились, что ссылка на документ в сборке есть. */
beforeEach(() => {
  mockOpenFluxAvailable = true;
  mockRunning = false;
  mockConfig = { openflux: { enabled: false, docUrl: 'https://example.invalid/doc' } };
  mockRetry.mockClear();
  mockStop.mockClear();
  mockRestart.mockClear();
});

describe('не поднялся — так и сказано', () => {
  it('ядро не отозвалось: отказ, а не «включено»', async () => {
    mockRetry.mockImplementationOnce(async () => 'failed');
    const res = (await runBridgeCommand({ cmd: 'openflux.enable' })) as Refusal;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('failed');
  });

  it('в отказе названы обе половины: решение записано, туннеля нет', async () => {
    mockRetry.mockImplementationOnce(async () => 'failed');
    const res = (await runBridgeCommand({ cmd: 'openflux.enable' })) as Refusal;

    expect(res.message).toContain('В настройках туннель включён');
    expect(res.message).toContain('напрямую');
    // Запись решения — не на словах: повтор это именно повтор попытки.
    expect((mockConfig.openflux as { enabled: boolean }).enabled).toBe(true);
  });

  it('попыток названо столько, сколько их было', async () => {
    mockConfig = { openflux: { enabled: false, docUrl: 'https://example.invalid/doc', startRetries: 5 } };
    mockRetry.mockImplementationOnce(async () => 'failed');
    const res = (await runBridgeCommand({ cmd: 'openflux.enable' })) as Refusal;

    expect(res.message).toContain('попыток: 5');
  });

  it('решение не записалось — отказ с другим кодом: поднимать никто не пробовал', async () => {
    mockRetry.mockImplementationOnce(async () => 'off');
    const res = (await runBridgeCommand({ cmd: 'openflux.enable' })) as Refusal;

    expect(res.error).toBe('off');
    expect(res.message).toContain('не записалось');
  });

  it('попытка уронила работавший туннель — главный канал переподняли', async () => {
    // retryOpenFlux гасит туннель перед первой попыткой; если поднять обратно
    // не вышло, веб-сокет остался бы в погашенном SOCKS5.
    mockRunning = true;
    mockRetry.mockImplementationOnce(async () => {
      mockRunning = false;
      return 'failed';
    });
    const res = await runBridgeCommand({ cmd: 'openflux.enable' });

    expect(res.ok).toBe(false);
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: успех остался успехом', () => {
  it('туннель поднялся — `ok`, состояние и адрес SOCKS5 на месте', async () => {
    mockRetry.mockImplementationOnce(async () => {
      mockRunning = true;
      return 'on';
    });
    const res = await runBridgeCommand({ cmd: 'openflux.enable' });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toEqual({ state: 'on', socks: '127.0.0.1:10808' });
    }
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it('туннель и не был поднят, и не понадобился: лишнего перезапуска нет', async () => {
    mockRetry.mockImplementationOnce(async () => 'failed');
    await runBridgeCommand({ cmd: 'openflux.enable' });

    expect(mockRestart).not.toHaveBeenCalled();
  });

  it('выключение по-прежнему успех', async () => {
    const res = await runBridgeCommand({ cmd: 'openflux.disable' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ state: 'off', socks: null });
  });

  it('на платформе без ядра отказ прежний и попытки не было', async () => {
    mockOpenFluxAvailable = false;
    const res = (await runBridgeCommand({ cmd: 'openflux.enable' })) as Refusal;

    expect(res.error).toBe('unsupported');
    expect(mockRetry).not.toHaveBeenCalled();
  });
});

describe('ГРАНИЦА: вопрос — не команда', () => {
  it('`openflux.status` на выключенный туннель отвечает `ok`, а не отказом', async () => {
    const res = await runBridgeCommand({ cmd: 'openflux.status' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ state: 'off', socks: null });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

  it('`failed` по-прежнему означает «пробовали — не вышло», а не «выключено»', () => {
    const ctl = src('vpn', 'openFluxController.ts');
    expect(ctl).toContain("| 'failed'");
    expect(ctl).toContain('/** Пробовали поднять — не вышло. */');
  });

  it('отказ моста по-прежнему не носит `result`: причину можно назвать только словами', () => {
    const bridge = src('bridge', 'agentBridgeCommands.ts');
    expect(bridge).toContain('| { ok: false; cmd: string; error: string; message: string };');
  });
});
