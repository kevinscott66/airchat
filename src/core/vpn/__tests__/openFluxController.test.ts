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
  getOpenFluxHttpLayerActive,
  getOpenFluxTunnelStats,
  maybeStartOpenFlux,
  openFluxConfigured,
  retryOpenFlux,
  stopOpenFlux,
} from '../openFluxController';

const mockNative = AirChatOpenFlux as unknown as {
  authorizeSession?: jest.Mock;
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
  delete mockNative.authorizeSession;
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
    // v4.32.1014: ответ появился. Повод для закрепки прежний — отказ ядра не
    // должен разваливать вызывающего, — но «ничего не вернули» больше не
    // годится: по этому ответу и решают, говорить ли человеку «выключено».
    mockNative.stop.mockRejectedValueOnce(new Error('already dead'));
    await expect(stopOpenFlux()).resolves.toBe(true);
  });

  it('«ядра уже нет» — это погасло, а не неудача', async () => {
    mockNative.stop.mockRejectedValueOnce(new Error('already dead'));
    mockNative.isRunning.mockResolvedValueOnce(false);

    expect(await stopOpenFlux()).toBe(true);
  });

  it('отказ, после которого ядро всё ещё поднято, — неудача', async () => {
    mockNative.stop.mockRejectedValueOnce(new Error('busy'));
    mockNative.isRunning.mockResolvedValueOnce(true);

    expect(await stopOpenFlux()).toBe(false);
  });

  it('ядро не ответило и на «поднят ли» — подтвердить остановку нечем', async () => {
    mockNative.stop.mockRejectedValueOnce(new Error('busy'));
    mockNative.isRunning.mockRejectedValueOnce(new Error('no answer'));

    expect(await stopOpenFlux()).toBe(false);
  });

  it('обычная остановка — `true`, и слой перехвата забыт', async () => {
    expect(await stopOpenFlux()).toBe(true);
    expect(getOpenFluxHttpLayerActive()).toBeNull();
  });

  it('там, где ядра нет, гасить нечего — и это успех', async () => {
    (Platform as { OS: string }).OS = 'web';

    expect(await stopOpenFlux()).toBe(true);
    expect(mockNative.stop).not.toHaveBeenCalled();
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
    // v4.32.1081: отказ называет себя. Закрепка тут не про слово, а про то,
    // что включения не случилось и нулём это не прикрыто.
    await expect(enableOpenFluxTunnelStats()).resolves.not.toBe('on');
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

    await expect(enableOpenFluxTunnelStats()).resolves.toBe('on');
    // Прокси поставлены, а соединений ноль — именно так и должно выглядеть
    // «перехват включён, но трафик через него пока не пошёл».
    await expect(getOpenFluxTunnelStats()).resolves.toEqual(stats);
  });

  it('упавший счётчик не выдаёт за отсутствие соединений', async () => {
    mockNative.tunnelStats = jest.fn().mockRejectedValue(new Error('no core'));
    await expect(getOpenFluxTunnelStats()).resolves.toBeNull();
  });
});

/**
 * Перехват HTTP мог и не встать, хотя ядро поднялось.
 *
 * На iOS перехват сетевого стека React Native ставится один раз за жизнь
 * процесса и на заранее зарезервированный порт. Занял этот порт кто-то другой —
 * ядро поднимается на любом свободном (туннель важнее второго слоя), а перехват
 * остаётся нацелен в пустоту. Failover у него включён намеренно, поэтому
 * запросы не падают с ошибкой, а тихо уходят напрямую.
 *
 * Снаружи это выглядело как «Включён», и другого признака у человека не
 * было: строка про прямой трафик жила в инженерном разделе, за семью нажатиями
 * по номеру версии и вручную включаемым счётчиком. Различимость этих двух
 * состояний и проверяется ниже.
 */
