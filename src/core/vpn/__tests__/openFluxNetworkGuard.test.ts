/**
 * Туннель OpenFlux при смене сети на телефоне (v4.32.723).
 *
 * Здесь проверяется не факт вызова, а ПОРЯДОК и ГРАНИЦЫ.
 *
 * Порядок — потому что он единственно возможный. Подмена маршрута действует
 * только на новые соединения, а локальный SOCKS5 ядра живёт на эфемерном
 * порту: если переоткрыть интернет-транспорт раньше, чем поднято ядро, он
 * откроет сокеты в порт, которого уже нет, и смена сети закончится тем же
 * молчанием, ради которого всё и затевалось.
 *
 * Границы — потому что автоматика тут сильнее пользователя и обязана уступать.
 * Выключенный человеком туннель не поднимается ни при какой смене сети, а
 * неудача ядра не должна оставлять телефон совсем без связи: лучше без
 * туннеля, чем без переписки.
 *
 * Контроллер и нативный модуль намеренно НЕ заглушены целиком: заглушка
 * `retryOpenFlux` доказывала бы только то, что её позвали, а проверять надо
 * именно цепочку «опустить → поднять → взять новый адрес → переоткрыть
 * транспорт». Подменена только её нижняя ступень — нативная часть.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Последовательность шагов, по которой и видно порядок. Имя на `mock` —
// требование babel: фабрики `jest.mock` поднимаются выше объявлений.
const mockSteps: string[] = [];

jest.mock('airchat-openflux', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(async () => true),
    start: jest.fn(),
    stop: jest.fn(),
    isRunning: jest.fn(),
    socksAddr: jest.fn(),
  },
}));

jest.mock('../../config', () => ({ loadConfig: jest.fn() }));
jest.mock('../../transport/internet/restartInternetTransport', () => ({
  restartInternetTransport: jest.fn(async () => {
    mockSteps.push('restartTransport');
  }),
}));
jest.mock('../../transport/networkReconnectWatcher', () => ({
  addNetworkPathListener: jest.fn(() => jest.fn()),
}));

import { Platform } from 'react-native';
import AirChatOpenFlux from 'airchat-openflux';
import { loadConfig, type AppConfig } from '../../config';
import { restartInternetTransport } from '../../transport/internet/restartInternetTransport';
import { addNetworkPathListener } from '../../transport/networkReconnectWatcher';
import {
  addOpenFluxReviveListener,
  reviveOpenFluxAfterNetworkChange,
  startOpenFluxNetworkGuard,
  stopOpenFluxNetworkGuard,
  type OpenFluxRevived,
} from '../openFluxNetworkGuard';

const native = AirChatOpenFlux as unknown as {
  isSupported: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
  isRunning: jest.Mock;
  socksAddr: jest.Mock;
};
const mockLoadConfig = loadConfig as jest.Mock;
const mockRestart = restartInternetTransport as jest.Mock;
const mockAddPathListener = addNetworkPathListener as jest.Mock;

type OpenFlux = NonNullable<AppConfig['openflux']>;

function cfg(over: Partial<OpenFlux> = {}): AppConfig {
  return {
    openflux: {
      enabled: true,
      autoStart: true,
      transport: 'yandex',
      docUrl: 'https://disk.yandex.example/i/whatever',
      localSocksPort: 0,
      dns: '1.1.1.1:53',
      startRetries: 2,
      retryDelayMs: 0,
      ...over,
    },
  } as unknown as AppConfig;
}

/** Порт до переключения и после: ядро каждый раз берёт свободный. */
const OLD_ADDR = '127.0.0.1:41080';
const NEW_ADDR = '127.0.0.1:52341';

beforeEach(() => {
  jest.clearAllMocks();
  mockSteps.length = 0;
  (Platform as { OS: string }).OS = 'android';
  mockLoadConfig.mockResolvedValue(cfg());
  // clearAllMocks стирает вызовы, но не подмены поведения: без явного возврата
  // к исходному поведение, заданное одним тестом, дотекало бы до следующих.
  mockRestart.mockImplementation(async () => {
    mockSteps.push('restartTransport');
  });
  mockAddPathListener.mockImplementation(() => jest.fn());
  native.isSupported.mockResolvedValue(true);
  native.isRunning.mockResolvedValue(true);
  native.stop.mockImplementation(async () => {
    mockSteps.push('stopCore');
  });
  native.start.mockImplementation(async () => {
    mockSteps.push('startCore');
    return NEW_ADDR;
  });
  native.socksAddr.mockImplementation(async () => {
    mockSteps.push('readSocksAddr');
    return NEW_ADDR;
  });
});

afterEach(() => {
  stopOpenFluxNetworkGuard();
});

describe('смена сети при включённом туннеле', () => {
  it('поднимает ядро заново и только потом переоткрывает транспорт', async () => {
    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('revived');

    expect(mockSteps).toEqual(['stopCore', 'startCore', 'readSocksAddr', 'restartTransport']);
  });

  it('переоткрывает транспорт тем же конфигом, который читал сам', async () => {
    const c = cfg();
    mockLoadConfig.mockResolvedValue(c);

    await reviveOpenFluxAfterNetworkChange();

    expect(mockRestart).toHaveBeenCalledWith(c);
  });

  it('отдаёт подписчикам НОВЫЙ адрес SOCKS5, а не запомненный старый', async () => {
    const seen: OpenFluxRevived[] = [];
    const off = addOpenFluxReviveListener((r) => seen.push(r));
    native.socksAddr.mockResolvedValue(NEW_ADDR);

    await reviveOpenFluxAfterNetworkChange();
    off();

    expect(seen).toEqual([{ status: 'on', socks: NEW_ADDR }]);
    expect(seen[0].socks).not.toBe(OLD_ADDR);
  });
});

