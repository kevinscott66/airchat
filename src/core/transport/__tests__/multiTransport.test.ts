/**
 * Выбор транспорта для отправки (v4.32.332).
 *
 * Роутер решает, каким путём уйдёт сообщение и — что важнее — считать ли его
 * отправленным. Если он вернёт true там, где доставки не было, сообщение не
 * попадёт в повтор и просто пропадёт. Поэтому тесты смотрят и на порядок
 * попыток, и на итоговый ответ.
 */
const mockLan = {
  isActive: jest.fn(() => true),
  canReach: jest.fn(async () => true),
  send: jest.fn(async () => true),
};
const mockInternet = {
  isActive: jest.fn(() => true),
  canReach: jest.fn(async () => true),
  send: jest.fn(async () => true),
};
const mockWifi = {
  canReach: jest.fn(async () => false),
  send: jest.fn(async () => false),
};
const logCalls: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];

jest.mock('../lan/lanTransport', () => ({ getLanTransportSingleton: () => mockLan }));
jest.mock('../internet/internetTransport', () => ({ getInternetTransportSingleton: () => mockInternet }));
jest.mock('../longrange/wifiMesh', () => ({ getWiFiMeshTransport: () => mockWifi }));
jest.mock('../../logger', () => ({
  log: {
    debug: (msg: string, meta?: Record<string, unknown>) => logCalls.push({ level: 'debug', msg, meta }),
    info: (msg: string, meta?: Record<string, unknown>) => logCalls.push({ level: 'info', msg, meta }),
    warn: (msg: string, meta?: Record<string, unknown>) => logCalls.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta?: Record<string, unknown>) => logCalls.push({ level: 'error', msg, meta }),
  },
}));

import { MultiTransportRouter } from '../multiTransport';

/** Полный DID выглядит именно так — длинный и целиком опознающий человека. */
const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const DATA = new Uint8Array([1, 2, 3]);

/** Порядок, в котором роутер обращался к транспортам за проверкой достижимости. */
function reachOrder(): string[] {
  const order: string[] = [];
  mockLan.canReach.mockImplementation(async () => {
    order.push('lan');
    return false;
  });
  mockInternet.canReach.mockImplementation(async () => {
    order.push('internet');
    return false;
  });
  mockWifi.canReach.mockImplementation(async () => {
    order.push('wifi_direct');
    return false;
  });
  return order;
}

beforeEach(() => {
  jest.clearAllMocks();
  logCalls.length = 0;
  mockLan.isActive.mockReturnValue(true);
  mockLan.canReach.mockResolvedValue(true);
  mockLan.send.mockResolvedValue(true);
  mockInternet.isActive.mockReturnValue(true);
  mockInternet.canReach.mockResolvedValue(true);
  mockInternet.send.mockResolvedValue(true);
  mockWifi.canReach.mockResolvedValue(false);
  mockWifi.send.mockResolvedValue(false);
});

describe('порядок транспортов', () => {
  it('в одной сети сообщение уходит по LAN, интернет не трогается', async () => {
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(true);
    expect(mockLan.send).toHaveBeenCalledTimes(1);
    expect(mockInternet.send).not.toHaveBeenCalled();
  });

  it('когда LAN не видит собеседника, работает интернет', async () => {
    mockLan.canReach.mockResolvedValue(false);
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(true);
    expect(mockLan.send).not.toHaveBeenCalled();
    expect(mockInternet.send).toHaveBeenCalledTimes(1);
  });

  it('выключенный LAN не спрашивают о достижимости', async () => {
    mockLan.isActive.mockReturnValue(false);
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(true);
    expect(mockLan.canReach).not.toHaveBeenCalled();
    expect(mockInternet.send).toHaveBeenCalled();
  });

  it('отказ LAN на отправке не теряет сообщение — пробуется следующий', async () => {
    mockLan.send.mockResolvedValue(false);
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(true);
    expect(mockLan.send).toHaveBeenCalled();
    expect(mockInternet.send).toHaveBeenCalled();
  });

  it('исключение внутри транспорта не роняет отправку целиком', async () => {
    mockLan.send.mockRejectedValue(new Error('socket closed'));
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(true);
    expect(mockInternet.send).toHaveBeenCalled();
    expect(logCalls.some((c) => c.msg === 'transport_failed')).toBe(true);
  });

  it('базовый порядок — LAN, интернет, WiFi-Direct', async () => {
    const order = reachOrder();
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(false);
    expect(order).toEqual(['lan', 'internet', 'wifi_direct']);
  });

  it('когда не доходит ни один транспорт — честный false', async () => {
    mockLan.canReach.mockResolvedValue(false);
    mockInternet.canReach.mockResolvedValue(false);
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(false);
    expect(logCalls.some((c) => c.msg === 'transport_all_failed')).toBe(true);
  });
});

