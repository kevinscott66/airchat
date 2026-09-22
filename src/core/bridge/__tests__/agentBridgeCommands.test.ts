/**
 * Что мост отвечает на команды (v4.32.723).
 *
 * Главное здесь — различение «на этой платформе ядра OpenFlux нет» и «туннель
 * выключен». Агент принимает по этому ответу разные решения: в первом случае
 * просить включить туннель бессмысленно навсегда, во втором — осмысленно
 * прямо сейчас. Свести оба к «выключено» значит заставить агента бесконечно
 * долбиться в стену.
 */
let mockOpenFluxAvailable = true;
jest.mock('../../../ui/platformCapabilities', () => ({
  get OPENFLUX_AVAILABLE() {
    return mockOpenFluxAvailable;
  },
}));

let mockRunning = false;
const mockRetry = jest.fn(async () => 'on');
const mockStop = jest.fn(async () => {});
jest.mock('../../vpn/openFluxController', () => ({
  getOpenFluxRunning: jest.fn(async () => mockRunning),
  getOpenFluxSocksAddr: jest.fn(async () => (mockRunning ? '127.0.0.1:10808' : null)),
  retryOpenFlux: (c: unknown) => mockRetry(c as never),
  stopOpenFlux: () => mockStop(),
}));

let mockConfig: Record<string, unknown> = {};
jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => mockConfig),
  saveConfigOverride: jest.fn(async (patch: Record<string, unknown>) => {
    mockConfig = { ...mockConfig, ...patch };
    return mockConfig;
  }),
}));

const mockRestart = jest.fn(async () => {});
jest.mock('../../transport/internet/restartInternetTransport', () => ({
  restartInternetTransport: () => mockRestart(),
}));

const mockKv: Record<string, string> = {};
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv[k] ?? null),
  kvSet: jest.fn(async (k: string, v: string) => {
    mockKv[k] = v;
  }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { CONFIG_SECTIONS, KNOWN_COMMANDS, parseCommand, runBridgeCommand } from '../agentBridgeCommands';

beforeEach(() => {
  mockOpenFluxAvailable = true;
  mockRunning = false;
  mockConfig = { openflux: { enabled: false, docUrl: 'https://example.invalid/doc' } };
  mockRetry.mockClear();
  mockStop.mockClear();
  mockRestart.mockClear();
  for (const k of Object.keys(mockKv)) delete mockKv[k];
});

describe('мост: «недоступно» против «выключено»', () => {
  it('на платформе без ядра отвечает unsupported, а не off', async () => {
    mockOpenFluxAvailable = false;
    const res = await runBridgeCommand({ cmd: 'openflux.status' });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { state: string }).state).toBe('unsupported');
  });

  it('на платформе с ядром и погашенным туннелем отвечает off', async () => {
    const res = await runBridgeCommand({ cmd: 'openflux.status' });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { state: string }).state).toBe('off');
  });

  it('без ссылки на документ отвечает unconfigured', async () => {
    mockConfig = { openflux: { enabled: true, docUrl: '' } };
    const res = await runBridgeCommand({ cmd: 'openflux.status' });
    if (res.ok) expect((res.result as { state: string }).state).toBe('unconfigured');
  });

  it('отказывает включить туннель там, где ядра нет, называя причину', async () => {
    mockOpenFluxAvailable = false;
    const res = await runBridgeCommand({ cmd: 'openflux.enable' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('unsupported');
      expect(res.message).toMatch(/нет ядра OpenFlux/);
    }
    expect(mockRetry).not.toHaveBeenCalled();
  });

  it('whoami сообщает доступность ядра отдельно от состояния туннеля', async () => {
    mockOpenFluxAvailable = false;
    const res = await runBridgeCommand({ cmd: 'whoami' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { openFlux: string; openFluxState: string; appVersion: string };
      expect(r.openFlux).toBe('unsupported');
      expect(r.openFluxState).toBe('unsupported');
      expect(typeof r.appVersion).toBe('string');
    }
  });
});