describe('границы: чего автоматика делать не должна', () => {
  it('не поднимает туннель, выключенный человеком', async () => {
    mockLoadConfig.mockResolvedValue(cfg({ enabled: false }));

    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('skipped');

    expect(mockSteps).toEqual([]);
    expect(native.start).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it('не поднимает туннель в сборке без ссылки на документ', async () => {
    mockLoadConfig.mockResolvedValue(cfg({ docUrl: '' }));

    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('skipped');

    expect(mockSteps).toEqual([]);
  });

  it('туннель, который поднимают руками, восстанавливает только если он стоял', async () => {
    mockLoadConfig.mockResolvedValue(cfg({ autoStart: false }));
    native.isRunning.mockResolvedValue(false);

    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('skipped');
    expect(native.start).not.toHaveBeenCalled();

    // А вот поднятый руками туннель после переключения сети обязан вернуться:
    // человек его включил и с тех пор ничего не отменял.
    native.isRunning.mockResolvedValue(true);
    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('revived');
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it('на платформе без ядра не трогает ни туннель, ни транспорт', async () => {
    (Platform as { OS: string }).OS = 'ios';

    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('skipped');

    expect(native.start).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
  });
});

describe('ядро не поднялось', () => {
  it('всё равно переоткрывает транспорт: лучше без туннеля, чем без связи', async () => {
    native.start.mockImplementation(async () => {
      mockSteps.push('startCore');
      throw new Error('документ недоступен');
    });

    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('degraded');

    // Ядро опущено (трафик идёт напрямую), транспорт переоткрыт последним.
    expect(mockSteps[0]).toBe('stopCore');
    expect(mockSteps[mockSteps.length - 1]).toBe('restartTransport');
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it('сообщает экрану, что канала нет, а не оставляет его с надписью «Работает»', async () => {
    native.start.mockRejectedValue(new Error('документ недоступен'));
    const seen: OpenFluxRevived[] = [];
    const off = addOpenFluxReviveListener((r) => seen.push(r));

    await reviveOpenFluxAfterNetworkChange();
    off();

    expect(seen).toEqual([{ status: 'failed', socks: null }]);
  });

  it('падение перезапуска транспорта не роняет заход', async () => {
    mockRestart.mockRejectedValue(new Error('транспорт не поднялся'));

    await expect(reviveOpenFluxAfterNetworkChange()).resolves.toBe('revived');
  });
});

describe('пачка событий', () => {
  it('на пять событий подряд поднимает ядро дважды, а не пять раз', async () => {
    // Первый заход уже идёт, когда приходят остальные четыре. Догоняющий круг
    // нужен ровно один: он и накроет ту сеть, на которой всё остановилось.
    const all = Promise.all([
      reviveOpenFluxAfterNetworkChange(),
      reviveOpenFluxAfterNetworkChange(),
      reviveOpenFluxAfterNetworkChange(),
      reviveOpenFluxAfterNetworkChange(),
      reviveOpenFluxAfterNetworkChange(),
    ]);

    const results = await all;

    expect(results[0]).toBe('revived');
    expect(results.slice(1)).toEqual(['busy', 'busy', 'busy', 'busy']);
    expect(native.start).toHaveBeenCalledTimes(2);
    expect(mockRestart).toHaveBeenCalledTimes(2);
  });

  it('после того как сеть успокоилась, следующая смена снова поднимает ядро', async () => {
    await reviveOpenFluxAfterNetworkChange();
    await reviveOpenFluxAfterNetworkChange();

    expect(native.start).toHaveBeenCalledTimes(2);
  });
});

describe('подписка на смену сети', () => {
  it('вешается один раз, сколько ни запускай', () => {
    startOpenFluxNetworkGuard();
    startOpenFluxNetworkGuard();

    expect(mockAddPathListener).toHaveBeenCalledTimes(1);
  });

  it('снимается при остановке', () => {
    const off = jest.fn();
    mockAddPathListener.mockReturnValue(off);

    startOpenFluxNetworkGuard();
    stopOpenFluxNetworkGuard();

    expect(off).toHaveBeenCalledTimes(1);
  });

  it('событие смены сети доводит дело до перезапуска транспорта', async () => {
    let fire: (() => void) | null = null;
    mockAddPathListener.mockImplementation((fn: (c: unknown) => void) => {
      fire = () => fn({ reason: 'type', from: 'WIFI', to: 'CELLULAR' });
      return jest.fn();
    });

    startOpenFluxNetworkGuard();
    (fire as unknown as () => void)();
    // Обработчик не ждёт результата — даём заходу доработать.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    expect(mockSteps).toEqual(['stopCore', 'startCore', 'readSocksAddr', 'restartTransport']);
  });
});
