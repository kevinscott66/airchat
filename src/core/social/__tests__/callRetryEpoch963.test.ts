/**
 * Опоздавший запуск больше не оставляет службу без сторожа регистрации
 * (v4.32.963).
 *
 * ДЕФЕКТ. Первая попытка регистрации ходит в сеть, и на мёртвом сигнальном
 * сервере она висит до срока ожидания. `initCallService` дожидался её и
 * заводил сторож БЕЗ повторной проверки эпохи. Если за это время человек
 * сменил профиль, запуск под новым ключом успевал пройти целиком — и старый,
 * вернувшись, клал свой сторож поверх поля. Новый оставался заведённым, но
 * безымянным: снять его было уже нечем. А сам тик снимал не себя, а то, что
 * записано в поле, — то есть сторожа ЖИВОЙ эпохи.
 *
 * ЦЕНА. После второй смены ключа забытый сторож прошлого профиля на каждом
 * тике убивал живого. Регистрацию не восстанавливал уже никто: сигнальный
 * сервер про телефон забывает после обрыва, и звонящему он отвечает
 * «недоступен». Человек об этом не узнаёт — входящих просто нет, до
 * перезапуска приложения. Экран диагностики при этом честно писал «повтор не
 * идёт», и это было единственной правдой во всей картине.
 *
 * ПРАВКА. Эпоха спрашивается после ожидания, и тик снимает именно свой
 * таймер.
 *
 * ГРАНИЦЫ. Сторож по-прежнему заводится и когда первая попытка удалась
 * (v4.32.615), и по-прежнему молчит, пока транспорт видит регистрацию живой.
 */
import fs from 'fs';
import path from 'path';

let mockRegistered = false;
const mockRegister = jest.fn();
/** Ворота первого `connect`: пока не открыты, запуск висит в сети. */
let mockConnectGate: Promise<void> | null = null;
/** Сколько раз запуск реально дошёл до сети. Без этого счётчика проверка
 *  незаметно выродилась бы в «ничего не случилось». */
let mockConnectEntered = 0;

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = async (): Promise<void> => {
      mockConnectEntered += 1;
      if (mockConnectGate) await mockConnectGate;
    };
    register = async (...a: unknown[]): Promise<void> => {
      mockRegister(...a);
      mockRegistered = true;
    };
    isRegistered = (): boolean => mockRegistered;
    disconnect = (): void => { mockRegistered = false; };
    sendAnswer = jest.fn();
    sendOffer = jest.fn();
    sendIceCandidate = jest.fn();
    onOffer = jest.fn();
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onPeerUnavailable = jest.fn();
    onMissedCalls = jest.fn();
  },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({ webrtc: { signalingUrl: 'http://signal.test' } })),
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async (): Promise<void> => undefined,
    isBlocked: (): boolean => false,
  },
}));

import { disposeCallService, getCallServiceStatus, initCallService } from '../callService';
import { makePeer } from './callTestPeers';

const RETRY_MS = 15_000;

const a = makePeer();
const b = makePeer();
const c = makePeer();

/** Ворота, которые открываются вручную. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((res) => { open = () => res(); });
  return { promise, open };
}

/**
 * Дать очереди разойтись, не двигая часы.
 *
 * Микрозадач мало: `loadCallLog` тянет модуль хранилища через `await import`,
 * и восьми оборотов не хватало — запуск замирал ДО сети, где гонки нет вовсе.
 * Поэтому `setImmediate` оставлен настоящим (см. useFakeTimers ниже).
 */
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  mockRegistered = false;
  mockConnectGate = null;
  mockConnectEntered = 0;
  mockRegister.mockClear();
  await disposeCallService();
});

