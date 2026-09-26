/**
 * За придержанный сервером звонок расписываются только после диска
 * (v4.32.744).
 *
 * Звонок, не заставший человека в сети, существует в единственном экземпляре:
 * сервер держит его до подтверждённой доставки и по расписке убирает свою
 * копию (v4.32.617). А запись в журнал уходила брошенным `void
 * persistCallLog(...)`: `recordMissedCalls` возвращала число и диска не
 * дожидалась вовсе. Значит расписка означала «дошло до приложения», хотя
 * убирать копию можно только за «лежит на диске».
 *
 * Сорваться запись может буднично: список приезжает ПЕРВЫМ событием после
 * регистрации — ровно тогда, когда ключ шифрования ещё поднимается, — и
 * `kvSetSecret` в этот момент отвечает «нет». Звонок оставался жить только в
 * памяти: до перезапуска человек его видел, после — уже нет, а у сервера его
 * не было и тогда. «Вам звонили» пропадало навсегда.
 *
 * Отдельный случай — повторная доставка. Сервер отдаёт заново ровно те звонки,
 * за которые мы в прошлый раз не расписались; они уже лежат в памяти, новых
 * записей не прибавляется, и по одному лишь «добавлено ноль» расписаться —
 * значит потерять их вторым заходом.
 */
type MissedCall = { fromPeerId: string; at: number; attempts: number; e?: string };
type MissedHandler = (msg: { calls: MissedCall[] }) => void | boolean | Promise<void | boolean>;

let mockMissedHandler: MissedHandler | null = null;

const mockKvGetSecret = jest.fn(async (_key: string): Promise<string | null> => null);
const mockKvSetSecret = jest.fn(async (_key: string, _value: string): Promise<boolean> => true);
const mockKvDelete = jest.fn(async (_key: string): Promise<void> => undefined);

jest.mock('../../storage/local', () => ({
  kvGetSecret: (key: string) => mockKvGetSecret(key),
  // v4.32.979: свой столбец журнал читает тремя состояниями. Обе формы
  // стоят поверх одного мока — как в `local.ts`, где строчная написана
  // поверх ячейки; строчная оставлена, чтобы прогон на дореформенном
  // дереве шёл по живому коду.
  kvGetSecretCell: async (key: string) => {
    const text = await mockKvGetSecret(key);
    return text == null ? { state: 'absent' } : { state: 'plain', text };
  },
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: (key: string) => mockKvDelete(key),
}));

const mockNotifyMissedCall = jest.fn(async (_opts: { count: number }): Promise<void> => undefined);
jest.mock('../../../notifications/pushNotifications', () => ({
  notifyMissedCall: (opts: { count: number }) => mockNotifyMissedCall(opts),
}));

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class { close = jest.fn(); },
  RTCSessionDescription: class { constructor(value: unknown) { void value; } },
  RTCIceCandidate: class { constructor(value: unknown) { void value; } },
  mediaDevices: { getUserMedia: jest.fn() },
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendHangup = jest.fn();
    sendOffer = jest.fn();
    sendAnswer = jest.fn();
    sendIceCandidate = jest.fn();
    onOffer = jest.fn();
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onHangup = jest.fn();
    onPeerUnavailable = jest.fn();
    onMissedCalls = (h: MissedHandler): void => { mockMissedHandler = h; };
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

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  disposeCallService,
  getCallLog,
  initCallService,
  recordMissedCalls,
} from '../callService';
import { makePeer, sealMissed } from './callTestPeers';

const PID = 4;
const LOG_KEY = `p${PID}:call_log`;

const me = makePeer();
const peer = makePeer();
const other = makePeer();

/** Придержанный звонок с настоящей распиской звонившего. */
async function held(from = peer, at = Date.now() - 60_000): Promise<MissedCall> {
  return { fromPeerId: from.pub, at, attempts: 3, e: await sealMissed(from, me.pub, { now: at }) };
}

/** Доставка списка сервером — с тем же ответом, что уйдёт в расписке. */
async function deliver(...calls: MissedCall[]): Promise<boolean | void> {
  if (!mockMissedHandler) throw new Error('служба не подписалась на журнал');
  return await mockMissedHandler({ calls });
}

/** Сколько раз журнал действительно писали на диск. */
const writes = (): number => mockKvSetSecret.mock.calls.filter((c) => c[0] === LOG_KEY).length;

beforeEach(async () => {
  mockMissedHandler = null;
  mockKvGetSecret.mockClear();
  mockKvSetSecret.mockClear();
  mockKvSetSecret.mockImplementation(async () => true);
  mockKvDelete.mockClear();
  mockNotifyMissedCall.mockClear();
  await disposeCallService();
  await initCallService(me.pair, PID);
  mockKvSetSecret.mockClear();
});

afterEach(async () => {
  await disposeCallService();
});

