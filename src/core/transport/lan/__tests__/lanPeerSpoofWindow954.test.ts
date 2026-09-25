/**
 * Чужой адрес подменял живого пира в локальной сети (v4.32.954).
 *
 * Дефект. Защита от подмены в обработчике `resolved` отказывала объявлению с
 * другим host:port, пока запись о пире свежая. «Свежесть» бралась по
 * PEER_DISCOVERY_DEBOUNCE_MS — тридцати секундам, — а годной для отправки
 * запись остаётся все PEER_TTL_MS, сто двадцать: так считают и `canReach`, и
 * `send`. Между тридцатой и сто двадцатой секундой любое устройство в той же
 * сети, объявив `txt.did` жертвы со своим адресом, забирало себе её место.
 *
 * Цена. `lan.send` и `lanBlobPush` уходят на адрес чужого: он получает
 * шифротекст (прочесть не сможет), а с ним — время, объём и то, кто с кем
 * переписывается. До настоящего получателя кадр не доходит вовсе, и
 * перезапросить его по локальной сети нечем. Плановый resolve идёт раз в сорок
 * пять секунд, то есть дверь открывалась на пятнадцать секунд из каждых сорока
 * пяти — и открывалась снова и снова.
 *
 * Правка. Окно защиты приравнено к окну годности: пока записью пользуются, её
 * адрес не меняет никто. Чтобы честно переехавшее устройство (новый адрес по
 * DHCP, Wi-Fi вместо провода) не оказалось недостижимым до конца TTL, запись
 * снимается по отказу отправки — защищён РАБОТАЮЩИЙ адрес, а не любой занятый.
 *
 * Границы. Проверка не про сам mDNS: модуль обнаружения и модуль сокетов здесь
 * подставные, а время поддельное. Предмет — решение «пустить или не пустить
 * чужой адрес» и то, чем оно отпускается.
 */
/* eslint-disable no-var */
import { LanTransport } from '../lanTransport';

var mockResolved: ((svc: Record<string, unknown>) => void) | null;
var mockTcpSend: jest.Mock;

jest.mock('react-native-tcp-socket', () => ({
  createServer: () => ({
    listen: () => {},
    on: () => {},
    close: (cb?: () => void) => cb?.(),
  }),
}));

jest.mock('react-native-zeroconf', () => {
  class FakeZeroconf {
    publishService(): void {}
    unpublishService(): void {}
    scan(): void {}
    stop(): void {}
    removeDeviceListeners(): void {
      mockResolved = null;
    }
    on(ev: string, cb: (svc: Record<string, unknown>) => void): void {
      if (ev === 'resolved') mockResolved = cb;
    }
  }
  return { default: FakeZeroconf, ImplType: { NSD: 'NSD', DNSSD: 'DNSSD' } };
});

jest.mock('../lanSend', () => ({
  LAN_SEND_TIMEOUT_MS: 5000,
  tcpSend: (...args: unknown[]) => mockTcpSend(...args),
}));

const ALICE = 'did:key:z6MkAliceOnTheSameWifi';
const HONEST = '192.168.1.10';
const HOSTILE = '192.168.1.200';

/** Объявление службы, как его отдаёт mDNS. */
function advert(host: string, port = 9000): Record<string, unknown> {
  return { txt: { did: ALICE }, addresses: [host], host, port };
}

/**
 * Выпустить объявление в транспорт.
 *
 * Отдельной функцией, а не `emitResolved(…)` по месту: в `beforeEach` сразу
 * после присваивания `null` вывод типов считает переменную пустой навсегда.
 */
function emitResolved(svc: Record<string, unknown>): void {
  if (!mockResolved) throw new Error('обработчик resolved не зарегистрирован');
  mockResolved(svc);
}

let lan: LanTransport;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-25T12:00:00Z'));
  mockResolved = null;
  mockTcpSend = jest.fn().mockResolvedValue(true);
  lan = new LanTransport();
  lan.start({ myDid: 'did:key:z6MkMeMyselfAndI', port: 9000, onFrame: () => {} });
  emitResolved(advert(HONEST));
});

afterEach(() => {
  lan.stop();
  jest.useRealTimers();
});

/** Куда ушёл последний кадр. */
function lastTarget(): string | null {
  const call = mockTcpSend.mock.calls.at(-1);
  return call ? String(call[1]) : null;
}

describe('ПРОВЕРКА НЕ ПУСТАЯ: подставное обнаружение вправду работает', () => {
  it('объявление доходит до транспорта и заводит пира', () => {
    expect(mockResolved).not.toBeNull();
    expect(lan.getPeers().map((p) => p.host)).toEqual([HONEST]);
    expect(lan.canReach(ALICE)).toBe(true);
  });

  it('отправка идёт по объявленному адресу', async () => {
    await expect(lan.send(new Uint8Array([1]), ALICE)).resolves.toBe(true);
    expect(lastTarget()).toBe(HONEST);
  });
});

