/**
 * v4.32.501 — рэтчет: цикл жизни long-range как модуля.
 *
 * Дефект: подъём охранял модульный флаг `didInit`, который выставлялся один раз
 * и не сбрасывался никогда, а разбора не существовало вовсе. После выхода из
 * аккаунта ретрансляция продолжала жить на прежних ключах, а повторный подъём —
 * уже на текущей личности — молча не происходил.
 *
 * Отдельно проверяется наложение: подъём и разбор трогают ОДИН и тот же
 * синглтон Wi-Fi-транспорта, и разбор, начатый посреди подъёма, обязан не снять
 * обработчик у следующего цикла. Поэтому обе половины едут одной цепочкой.
 */
import * as fs from 'fs';
import * as path from 'path';

type Handler = ((d: { did: string; transports: string[] }) => void) | undefined;

let mockStarts = 0;
let mockDisposes = 0;
let mockHandler: Handler;
let mockStops = 0;
/** Что видела синхронизация: найденные устройства и её зависимости. */
const mockDetected: string[] = [];
let mockSyncDeps: Record<string, unknown> | null = null;
/** Какие вызовы транспорта были и в каком порядке. */
const mockCalls: string[] = [];
/** Устройство, о котором скан сообщит синхронно, прямо изнутри scanAndConnect. */
let mockScanFinds: string | null = null;
const mockFlag = { enabled: true };
/** Задвижка, на которой можно подвесить подъём посреди startAccessPoint. */
const mockGate: { wanted: boolean; release: (() => void) | null } = { wanted: false, release: null };
let mockFailStart = false;

const mockWifi = {
  startAccessPoint: async () => {
    mockCalls.push('startAccessPoint');
    mockStarts += 1;
    if (mockFailStart) throw new Error('нет Wi-Fi Direct');
    if (mockGate.wanted) {
      await new Promise<void>((resolve) => {
        mockGate.release = resolve;
      });
    }
    return true;
  },
  scanAndConnect: async () => {
    mockCalls.push('scanAndConnect');
    // Как настоящий транспорт: о найденном узле сообщает по ходу скана.
    if (mockScanFinds) mockHandler?.({ did: mockScanFinds, transports: ['wifi'] });
  },
  onDeviceFound: (cb: (d: { did: string; transports: string[] }) => void) => {
    mockCalls.push('onDeviceFound');
    mockHandler = cb;
  },
  stop: async () => {
    mockCalls.push('stop');
    mockStops += 1;
    mockHandler = undefined;
  },
};

jest.mock('../pipelineFlag', () => ({
  isLongRangePipelineEnabled: () => mockFlag.enabled,
  LONG_RANGE_PIPELINE_ENABLED: false,
}));

const mockRelayInstances: Array<{ disposed: boolean }> = [];

jest.mock('../wifiMesh', () => ({
  getWiFiMeshTransport: () => mockWifi,
  WiFiMeshTransport: class {},
}));

jest.mock('../geographicRouter', () => ({
  GeographicRouter: class {
    async hydrateFromDb(): Promise<void> {}
    async updateMyLocation(): Promise<void> {}
    async findPath(): Promise<unknown[]> {
      return [];
    }
  },
}));

jest.mock('../opportunisticSync', () => ({
  OpportunisticSync: class {
    constructor(deps: Record<string, unknown>) {
      mockSyncDeps = deps;
    }
    async onDeviceDetected(d: { did: string }): Promise<void> {
      mockDetected.push(d.did);
    }
  },
}));

jest.mock('../relayService', () => ({
  RelayService: class {
    private readonly self = { disposed: false };
    constructor() {
      mockRelayInstances.push(this.self);
    }
    async enableRelayMode(): Promise<void> {}
    dispose(): void {
      this.self.disposed = true;
      mockDisposes += 1;
    }
  },
}));

jest.mock('../../../crypto/keyManager', () => ({
  loadKeyPair: async () => ({ publicKey: new Uint8Array(32) }),
}));