describe('расписка означает «лежит на диске», а не «дошло до приложения»', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: обычная доставка доходит до хранилища и до журнала', async () => {
    await deliver(await held());
    // Отдельный оборот: проверка сторожит сам факт записи, а не то, дожидается
    // ли её обработчик, — иначе она подтверждала бы саму правку.
    await new Promise((r) => setTimeout(r, 0));
    expect(writes()).toBe(1);
    expect(getCallLog()).toMatchObject([{ peerPubB64: peer.pub, outcome: 'missed' }]);
  });

  it('запись легла — обработчик отвечает «сохранил»', async () => {
    expect(await deliver(await held())).toBe(true);
  });

  it('запись не легла — обработчик отвечает «не сохранил»', async () => {
    mockKvSetSecret.mockImplementation(async () => false);
    expect(await deliver(await held())).toBe(false);
  });

  it('хранилище упало с ошибкой — тот же ответ, а не исключение наружу', async () => {
    mockKvSetSecret.mockImplementation(async () => { throw new Error('keystore busy'); });
    expect(await deliver(await held())).toBe(false);
  });

  it('обработчик не отвечает раньше, чем кончилась запись', async () => {
    let release: (v: boolean) => void = () => {};
    mockKvSetSecret.mockImplementation(() => new Promise<boolean>((r) => { release = r; }));
    let answered = false;
    const pending = deliver(await held()).then((v) => { answered = true; return v; });
    await new Promise((r) => setTimeout(r, 0));
    // Диск ещё думает — расписываться не за что.
    expect(answered).toBe(false);
    release(true);
    expect(await pending).toBe(true);
  });
});

describe('повторная доставка того, за что не расписались', () => {
  it('новых записей ноль, но расписка по-прежнему зависит от диска', async () => {
    mockKvSetSecret.mockImplementation(async () => false);
    const call = await held();
    expect(await deliver(call)).toBe(false);
    // Сервер отдаёт тот же звонок ещё раз: в памяти он уже есть, на диске — нет.
    expect(await deliver(call)).toBe(false);
    expect(getCallLog()).toHaveLength(1);
  });

  it('удавшаяся со второго раза запись расписку отпускает', async () => {
    mockKvSetSecret.mockImplementation(async () => false);
    const call = await held();
    expect(await deliver(call)).toBe(false);
    mockKvSetSecret.mockImplementation(async () => true);
    expect(await deliver(call)).toBe(true);
    // И на диск ушёл именно тот звонок, а не пустой журнал.
    const last = mockKvSetSecret.mock.calls.filter((c) => c[0] === LOG_KEY).pop();
    expect(String(last?.[1])).toContain(peer.pub);
  });

  it('повтор не раздваивает звонок в истории', async () => {
    const call = await held();
    await deliver(call);
    await deliver(call);
    expect(getCallLog()).toHaveLength(1);
  });
});

/**
 * Здесь обе проверки проходят и до правки, и после: уведомление ей менять было
 * незачем, и это ровно то, что они сторожат. Сказать человеку о звонке важнее,
 * чем сохранить его, — он увидит звонок хотя бы сейчас, в журнале, живущем в
 * памяти. Соблазн «не поднимать баннер, раз запись не легла» отсюда и закрыт.
 */
describe('человеку говорят о звонке, даже если записать его не вышло', () => {
  it('уведомление поднимается и при сорванной записи', async () => {
    mockKvSetSecret.mockImplementation(async () => false);
    await deliver(await held());
    expect(mockNotifyMissedCall).toHaveBeenCalledWith({ count: 1 });
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: при удавшейся записи уведомление то же самое', async () => {
    await deliver(await held(), await held(other, Date.now() - 30_000));
    expect(mockNotifyMissedCall).toHaveBeenCalledWith({ count: 2 });
  });

  it('отсеянный список никого не беспокоит', async () => {
    // Без расписки звонившего запись в журнал не попадает — и уведомлять не о чем.
    await deliver({ fromPeerId: peer.pub, at: Date.now() - 60_000, attempts: 1 });
    expect(mockNotifyMissedCall).not.toHaveBeenCalled();
  });
});

describe('исход приёмки называет и число, и судьбу записи', () => {
  it('отвечает парой, а не одним числом', async () => {
    expect(await recordMissedCalls([await held()], me.pub)).toEqual({ added: 1, stored: true });
  });

  it('отсеянный список — ноль новых, но журнал всё равно закрепляется', async () => {
    const res = await recordMissedCalls([{ fromPeerId: 'не-ключ', at: 1, attempts: 1 }], me.pub);
    expect(res).toEqual({ added: 0, stored: true });
  });

  it('без поднятой службы расписываться не за что', async () => {
    await disposeCallService();
    const res = await recordMissedCalls([await held()], me.pub);
    expect(res.stored).toBe(false);
    expect(mockKvSetSecret).not.toHaveBeenCalledWith(LOG_KEY, expect.anything());
  });
});