describe('чужой адрес не подменяет пира, пока его записью пользуются', () => {
  it('на тридцать первой секунде — прежний срок защиты истекал тут', async () => {
    jest.advanceTimersByTime(31_000);
    emitResolved(advert(HOSTILE));
    expect(lan.getPeers().map((p) => p.host)).toEqual([HONEST]);
    await lan.send(new Uint8Array([1]), ALICE);
    expect(lastTarget()).toBe(HONEST);
  });

  it('на сто десятой секунде — запись ещё годна, значит ещё под защитой', async () => {
    jest.advanceTimersByTime(110_000);
    emitResolved(advert(HOSTILE));
    await lan.send(new Uint8Array([1]), ALICE);
    expect(lastTarget()).toBe(HONEST);
  });

  it('другой порт на том же хосте — та же подмена и тот же отказ', () => {
    jest.advanceTimersByTime(31_000);
    emitResolved(advert(HONEST, 9999));
    expect(lan.getPeers()[0]?.port).toBe(9000);
  });

  it('окно защиты равно окну годности, а не окну debounce', () => {
    // Иначе говоря: нет такой секунды, когда запись ещё годна для отправки, но
    // уже не защищена. Тридцать секунд — граница debounce, не граница защиты.
    for (const t of [31_000, 45_000, 60_000, 119_000]) {
      const fresh = new LanTransport();
      fresh.start({ myDid: 'did:key:z6MkMeMyselfAndI', port: 9000, onFrame: () => {} });
      emitResolved(advert(HONEST));
      jest.advanceTimersByTime(t);
      emitResolved(advert(HOSTILE));
      expect([t, fresh.getPeers()[0]?.host]).toEqual([t, HONEST]);
      fresh.stop();
    }
  });
});

describe('переехавшее устройство не остаётся недостижимым до конца срока', () => {
  it('адрес, по которому не отправилось, забывается', async () => {
    mockTcpSend.mockResolvedValue(false);
    await expect(lan.send(new Uint8Array([1]), ALICE)).resolves.toBe(false);
    expect(lan.getPeers()).toEqual([]);
    expect(lan.canReach(ALICE)).toBe(false);
  });

  it('и новый адрес того же DID принимается сразу же', async () => {
    mockTcpSend.mockResolvedValue(false);
    await lan.send(new Uint8Array([1]), ALICE);
    emitResolved(advert(HOSTILE));
    expect(lan.getPeers().map((p) => p.host)).toEqual([HOSTILE]);
  });

  it('удачная отправка запись не трогает', async () => {
    await lan.send(new Uint8Array([1]), ALICE);
    expect(lan.getPeers().map((p) => p.host)).toEqual([HONEST]);
  });

  it('запись, заменённую во время отправки, отказ не стирает', async () => {
    // Пока кадр уходил, TTL истёк и пришло новое объявление. Отказ относится к
    // прежнему адресу, а не к этому: стереть его было бы неправдой.
    let release: (v: boolean) => void = () => {};
    mockTcpSend.mockReturnValue(new Promise<boolean>((r) => { release = r; }));
    const sending = lan.send(new Uint8Array([1]), ALICE);
    jest.advanceTimersByTime(121_000);
    emitResolved(advert(HOSTILE));
    release(false);
    await expect(sending).resolves.toBe(false);
    expect(lan.getPeers().map((p) => p.host)).toEqual([HOSTILE]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: защита не превратилась в «не пускать никого»', () => {
  it('тот же адрес освежает запись, а не отвергается как подмена', () => {
    jest.advanceTimersByTime(45_000);
    emitResolved(advert(HONEST));
    jest.advanceTimersByTime(100_000);
    // Прошло сто сорок пять секунд с первого объявления — без обновления
    // запись бы истекла.
    expect(lan.canReach(ALICE)).toBe(true);
  });

  it('после истечения срока место свободно для любого адреса', () => {
    jest.advanceTimersByTime(121_000);
    emitResolved(advert(HOSTILE));
    expect(lan.getPeers().map((p) => p.host)).toEqual([HOSTILE]);
  });

  it('debounce остался при своём деле — извещении об обнаружении', () => {
    const seen: string[] = [];
    const t = new LanTransport();
    t.start({
      myDid: 'did:key:z6MkMeMyselfAndI',
      port: 9000,
      onFrame: () => {},
      onPeerDiscovered: (did) => seen.push(did),
    });
    emitResolved(advert(HONEST));
    jest.advanceTimersByTime(10_000);
    emitResolved(advert(HONEST));
    expect(seen).toEqual([ALICE]);
    jest.advanceTimersByTime(31_000);
    emitResolved(advert(HONEST));
    expect(seen).toEqual([ALICE, ALICE]);
    t.stop();
  });
});
