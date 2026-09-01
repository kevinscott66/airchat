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
let mockHandlerClears = 0;
/** Задвижка, на которой можно подвесить подъём посреди startAccessPoint. */
const mockGate: { wanted: boolean; release: (() => void) | null } = { wanted: false, release: null };
let mockFailStart = false;

const mockWifi = {
  startAccessPoint: async () => {
    mockStarts += 1;
    if (mockFailStart) throw new Error('нет Wi-Fi Direct');
    if (mockGate.wanted) {
      await new Promise<void>((resolve) => {
        mockGate.release = resolve;
      });
    }
    return true;
  },
  scanAndConnect: async () => undefined,
  onDeviceFound: (cb: (d: { did: string; transports: string[] }) => void) => {
    mockHandler = cb;
  },
  clearDeviceFoundHandler: () => {
    mockHandlerClears += 1;
    mockHandler = undefined;
  },
};

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
    async onDeviceDetected(): Promise<void> {}
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
  mockHandlerClears = 0;
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

describe('разбор', () => {
  it('снимает обработчик и разбирает ретрансляцию', async () => {
    const m = freshModule();
    await m.initLongRangeTransport();
    await m.shutdownLongRangeTransport();
    expect(mockDisposes).toBe(1);
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
    expect(mockHandlerClears).toBe(0);
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
