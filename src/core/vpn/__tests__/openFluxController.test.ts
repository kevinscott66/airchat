/**
 * Туннель OpenFlux: что именно он отвечает и когда (v4.32.724).
 *
 * Проверяется здесь не «функция вернула строку», а различимость состояний.
 * Туннель включают в той сети, где приложение уже молчит, и человек видит
 * ровно одну надпись — по ней он решает, чинить сеть, ждать или бросить.
 * Поэтому «в сборке нет ссылки», «на этой платформе нечем», «пробовали и не
 * вышло» и «выключено» обязаны оставаться четырьмя разными ответами: слить
 * их в одно `failed` — отправить человека искать поломку там, где её нет.
 *
 * Отдельно проверяется, что выключенный туннель не поднимается ничем, включая
 * `force`. Кнопка «Повторить» обходит только автозапуск; если бы она обходила
 * и выключатель, слово «выключить» в настройках перестало бы что-то значить.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Заглушки создаются внутри фабрики, а не снаружи: babel поднимает `jest.mock`
// выше объявлений модуля, и внешняя константа на момент вызова фабрики ещё не
// существует — подменой стал бы `undefined`, а контроллер молча отвечал бы
// «нет нативной части» на каждый тест.
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

import { Platform } from 'react-native';
import AirChatOpenFlux from 'airchat-openflux';
import type { AppConfig } from '../../config';
import {
  enableOpenFluxTunnelStats,
  getOpenFluxTunnelStats,
  maybeStartOpenFlux,
  openFluxConfigured,
  retryOpenFlux,
  stopOpenFlux,
} from '../openFluxController';

const mockNative = AirChatOpenFlux as unknown as {
  isSupported: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
  isRunning: jest.Mock;
  socksAddr: jest.Mock;
  // Счётчик соединений есть не везде — заглушка повторяет Android, где его нет.
  enableTunnelStats?: jest.Mock;
  tunnelStats?: jest.Mock;
};

type OpenFlux = NonNullable<AppConfig['openflux']>;

const DOC = 'https://disk.yandex.example/i/whatever';

function cfg(over: Partial<OpenFlux> = {}): AppConfig {
  return {
    openflux: {
      enabled: true,
      autoStart: true,
      transport: 'yandex',
      docUrl: DOC,
      localSocksPort: 0,
      dns: '1.1.1.1:53',
      startRetries: 3,
      retryDelayMs: 0,
      ...over,
    },
  } as unknown as AppConfig;
}

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as { OS: string }).OS = 'android';
  mockNative.isSupported.mockResolvedValue(true);
  mockNative.start.mockResolvedValue('127.0.0.1:41080');
  mockNative.stop.mockResolvedValue(undefined);
  mockNative.isRunning.mockResolvedValue(false);
  mockNative.socksAddr.mockResolvedValue('127.0.0.1:41080');
});

describe('openFluxConfigured', () => {
  it('считает туннель настроенным только при включении и непустой ссылке', () => {
    expect(openFluxConfigured(cfg())).toBe(true);
    expect(openFluxConfigured(cfg({ enabled: false }))).toBe(false);
    expect(openFluxConfigured(cfg({ docUrl: '' }))).toBe(false);
    // Пробелы вместо ссылки — та же пустота, но незаметная глазом.
    expect(openFluxConfigured(cfg({ docUrl: '   ' }))).toBe(false);
  });
});

describe('maybeStartOpenFlux', () => {
  it('поднимает канал и передаёт ядру адрес документа и локальный SOCKS', async () => {
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('on');
    expect(mockNative.start).toHaveBeenCalledWith({
      transport: 'yandex',
      docUrl: DOC,
      socksAddr: '127.0.0.1:0',
      dns: '1.1.1.1:53',
    });
  });

  it('просит ядро слушать заданный порт, когда он указан', async () => {
    await maybeStartOpenFlux(cfg({ localSocksPort: 41080 }));
    expect(mockNative.start).toHaveBeenCalledWith(
      expect.objectContaining({ socksAddr: '127.0.0.1:41080' }),
    );
  });

  it('не трогает ядро, пока туннель выключен, — даже по кнопке', async () => {
    await expect(maybeStartOpenFlux(cfg({ enabled: false }))).resolves.toBe('off');
    await expect(maybeStartOpenFlux(cfg({ enabled: false }), { force: true })).resolves.toBe('off');
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  it('без автозапуска молчит при старте приложения, но подчиняется кнопке', async () => {
    await expect(maybeStartOpenFlux(cfg({ autoStart: false }))).resolves.toBe('off');
    expect(mockNative.start).not.toHaveBeenCalled();
    await expect(maybeStartOpenFlux(cfg({ autoStart: false }), { force: true })).resolves.toBe(
      'on',
    );
  });

  it('сборку без ссылки называет ненастроенной, а не сломанной', async () => {
    await expect(maybeStartOpenFlux(cfg({ docUrl: '' }))).resolves.toBe('unconfigured');
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  it('на web отвечает «недоступно», даже не спрашивая нативную часть', async () => {
    (Platform as { OS: string }).OS = 'web';
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('unsupported');
    expect(mockNative.isSupported).not.toHaveBeenCalled();
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  it('на iOS не отказывает заранее, а спрашивает нативную часть', async () => {
    // Раньше iOS стоял рядом с web в списке «ядра нет». Теперь ядро есть, но
    // его наличие из JS не выводится: xcframework лежит вне git и попадает не
    // в каждую сборку, а перехват требует iOS 17. Отказ по имени платформы
    // здесь означал бы «недоступно» на устройстве, где туннель работает.
    (Platform as { OS: string }).OS = 'ios';
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('on');

    mockNative.isSupported.mockResolvedValueOnce(false);
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('unsupported');
    expect(mockNative.start).toHaveBeenCalledTimes(1);
  });

  it('отказ ядра — это failed: тут чинить сеть или документ', async () => {
    mockNative.start.mockRejectedValueOnce(new Error('document is not writable'));
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('failed');
  });

  it('несобранную нативную часть отличает от неудачи', async () => {
    mockNative.isSupported.mockResolvedValueOnce(false);
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('unsupported');
    expect(mockNative.start).not.toHaveBeenCalled();
  });
});

describe('retryOpenFlux', () => {
  it('повторяет, пока не выйдет: документ отвечает не с первого раза', async () => {
    mockNative.start
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('127.0.0.1:41080');
    await expect(retryOpenFlux(cfg())).resolves.toBe('on');
    expect(mockNative.start).toHaveBeenCalledTimes(3);
  });

  it('сдаётся после отведённых попыток, а не крутится вечно', async () => {
    mockNative.start.mockRejectedValue(new Error('timeout'));
    await expect(retryOpenFlux(cfg({ startRetries: 2 }))).resolves.toBe('failed');
    expect(mockNative.start).toHaveBeenCalledTimes(2);
  });

  it('не повторяет то, что от повтора не изменится', async () => {
    // «Нет ссылки» останется «нет ссылки» и на десятый раз: повтор здесь —
    // только потерянные секунды и ложная надежда.
    await expect(retryOpenFlux(cfg({ docUrl: '' }))).resolves.toBe('unconfigured');
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  it('перед подъёмом опускает прежний канал: два ядра на одном порту не живут', async () => {
    await retryOpenFlux(cfg());
    expect(mockNative.stop).toHaveBeenCalled();
    expect(mockNative.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mockNative.start.mock.invocationCallOrder[0],
    );
  });
});

describe('stopOpenFlux', () => {
  it('не роняет приложение, если ядро упало на остановке', async () => {
    mockNative.stop.mockRejectedValueOnce(new Error('already dead'));
    await expect(stopOpenFlux()).resolves.toBeUndefined();
  });
});

describe('счётчик соединений', () => {
  afterEach(() => {
    delete mockNative.enableTunnelStats;
    delete mockNative.tunnelStats;
  });

  it('там, где считать нечем, отвечает «нечем», а не нулём', async () => {
    // Ноль соединений и «счётчика нет» — разные вещи. Первое значит «трафик
    // мимо туннеля», второе — «мы не смотрели»; показать одно вместо другого
    // и есть то самое враньё нулём, от которого счётчик и задумывался.
    await expect(enableOpenFluxTunnelStats()).resolves.toBe(false);
    await expect(getOpenFluxTunnelStats()).resolves.toBeNull();
  });

  it('отдаёт то, что насчитало ядро, не приукрашивая', async () => {
    const stats = {
      counting: true,
      connections: 0,
      failures: 0,
      lastTarget: null,
      lastAt: null,
      systemProxy: true,
      httpProxy: true,
    };
    mockNative.enableTunnelStats = jest.fn().mockResolvedValue(undefined);
    mockNative.tunnelStats = jest.fn().mockResolvedValue(stats);

    await expect(enableOpenFluxTunnelStats()).resolves.toBe(true);
    // Прокси поставлены, а соединений ноль — именно так и должно выглядеть
    // «перехват включён, но трафик через него пока не пошёл».
    await expect(getOpenFluxTunnelStats()).resolves.toEqual(stats);
  });

  it('упавший счётчик не выдаёт за отсутствие соединений', async () => {
    mockNative.tunnelStats = jest.fn().mockRejectedValue(new Error('no core'));
    await expect(getOpenFluxTunnelStats()).resolves.toBeNull();
  });
});
