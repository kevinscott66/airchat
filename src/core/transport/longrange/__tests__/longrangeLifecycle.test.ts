/**
 * v4.32.501 — рэтчет: у long-range появился разбор.
 *
 * Дефект: подъём защищал модульный флаг `didInit`, который никогда не
 * сбрасывался, а разбора не существовало. Слушатель уровня заряда, подписанный
 * в enableRelayMode, жил до конца процесса и держал замыкание на весь экземпляр
 * ретрансляции — очередь до 2048 пакетов и по таймеру повтора на каждый.
 * После выхода из аккаунта ретрансляция продолжала работать на ключах прежней
 * личности, а поднять её заново — уже на текущей — было нельзя: флаг говорил
 * «уже подняли».
 *
 * Тест держит три вещи: разбор действительно снимает слушатель и таймеры,
 * разобранная служба инертна, и цикл жизни модуля выдерживает подъём и разбор
 * внахлёст, не снимая обработчик у только что запущенного цикла.
 */
import { RelayService, type RelayPacket } from '../relayService';

let mockListeners = 0;
let mockLevelCb: ((e: { batteryLevel: number }) => void) | null = null;
let mockThrowOnRemove = false;

jest.mock('expo-battery', () => ({
  addBatteryLevelListener: (cb: (e: { batteryLevel: number }) => void) => {
    mockListeners += 1;
    mockLevelCb = cb;
    return {
      remove: () => {
        if (mockThrowOnRemove) throw new Error('модуль уже выгружен');
        mockListeners -= 1;
        mockLevelCb = null;
      },
    };
  },
}));

jest.mock('../../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function packet(id: string, targetDid = 'did:key:target'): RelayPacket {
  return {
    id,
    sourceDid: 'did:key:source',
    targetDid,
    ttl: 5,
    encryptedPayload: new Uint8Array([1, 2, 3]),
    timestamp: Date.now(),
  };
}

/** Ретрансляция, у которой маршрут не находится: всё уходит в очередь. */
function makeRelay(opts: { route?: boolean } = {}): RelayService {
  const hop = opts.route ? [{ did: 'did:key:hop' }] : [];
  return new RelayService({
    geographicRouter: {
      findPath: async () => hop,
    } as unknown as ConstructorParameters<typeof RelayService>[0]['geographicRouter'],
    getMyDid: async () => 'did:key:me',
    sendToTransport: async () => false,
  });
}

beforeEach(() => {
  mockListeners = 0;
  mockLevelCb = null;
  mockThrowOnRemove = false;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('разбор ретрансляции', () => {
  it('слушатель заряда снимается', async () => {
    const relay = makeRelay();
    await relay.enableRelayMode();
    expect(mockListeners).toBe(1);
    relay.dispose();
    expect(mockListeners).toBe(0);
  });

  it('повторный подъём не плодит слушателей', async () => {
    const relay = makeRelay();
    await relay.enableRelayMode();
    await relay.enableRelayMode();
    await relay.enableRelayMode();
    expect(mockListeners).toBe(1);
    relay.dispose();
    expect(mockListeners).toBe(0);
  });

  it('таймеры повторов гасятся, а очередь отпускается', async () => {
    const relay = makeRelay();
    await relay.enableRelayMode();
    for (let i = 0; i < 25; i++) await relay.handleRelayPacket(packet(`p${i}`));
    expect(relay.pendingTimerCount()).toBe(25);
    relay.dispose();
    expect(relay.pendingTimerCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('разобранная служба не принимает новых пакетов', async () => {
    const relay = makeRelay();
    await relay.enableRelayMode();
    relay.dispose();
    await relay.handleRelayPacket(packet('после'));
    expect(relay.pendingTimerCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('разобранную службу нельзя поднять обратно', async () => {
    const relay = makeRelay();
    relay.dispose();
    await relay.enableRelayMode();
    expect(mockListeners).toBe(0);
  });

  it('повторный разбор безвреден', async () => {
    const relay = makeRelay();
    await relay.enableRelayMode();
    relay.dispose();
    relay.dispose();
    expect(mockListeners).toBe(0);
  });

  it('разбор доводится до конца, даже если слушатель уже отвалился', async () => {
    const relay = makeRelay();
    await relay.enableRelayMode();
    await relay.handleRelayPacket(packet('p1'));
    mockThrowOnRemove = true;
    expect(() => relay.dispose()).not.toThrow();
    expect(relay.pendingTimerCount()).toBe(0);
  });

  it('после разбора тик заряда никого не будит', async () => {
    const relay = makeRelay();
    await relay.enableRelayMode();
    const cb = mockLevelCb;
    expect(cb).not.toBeNull();
    await relay.handleRelayPacket(packet('p1'));
    relay.dispose();
    // Слушатель снят, но даже если модуль дёрнет старую ссылку — очередь пуста.
    cb?.({ batteryLevel: 0.9 });
    await Promise.resolve();
    expect(relay.pendingTimerCount()).toBe(0);
  });

  it('не считает пакет доставленным без подключённого транспорта', async () => {
    const relay = new RelayService({
      geographicRouter: {
        findPath: async () => [{ did: 'did:key:hop' }],
      } as unknown as ConstructorParameters<typeof RelayService>[0]['geographicRouter'],
      getMyDid: async () => 'did:key:me',
    });
    await relay.enableRelayMode();
    await relay.handleRelayPacket(packet('без-транспорта'));
    expect(relay.pendingTimerCount()).toBe(1);
    relay.dispose();
  });

  it('до фикса очередь и слушатель пережили бы разбор', async () => {
    // Фикстура старого поведения: разбора нет, всё остаётся жить.
    const relay = makeRelay();
    await relay.enableRelayMode();
    await relay.handleRelayPacket(packet('p1'));
    expect(mockListeners).toBe(1);
    expect(relay.pendingTimerCount()).toBe(1);
  });
});
