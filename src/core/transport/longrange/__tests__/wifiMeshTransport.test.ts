/**
 * Настоящий WiFiMeshTransport поверх подменённого react-native-wifi-p2p.
 *
 * Дефекты, которые держит тест:
 * - после исключения нативного `sendMessageTo` send() проваливался в
 *   «групповой» возврат и отвечал true, если группа поднята и узел известен;
 * - остановки не было: обнаружение и группа Wi-Fi Direct оставались в эфире,
 *   а таблица узлов синглтона переживала смену личности;
 * - обработчик найденных устройств ставился после первого скана и терял его.
 */

type Device = { deviceAddress: string; deviceName: string };

const mockP2p = {
  initialize: jest.fn(async () => true),
  createGroup: jest.fn(async () => undefined),
  removeGroup: jest.fn(async () => undefined),
  getGroupInfo: jest.fn(async () => ({ networkName: 'DIRECT-xy', passphrase: 'secret12' })),
  startDiscoveringPeers: jest.fn(async () => 'ok'),
  stopDiscoveringPeers: jest.fn(async () => undefined),
  getAvailablePeers: jest.fn(async (): Promise<{ devices: Device[] }> => ({ devices: [] })),
  connect: jest.fn(async (_addr: string) => undefined),
  sendMessageTo: jest.fn(async (message: string, _addr: string) => ({ time: 1, message })),
};

jest.mock('react-native-wifi-p2p', () => mockP2p);

jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 33 } }));