afterEach(async () => {
  mockConnectGate = null;
  await disposeCallService();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('смена ключа во время висящей регистрации', () => {
  it('опоздавший запуск не оставляет службу без сторожа', async () => {
    const g = gate();
    mockConnectGate = g.promise;
    const first = initCallService(a.pair, 1);
    await settle();
    // Запуск действительно висит в сети, а не замер раньше неё.
    expect(mockConnectEntered).toBe(1);

    // Человек сменил профиль, пока первый запуск висит в сети.
    mockConnectGate = null;
    await initCallService(b.pair, 2);
    expect(getCallServiceStatus().registered).toBe(true);

    // Сеть наконец ответила первому.
    g.open();
    await first;
    await settle();

    // Один оборот сторожа. До правки на этом месте опоздавший сторож снимал
    // с поля живого, и служба оставалась без повтора вовсе.
    jest.advanceTimersByTime(RETRY_MS);
    await settle();
    expect(getCallServiceStatus().retrying).toBe(true);
  });

  it('после второй смены ключа потерянную регистрацию всё ещё поднимают', async () => {
    const g = gate();
    mockConnectGate = g.promise;
    const first = initCallService(a.pair, 1);
    await settle();
    expect(mockConnectEntered).toBe(1);

    mockConnectGate = null;
    await initCallService(b.pair, 2);
    g.open();
    await first;
    await settle();

    await initCallService(c.pair, 3);
    const before = mockRegister.mock.calls.length;

    // Обрыв: сокет жив, но сервер про телефон уже не знает.
    jest.advanceTimersByTime(RETRY_MS);
    await settle();
    mockRegistered = false;
    jest.advanceTimersByTime(RETRY_MS);
    await settle();

    expect(mockRegister.mock.calls.length).toBeGreaterThan(before);
    expect(getCallServiceStatus().retrying).toBe(true);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Сторож нужен живой, а не просто уцелевший: если он начнёт перерегистрировать
 * телефон на каждом обороте, служба будет дёргать сигнальный сервер вхолостую,
 * а старое правило v4.32.615 («не снимается по первому успеху») сломается
 * незаметно.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный запуск ведёт себя как прежде', () => {
  it('один запуск — одна регистрация и заведённый сторож', async () => {
    await initCallService(a.pair, 1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(getCallServiceStatus()).toMatchObject({ registered: true, retrying: true });
  });

  it('пока регистрация жива, сторож молчит', async () => {
    await initCallService(a.pair, 1);
    jest.advanceTimersByTime(RETRY_MS * 4);
    await settle();
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(getCallServiceStatus().retrying).toBe(true);
  });

  it('регистрация потерялась — сторож поднимает её сам', async () => {
    await initCallService(a.pair, 1);
    mockRegistered = false;
    jest.advanceTimersByTime(RETRY_MS);
    await settle();
    expect(mockRegister).toHaveBeenCalledTimes(2);
  });

  it('ГРАНИЦА: остановка службы снимает сторож', async () => {
    await initCallService(a.pair, 1);
    await disposeCallService();
    expect(getCallServiceStatus().retrying).toBe(false);
  });
});

describe('форма исходников: эпоха спрашивается после ожидания', () => {
  const CODE = fs
    .readFileSync(path.join(__dirname, '..', 'callService.ts'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const INIT = CODE.slice(
    CODE.indexOf('export async function initCallService'),
    CODE.indexOf('function isSignalingLive'),
  );

  it('между ожиданием и заводом сторожа стоит проверка эпохи', () => {
    expect(INIT).not.toBe('');
    const at = INIT.indexOf('await ensureRegistered(myPub, epoch);');
    expect(at).toBeGreaterThan(0);
    const between = INIT.slice(at, INIT.indexOf('setInterval(', at));
    expect(between).toContain('if (serviceEpoch !== epoch || myPubB64Global !== myPub) return;');
  });

  it('тик снимает свой таймер, а не тот, что записан в поле', () => {
    expect(INIT).toContain('clearInterval(mine);');
    expect(INIT).toContain('if (registerRetryTimer === mine) registerRetryTimer = null;');
    const tick = INIT.slice(INIT.indexOf('setInterval('));
    expect(tick).not.toContain('stopRegisterRetry();');
  });
});