describe('подстройка под то, что реально работает', () => {
  it('после череды отказов LAN интернет пробуется первым', async () => {
    const router = new MultiTransportRouter();
    mockLan.send.mockResolvedValue(false);
    // Каждый отказ сдвигает EMA LAN вниз; интернет остаётся на 0.5 по умолчанию.
    for (let i = 0; i < 12; i++) await router.send(DATA, DID);

    jest.clearAllMocks();
    const order = reachOrder();
    await router.send(DATA, DID);
    expect(order[0]).toBe('internet');
  });

  it('успех держит транспорт впереди', async () => {
    const router = new MultiTransportRouter();
    for (let i = 0; i < 12; i++) await router.send(DATA, DID);

    jest.clearAllMocks();
    const order = reachOrder();
    await router.send(DATA, DID);
    expect(order[0]).toBe('lan');
  });
});

describe('зависшие транспорты не держат отправку', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('молчащий canReach отбрасывается через 2.5 с', async () => {
    mockLan.canReach.mockImplementation(() => new Promise<boolean>(() => {}));
    const p = new MultiTransportRouter().send(DATA, DID);
    await jest.advanceTimersByTimeAsync(2_500);
    await expect(p).resolves.toBe(true);
    expect(mockLan.send).not.toHaveBeenCalled();
    expect(mockInternet.send).toHaveBeenCalled();
  });

  it('быстрый ответ не оставляет заведённых таймеров', async () => {
    await new MultiTransportRouter().send(DATA, DID);
    // До v4.32.332 гонка оставляла по два таймера на сообщение — на 2.5 и 5
    // секунд, — которые движок хранил и будил впустую. При веерной раздаче
    // ленты (fan-out 64) это сотни таймеров на одно действие.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('зависшая отправка считается неудачей через 5 с, а не висит вечно', async () => {
    mockLan.send.mockImplementation(() => new Promise<boolean>(() => {}));
    const p = new MultiTransportRouter().send(DATA, DID);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe(true);
    expect(logCalls.some((c) => c.msg === 'transport_send_timeout')).toBe(true);
    expect(mockInternet.send).toHaveBeenCalled();
  });
});

describe('лог не строит список «кто с кем»', () => {
  it('DID собеседника пишется только префиксом', async () => {
    mockLan.canReach.mockResolvedValue(false);
    mockInternet.canReach.mockResolvedValue(false);
    await new MultiTransportRouter().send(DATA, DID);
    const written = JSON.stringify(logCalls);
    expect(written).not.toContain(DID);
    expect(written).toContain(DID.slice(0, 24));
  });

  it('попытка транспорта — это debug, а не info: строк слишком много', async () => {
    await new MultiTransportRouter().send(DATA, DID);
    const trying = logCalls.filter((c) => c.msg === 'transport_trying');
    expect(trying).toHaveLength(1);
    expect(trying[0].level).toBe('debug');
  });
});

/**
 * Маршрут доставки (v4.32.563).
 *
 * `send` отвечает «да/нет» и этого хватало, пока путь никого не интересовал.
 * Но «доставлено по локальной сети» и «доставлено через чужой сервер
 * пересылки» — разные вещи для того, кто сообщение отправил, и разница
 * должна дойти до строки сообщения неискажённой.
 */
describe('какой транспорт довёз', () => {
  it('LAN довёз — назван LAN, а не «просто отправлено»', async () => {
    await expect(new MultiTransportRouter().sendVia(DATA, DID)).resolves.toBe('lan');
  });

  it('LAN не добивает — назван тот, кто добил', async () => {
    mockLan.canReach.mockResolvedValue(false);
    await expect(new MultiTransportRouter().sendVia(DATA, DID)).resolves.toBe('internet');
  });

  it('никто не довёз — null, и это не путается с транспортом', async () => {
    mockLan.canReach.mockResolvedValue(false);
    mockInternet.canReach.mockResolvedValue(false);
    await expect(new MultiTransportRouter().sendVia(DATA, DID)).resolves.toBeNull();
  });

  it('назван тот, кто ответил успехом, а не тот, кого спросили первым', async () => {
    mockLan.send.mockResolvedValue(false);
    await expect(new MultiTransportRouter().sendVia(DATA, DID)).resolves.toBe('internet');
  });

  it('прежний ответ «да/нет» продолжает работать поверх маршрута', async () => {
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(true);
    mockLan.canReach.mockResolvedValue(false);
    mockInternet.canReach.mockResolvedValue(false);
    await expect(new MultiTransportRouter().send(DATA, DID)).resolves.toBe(false);
  });

  it('DID не попадает в лог целиком и на этом пути тоже', async () => {
    await new MultiTransportRouter().sendVia(DATA, DID);
    expect(JSON.stringify(logCalls)).not.toContain(DID);
  });
});