jest.mock('../../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Для сквозного цикла жизни через index.ts.
let mockProfileKey = 1;
const mockRelays: Array<{ getMyDid: () => Promise<string>; disposed: boolean }> = [];
const mockSyncs: Array<{ detected: string[]; getMyDid?: () => Promise<string> }> = [];

jest.mock('../pipelineFlag', () => ({
  isLongRangePipelineEnabled: () => true,
  LONG_RANGE_PIPELINE_ENABLED: false,
}));

jest.mock('../../../crypto/keyManager', () => ({
  loadKeyPair: async () => ({ publicKey: new Uint8Array(32).fill(mockProfileKey) }),
}));

jest.mock('../../../identity/did', () => ({
  publicKeyToDidKey: (pk: Uint8Array) => `did:key:profile-${pk[0]}`,
}));

jest.mock('../geographicRouter', () => ({
  GeographicRouter: class {
    async hydrateFromDb(): Promise<void> {}
  },
}));

jest.mock('../relayService', () => ({
  RelayService: class {
    constructor(deps: { getMyDid: () => Promise<string> }) {
      mockRelays.push({ getMyDid: deps.getMyDid, disposed: false });
      this.idx = mockRelays.length - 1;
    }
    private readonly idx: number;
    async enableRelayMode(): Promise<void> {}
    dispose(): void {
      mockRelays[this.idx].disposed = true;
    }
  },
}));

jest.mock('../opportunisticSync', () => ({
  OpportunisticSync: class {
    private readonly rec: { detected: string[]; getMyDid?: () => Promise<string> };
    constructor(deps: { getMyDid?: () => Promise<string> }) {
      this.rec = { detected: [], getMyDid: deps.getMyDid };
      mockSyncs.push(this.rec);
    }
    onDeviceDetected = async (d: { did: string }): Promise<void> => {
      this.rec.detected.push(d.did);
    };
  },
}));

import { log } from '../../../logger';
import { getWiFiMeshTransport, WiFiMeshTransport } from '../wifiMesh';

const peers = (...addrs: string[]) => ({
  devices: addrs.map((a) => ({ deviceAddress: a, deviceName: `phone-${a}` })),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockP2p.getAvailablePeers.mockImplementation(async () => ({ devices: [] }));
  mockP2p.sendMessageTo.mockImplementation(async (message: string) => ({ time: 1, message }));
  mockP2p.stopDiscoveringPeers.mockImplementation(async () => undefined);
  mockP2p.removeGroup.mockImplementation(async () => undefined);
  mockProfileKey = 1;
  mockRelays.length = 0;
  mockSyncs.length = 0;
});

async function activeWithPeer(addr = 'aa:bb'): Promise<WiFiMeshTransport> {
  const t = new WiFiMeshTransport();
  mockP2p.getAvailablePeers.mockResolvedValueOnce(peers(addr));
  expect(await t.startAccessPoint()).toBe(true);
  await t.scanAndConnect();
  return t;
}

describe('отправка', () => {
  it('ошибка нативного sendMessageTo — не успех, даже при группе и известном узле', async () => {
    const t = await activeWithPeer();
    expect(await t.canReach('did:p2p:aa:bb')).toBe(true);
    mockP2p.sendMessageTo.mockRejectedValueOnce(new Error('socket closed'));
    expect(await t.send(new Uint8Array([1, 2]), 'did:p2p:aa:bb')).toBe(false);

    mockP2p.sendMessageTo.mockRejectedValueOnce(new Error('socket closed'));
    await expect(t.sendDetailed(new Uint8Array([1]), 'did:p2p:aa:bb')).resolves.toEqual({
      ok: false,
      reason: 'native_failed',
    });
  });

  it('ошибка connect — тоже не успех, и до sendMessageTo дело не доходит', async () => {
    const t = await activeWithPeer();
    mockP2p.connect.mockRejectedValueOnce(new Error('busy'));
    expect(await t.send(new Uint8Array([1]), 'did:p2p:aa:bb')).toBe(false);
    expect(mockP2p.sendMessageTo).not.toHaveBeenCalled();
  });

  it('успех — только по ответу sendMessageTo, с байтами в base64 на адрес узла', async () => {
    const t = await activeWithPeer();
    expect(await t.send(new Uint8Array([1, 2, 3]), 'did:p2p:aa:bb')).toBe(true);
    expect(mockP2p.connect).toHaveBeenCalledWith('aa:bb');
    expect(mockP2p.sendMessageTo).toHaveBeenCalledWith('AQID', 'aa:bb');
  });

  it('известный узел без P2P-адреса — не «отправлено»', async () => {
    const t = await activeWithPeer();
    t.registerPeer({ did: 'did:key:lan', ip: '10.0.0.2', port: 1, ssid: 'x', lastSeen: 0, hops: 1 });
    await expect(t.sendDetailed(new Uint8Array([1]), 'did:key:lan')).resolves.toEqual({
      ok: false,
      reason: 'no_address',
    });
    expect(mockP2p.sendMessageTo).not.toHaveBeenCalled();
  });

  it('неактивный транспорт в эфир не лезет', async () => {
    const t = new WiFiMeshTransport();
    await expect(t.sendDetailed(new Uint8Array([1]), 'did:p2p:aa:bb')).resolves.toEqual({
      ok: false,
      reason: 'inactive',
    });
    expect(mockP2p.connect).not.toHaveBeenCalled();
  });
});

describe('скан', () => {
  it('каждый найденный узел сообщается обработчику ровно один раз', async () => {
    const t = new WiFiMeshTransport();
    const seen: string[] = [];
    t.onDeviceFound((d) => seen.push(d.did));
    mockP2p.getAvailablePeers.mockResolvedValueOnce(peers('aa', 'bb'));
    await t.startAccessPoint();
    await t.scanAndConnect();
    expect(seen).toEqual(['did:p2p:aa', 'did:p2p:bb']);
  });
});

describe('остановка', () => {
  it('снимает обнаружение и группу, забывает узлы и обработчик', async () => {
    const t = await activeWithPeer();
    const seen: string[] = [];
    t.onDeviceFound((d) => seen.push(d.did));
    await t.stop();
    expect(mockP2p.stopDiscoveringPeers).toHaveBeenCalledTimes(1);
    expect(mockP2p.removeGroup).toHaveBeenCalledTimes(1);
    expect(t.getPeers()).toEqual([]);
    expect(await t.canReach('did:p2p:aa:bb')).toBe(false);
    expect(await t.send(new Uint8Array([1]), 'did:p2p:aa:bb')).toBe(false);
    // Обработчик снят: следующий скан ему ничего не сообщит.
    mockP2p.getAvailablePeers.mockResolvedValueOnce(peers('cc'));
    await t.scanAndConnect();
    expect(seen).toEqual([]);
  });

  it('повторная остановка не трогает нативный модуль и не падает', async () => {
    const t = await activeWithPeer();
    await t.stop();
    await expect(t.stop()).resolves.toBeUndefined();
    expect(mockP2p.stopDiscoveringPeers).toHaveBeenCalledTimes(1);
    expect(mockP2p.removeGroup).toHaveBeenCalledTimes(1);
  });

  it('остановка без подъёма нативный модуль не трогает', async () => {
    const t = new WiFiMeshTransport();
    await t.stop();
    expect(mockP2p.stopDiscoveringPeers).not.toHaveBeenCalled();
    expect(mockP2p.removeGroup).not.toHaveBeenCalled();
  });

  it('ошибки нативной остановки логируются, а разбор доезжает до конца', async () => {
    const t = await activeWithPeer();
    mockP2p.stopDiscoveringPeers.mockRejectedValueOnce(new Error('нет разрешения'));
    mockP2p.removeGroup.mockRejectedValueOnce(new Error('BUSY'));
    await expect(t.stop()).resolves.toBeUndefined();
    // removeGroup вызван, несмотря на сбой stopDiscoveringPeers.
    expect(mockP2p.removeGroup).toHaveBeenCalledTimes(1);
    expect(t.getPeers()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('[WiFiMesh] stopDiscoveringPeers failed', expect.anything());
    expect(log.warn).toHaveBeenCalledWith('[WiFiMesh] removeGroup failed', expect.anything());
  });

  it('скан, остановленный на полпути, не приносит узлы в следующий цикл', async () => {
    const t = new WiFiMeshTransport();
    await t.startAccessPoint();
    let release!: (v: { devices: Device[] }) => void;
    mockP2p.getAvailablePeers.mockImplementationOnce(
      () => new Promise((r) => { release = r; })
    );
    const scan = t.scanAndConnect();
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    await t.stop();
    release(peers('old'));
    await scan;
    expect(t.getPeers()).toEqual([]);
    // Обнаружение, запущенное этим сканом, снято ровно один раз.
    expect(mockP2p.stopDiscoveringPeers).toHaveBeenCalledTimes(1);
  });
});

describe('цикл жизни long-range поверх настоящего транспорта', () => {
  it('start → stop → start под другой личностью: новый DID, старых узлов нет', async () => {
    // Тот же реестр модулей, что у импорта выше: синглтон транспорта общий.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../index') as typeof import('../index');

    mockP2p.getAvailablePeers.mockResolvedValueOnce(peers('old-peer'));
    await m.initLongRangeTransport();
    const mesh = getWiFiMeshTransport();
    // Первый скан дошёл до синхронизации: обработчик стоял до обнаружения.
    expect(mockSyncs[0].detected).toEqual(['did:p2p:old-peer']);
    await expect(mockSyncs[0].getMyDid?.()).resolves.toBe('did:key:profile-1');
    expect(mesh.getPeers().map((p) => p.did)).toEqual(['did:p2p:old-peer']);

    await m.shutdownLongRangeTransport();
    expect(mockRelays[0].disposed).toBe(true);
    expect(mockP2p.stopDiscoveringPeers).toHaveBeenCalledTimes(1);
    expect(mockP2p.removeGroup).toHaveBeenCalledTimes(1);
    expect(mesh.getPeers()).toEqual([]);

    // Другая личность.
    mockProfileKey = 2;
    mockP2p.getAvailablePeers.mockResolvedValueOnce(peers('new-peer'));
    await m.initLongRangeTransport();
    expect(getWiFiMeshTransport()).toBe(mesh);
    expect(mesh.getPeers().map((p) => p.did)).toEqual(['did:p2p:new-peer']);
    expect(mockSyncs[1].detected).toEqual(['did:p2p:new-peer']);
    // Старая синхронизация о новом узле не узнала.
    expect(mockSyncs[0].detected).toEqual(['did:p2p:old-peer']);
    await expect(mockSyncs[1].getMyDid?.()).resolves.toBe('did:key:profile-2');
    await expect(mockRelays[1].getMyDid()).resolves.toBe('did:key:profile-2');
    expect(mockP2p.createGroup).toHaveBeenCalledTimes(2);

    // Разбор второго цикла и повторный разбор.
    await m.shutdownLongRangeTransport();
    await m.shutdownLongRangeTransport();
    expect(mockP2p.stopDiscoveringPeers).toHaveBeenCalledTimes(2);
    expect(mockP2p.removeGroup).toHaveBeenCalledTimes(2);
    expect(mesh.getPeers()).toEqual([]);
  });
});