describe('перехват HTTP после подъёма', () => {
  afterEach(async () => {
    delete mockNative.tunnelStats;
    await stopOpenFlux();
  });

  it('перехват встал — говорим «да»', async () => {
    mockNative.tunnelStats = jest.fn().mockResolvedValue({
      counting: false, connections: 0, failures: 0, lastTarget: null, lastAt: null,
      systemProxy: true, httpProxy: true,
    });
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('on');
    expect(getOpenFluxHttpLayerActive()).toBe(true);
  });

  it('перехват мимо — говорим «нет», а не «канал поднят»', async () => {
    mockNative.tunnelStats = jest.fn().mockResolvedValue({
      counting: false, connections: 0, failures: 0, lastTarget: null, lastAt: null,
      systemProxy: true, httpProxy: false,
    });
    // Статус остаётся `on`, и это правильно: ядро действительно поднялось, а
    // трафик действительно идёт — просто не туда, куда человек рассчитывал.
    // Поэтому ответ на «куда идёт» и живёт отдельным вопросом.
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('on');
    expect(getOpenFluxHttpLayerActive()).toBe(false);
  });

  it('спросить некого — отвечает «не знаю», а не «нет»', async () => {
    // Android и web: счётчика нет вовсе. Выдать здесь `false` значило бы
    // повесить предупреждение о прямом трафике там, где никакого прямого
    // трафика нет.
    await expect(maybeStartOpenFlux(cfg())).resolves.toBe('on');
    expect(getOpenFluxHttpLayerActive()).toBeNull();
  });

  it('после остановки прошлый ответ не держится', async () => {
    mockNative.tunnelStats = jest.fn().mockResolvedValue({
      counting: false, connections: 0, failures: 0, lastTarget: null, lastAt: null,
      systemProxy: true, httpProxy: false,
    });
    await maybeStartOpenFlux(cfg());
    expect(getOpenFluxHttpLayerActive()).toBe(false);
    await stopOpenFlux();
    // Иначе выключенный туннель продолжал бы пугать предупреждением о прямом
    // трафике — при том что прямой трафик в этот момент и есть норма.
    expect(getOpenFluxHttpLayerActive()).toBeNull();
  });
});


describe('local browser session', () => {
  it('does not open authentication during background startup', async () => {
    mockNative.authorizeSession = jest.fn();
    await maybeStartOpenFlux(cfg());
    expect(mockNative.authorizeSession).not.toHaveBeenCalled();
  });
  it('does not open authentication during automatic network recovery', async () => {
    mockNative.authorizeSession = jest.fn();
    mockNative.start.mockResolvedValue('127.0.0.1:41080');
    await retryOpenFlux(cfg());
    expect(mockNative.authorizeSession).not.toHaveBeenCalled();
  });
  it('does not launch the core after cancelled login', async () => {
    mockNative.authorizeSession = jest.fn().mockResolvedValue(false);
    await expect(retryOpenFlux(cfg(), { renew: false })).resolves.toBe('failed');
    expect(mockNative.start).not.toHaveBeenCalled();
    expect(mockNative.authorizeSession).toHaveBeenCalledTimes(1);
  });
  it('renews once, then launches without passing cookies through JS', async () => {
    mockNative.authorizeSession = jest.fn().mockResolvedValue(true);
    mockNative.start.mockResolvedValue('127.0.0.1:41080');
    await expect(retryOpenFlux(cfg(), { renew: true })).resolves.toBe('on');
    expect(mockNative.authorizeSession).toHaveBeenCalledWith(DOC, true);
    expect(mockNative.authorizeSession).toHaveBeenCalledTimes(1);
    expect(mockNative.start.mock.calls[0][0]).not.toHaveProperty('session');
  });
});