jest.mock('../../../identity/did', () => ({
  publicKeyToDidKey: () => 'did:key:test',
}));

jest.mock('../../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Модуль хранит состояние цикла жизни, поэтому берём его заново на каждый тест. */
function freshModule(): typeof import('../index') {
  let mod!: typeof import('../index');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../index') as typeof import('../index');
  });
  return mod;
}

beforeEach(() => {
  mockStarts = 0;
  mockDisposes = 0;
  mockHandler = undefined;
  mockStops = 0;
  mockDetected.length = 0;
  mockSyncDeps = null;
  mockCalls.length = 0;
  mockScanFinds = null;
  mockFlag.enabled = true;
  mockGate.wanted = false;
  mockGate.release = null;
  mockFailStart = false;
  mockRelayInstances.length = 0;
});

describe('подъём', () => {
  it('поднимает транспорт и вешает обработчик найденных устройств', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    expect(mockStarts).toBe(1);
    expect(mockHandler).toBeDefined();
  });

  it('повторный вызов при живом транспорте ничего не поднимает', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    await m.initLongRangeTransport();
    await m.initLongRangeTransport();
    expect(mockStarts).toBe(1);
    expect(mockRelayInstances).toHaveLength(1);
  });

  it('два одновременных вызова не поднимают транспорт дважды', async () => {
    const m = freshModule();
    await Promise.all([m.initLongRangeTransport(), m.initLongRangeTransport()]);
    expect(mockStarts).toBe(1);
  });

  it('сорвавшийся подъём не роняет вызывающего и не запирает цепочку', async () => {
    const m = freshModule();
    mockFailStart = true;
    await expect(m.initLongRangeTransport()).resolves.toBeUndefined();
    mockFailStart = false;
    await m.initLongRangeTransport();
    expect(mockStarts).toBe(2);
    expect(mockHandler).toBeDefined();
  });
});

describe('выключатель конвейера', () => {
  it('при выключенном флаге подъём — no-op: транспорт не трогается', async () => {
    mockFlag.enabled = false;
    const m = freshModule();
    await expect(m.initLongRangeTransport()).resolves.toBeUndefined();
    expect(mockCalls).toEqual([]);
    expect(mockRelayInstances).toHaveLength(0);
    // И разбор при этом ничего не разбирает.
    await m.shutdownLongRangeTransport();
    expect(mockStops).toBe(0);
    expect(mockDisposes).toBe(0);
  });

  it('в проде флаг выключен', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const real = jest.requireActual('../pipelineFlag') as typeof import('../pipelineFlag');
    expect(real.LONG_RANGE_PIPELINE_ENABLED).toBe(false);
    expect(real.isLongRangePipelineEnabled()).toBe(false);
  });
});

describe('порядок подъёма', () => {
  it('обработчик устройств ставится до обнаружения', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    const handlerAt = mockCalls.indexOf('onDeviceFound');
    expect(handlerAt).toBeGreaterThan(-1);
    expect(handlerAt).toBeLessThan(mockCalls.indexOf('startAccessPoint'));
    expect(handlerAt).toBeLessThan(mockCalls.indexOf('scanAndConnect'));
  });

  it('устройство, найденное синхронно во время скана, доходит до синхронизации', async () => {
    mockScanFinds = 'did:p2p:aa:bb';
    const m = freshModule();
    await m.initLongRangeTransport();
    expect(mockDetected).toEqual(['did:p2p:aa:bb']);
  });

  it('синхронизация получает DID текущей личности', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    const getMyDid = mockSyncDeps?.getMyDid as (() => Promise<string>) | undefined;
    expect(typeof getMyDid).toBe('function');
    await expect(getMyDid!()).resolves.toBe('did:key:test');
  });

  it('сорвавшийся посреди подъёма транспорт разбирается, а не висит в эфире', async () => {
    mockFailStart = true;
    const m = freshModule();
    await m.initLongRangeTransport();
    expect(mockStops).toBe(1);
    expect(mockRelayInstances[0].disposed).toBe(true);
    expect(mockHandler).toBeUndefined();
  });
});