describe('мост: переключение туннеля', () => {
  it('включение пишет флаг до попытки и перезапускает транспорт', async () => {
    mockRetry.mockImplementationOnce(async () => {
      mockRunning = true;
      return 'on';
    });
    const res = await runBridgeCommand({ cmd: 'openflux.enable' });
    expect(res.ok).toBe(true);
    // Порядок важен: retryOpenFlux отказывается поднимать туннель,
    // выключенный в конфиге.
    expect((mockConfig.openflux as { enabled: boolean }).enabled).toBe(true);
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it('выключение гасит туннель и тоже перезапускает транспорт', async () => {
    const res = await runBridgeCommand({ cmd: 'openflux.disable' });
    expect(res.ok).toBe(true);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect((mockConfig.openflux as { enabled: boolean }).enabled).toBe(false);
    // Иначе главный канал остался бы в уже погашенном SOCKS5.
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });
});

describe('мост: конфиг', () => {
  it('отдаёт только разрешённые разделы', async () => {
    mockConfig = {
      openflux: { enabled: false },
      internet: { enabled: true },
      publicServices: { token: 'секрет' },
    };
    const res = await runBridgeCommand({ cmd: 'config.get' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.keys(res.result as object).sort()).toEqual(['internet', 'openflux']);
      expect(JSON.stringify(res.result)).not.toContain('секрет');
    }
  });

  it('отказывается править раздел вне списка', async () => {
    const res = await runBridgeCommand({ cmd: 'config.set', arg: { publicServices: {} } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('section_not_allowed');
      expect(res.message).toContain('publicServices');
    }
  });

  it('перезапускает транспорт только тогда, когда менялся путь трафика', async () => {
    await runBridgeCommand({ cmd: 'config.set', arg: { lan: { enabled: true } } });
    expect(mockRestart).not.toHaveBeenCalled();
    await runBridgeCommand({ cmd: 'config.set', arg: { internet: { enabled: true } } });
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it('список разделов не пуст и не содержит хранилищ токенов', () => {
    expect(CONFIG_SECTIONS.length).toBeGreaterThan(0);
    expect(CONFIG_SECTIONS as readonly string[]).not.toContain('publicServices');
    expect(CONFIG_SECTIONS as readonly string[]).not.toContain('whitelist');
  });
});

describe('мост: настройки устройства', () => {
  it('читает и пишет разрешённые ключи', async () => {
    const set = await runBridgeCommand({
      cmd: 'settings.set',
      arg: { notify_dm: 'false', app_theme_mode: 'dark' },
    });
    expect(set.ok).toBe(true);
    expect(mockKv.notify_dm).toBe('false');
    const got = await runBridgeCommand({ cmd: 'settings.get' });
    if (got.ok) expect((got.result as Record<string, string | null>).notify_dm).toBe('false');
  });

  it('честно предупреждает, что оформление подхватится при перезапуске', async () => {
    const res = await runBridgeCommand({ cmd: 'settings.set', arg: { app_font_size: 'large' } });
    if (res.ok) expect((res.result as { note?: string }).note).toMatch(/следующем запуске/);
  });

  it('отказывается писать ключ вне списка', async () => {
    const res = await runBridgeCommand({ cmd: 'settings.set', arg: { seed_phrase: 'нет' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('key_not_allowed');
    expect(mockKv.seed_phrase).toBeUndefined();
  });
});

describe('мост: отказ вместо молчания', () => {
  it('на незнакомую команду отвечает отказом и перечисляет, что умеет', async () => {
    const res = await runBridgeCommand({ cmd: 'messages.send', arg: { to: 'кто-то' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('unknown_command');
      expect(res.message).toContain('whoami');
    }
  });

  it('отправки сообщений в мосте нет намеренно', () => {
    expect(KNOWN_COMMANDS.some((c) => c.startsWith('message'))).toBe(false);
    expect(KNOWN_COMMANDS.some((c) => c.startsWith('chat'))).toBe(false);
  });

  it('не принимает за команду что попало', () => {
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand([{ cmd: 'whoami' }])).toBeNull();
    expect(parseCommand({ cmd: 123 })).toBeNull();
    expect(parseCommand({ cmd: 'whoami' })).toEqual({ cmd: 'whoami', arg: undefined });
  });
});