describe('serialized lifecycle', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  afterEach(async () => {
    jest.useRealTimers();
    mockNative.stop.mockResolvedValue(undefined);
    await stopOpenFlux();
  });

  it('stops without waiting for login and never starts when that login later completes', async () => {
    const entered = deferred<void>();
    const login = deferred<boolean>();
    mockNative.authorizeSession = jest.fn(() => { entered.resolve(); return login.promise; });
    const retry = retryOpenFlux(cfg(), { renew: true });
    await entered.promise;
    await expect(stopOpenFlux()).resolves.toBe(true);
    login.resolve(true);
    await expect(retry).resolves.toBe('off');
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  it('invalidates retries waiting between attempts', async () => {
    jest.useFakeTimers();
    mockNative.start.mockRejectedValue(new Error('offline'));
    const retry = retryOpenFlux(cfg({ retryDelayMs: 2000 }));
    await jest.advanceTimersByTimeAsync(0);
    expect(mockNative.start).toHaveBeenCalledTimes(1);
    await stopOpenFlux();
    await jest.advanceTimersByTimeAsync(2000);
    await expect(retry).resolves.toBe('off');
    expect(mockNative.start).toHaveBeenCalledTimes(1);
    mockNative.start.mockResolvedValue('127.0.0.1:41080');
  });

  it('waits for an in-progress native start and cleans it up before confirming stop', async () => {
    const entered = deferred<void>();
    const start = deferred<string>();
    const events: string[] = [];
    mockNative.start.mockImplementationOnce(() => { entered.resolve(); return start.promise; });
    mockNative.stop.mockImplementation(async () => { events.push('stopped'); });
    const pending = maybeStartOpenFlux(cfg());
    await entered.promise;
    const stop = stopOpenFlux().then((result) => { events.push('confirmed'); return result; });
    expect(events).toEqual([]);
    start.resolve('127.0.0.1:41080');
    await expect(pending).resolves.toBe('off');
    await expect(stop).resolves.toBe(true);
    expect(events[0]).toBe('stopped');
    expect(events[events.length - 1]).toBe('confirmed');
    expect(getOpenFluxHttpLayerActive()).toBeNull();
  });

  it('serializes overlapping automatic and explicit starts; only the latest intent survives', async () => {
    const entered = deferred<void>();
    const start = deferred<string>();
    const events: string[] = [];
    mockNative.start.mockImplementationOnce(() => {
      events.push('old start'); entered.resolve(); return start.promise;
    }).mockImplementationOnce(async () => { events.push('new start'); return '127.0.0.1:41081'; });
    mockNative.stop.mockImplementation(async () => { events.push('stop'); });
    mockNative.authorizeSession = jest.fn().mockResolvedValue(true);
    const automatic = maybeStartOpenFlux(cfg());
    await entered.promise;
    const explicit = retryOpenFlux(cfg(), { renew: true });
    expect(mockNative.start).toHaveBeenCalledTimes(1);
    start.resolve('127.0.0.1:41080');
    await expect(automatic).resolves.toBe('off');
    await expect(explicit).resolves.toBe('on');
    expect(events.indexOf('stop')).toBeGreaterThan(events.indexOf('old start'));
    expect(events.indexOf('new start')).toBeGreaterThan(events.indexOf('stop'));
    expect(mockNative.authorizeSession).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'unknown'])('does not authorize or start after stop fails with %s state', async (state) => {
    mockNative.stop.mockRejectedValueOnce(new Error('busy'));
    if (state === 'running') mockNative.isRunning.mockResolvedValueOnce(true);
    else mockNative.isRunning.mockRejectedValueOnce(new Error('unavailable'));
    mockNative.authorizeSession = jest.fn();
    await expect(retryOpenFlux(cfg(), { renew: true })).resolves.toBe('failed');
    expect(mockNative.authorizeSession).not.toHaveBeenCalled();
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  it('still retries when stop rejects but the core confirms it is stopped', async () => {
    mockNative.stop.mockRejectedValueOnce(new Error('already stopped'));
    mockNative.isRunning.mockResolvedValueOnce(false);
    await expect(retryOpenFlux(cfg())).resolves.toBe('on');
    expect(mockNative.start).toHaveBeenCalledTimes(1);
  });
});