describe('разбор', () => {
  it('снимает обработчик, останавливает Wi-Fi Direct и разбирает ретрансляцию', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    await m.shutdownLongRangeTransport();
    expect(mockDisposes).toBe(1);
    expect(mockStops).toBe(1);
    expect(mockHandler).toBeUndefined();
    expect(mockRelayInstances[0].disposed).toBe(true);
  });

  it('после разбора транспорт поднимается заново — уже новым экземпляром', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    await m.shutdownLongRangeTransport();
    await m.initLongRangeTransport();
    expect(mockStarts).toBe(2);
    expect(mockRelayInstances).toHaveLength(2);
    expect(mockRelayInstances[1].disposed).toBe(false);
    expect(mockHandler).toBeDefined();
  });

  it('разбор без подъёма безвреден', async () => {
    const m = freshModule();
    await m.shutdownLongRangeTransport();
    await m.shutdownLongRangeTransport();
    expect(mockDisposes).toBe(0);
    expect(mockStops).toBe(0);
  });

  it('двойной разбор разбирает один раз', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    await m.shutdownLongRangeTransport();
    await m.shutdownLongRangeTransport();
    expect(mockDisposes).toBe(1);
  });
});

describe('наложение подъёма и разбора', () => {
  it('разбор посреди подъёма не снимает обработчик у следующего цикла', async () => {
    const m = freshModule();
    // Первый подъём застревает внутри startAccessPoint.
    mockGate.wanted = true;
    const first = m.initLongRangeTransport();
    for (let i = 0; i < 50 && !mockGate.release; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(mockGate.release).not.toBeNull();
    const stop = m.shutdownLongRangeTransport();
    const second = m.initLongRangeTransport();
    // Второй подъём задвижку уже не ждёт.
    mockGate.wanted = false;
    // Отпускаем застрявший — дальше цепочка обязана доехать по порядку.
    mockGate.release?.();
    await Promise.all([first, stop, second]);
    expect(mockStarts).toBe(2);
    expect(mockDisposes).toBe(1);
    // Разобран именно первый экземпляр, второй жив и обработчик на месте.
    expect(mockRelayInstances[0].disposed).toBe(true);
    expect(mockRelayInstances[1].disposed).toBe(false);
    expect(mockHandler).toBeDefined();
  });

  it('порядок «разбор, потом подъём» оставляет транспорт поднятым', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    const stop = m.shutdownLongRangeTransport();
    const again = m.initLongRangeTransport();
    await Promise.all([stop, again]);
    expect(mockHandler).toBeDefined();
    expect(mockRelayInstances).toHaveLength(2);
    expect(mockRelayInstances[1].disposed).toBe(false);
  });
});

describe('исходники', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'App.tsx'), 'utf8');

  it('несбрасываемого флага подъёма больше нет', () => {
    expect(idx).not.toContain('didInit = true');
    expect(idx).not.toMatch(/^let didInit/m);
  });

  it('подъём и разбор едут одной цепочкой', () => {
    expect(idx.match(/lifecycle = lifecycle\.then\(/g)).toHaveLength(2);
    expect(idx).toContain('export function shutdownLongRangeTransport(): Promise<void>');
  });

  it('экран снимает long-range при смене личности', () => {
    expect(app).toContain('void shutdownLongRangeTransport();');
    const start = app.indexOf('void initLongRangeTransport();');
    expect(start).toBeGreaterThan(-1);
    // Разбор объявлен в возвращаемой уборке того же эффекта.
    const tail = app.slice(start, start + 600);
    expect(tail).toContain('return () => {');
    expect(tail.indexOf('return () => {')).toBeLessThan(tail.indexOf('void shutdownLongRangeTransport();'));
  });
});
