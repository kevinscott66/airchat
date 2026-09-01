/**
 * v4.32.550 — отказ отправлять обязан означать, что дороги правда нет.
 *
 * Дефект был двойной. Wi-Fi без выхода наружу (роутер без аплинка, гостиница,
 * офис за упавшим провайдером) выглядел как полное отсутствие связи, хотя LAN —
 * транспорт первого приоритета и доставил бы сообщение напрямую. И отдельно:
 * провалившийся опрос сети записывался как «интернета нет», хотя это незнание,
 * а не факт, — человек читал «Нет интернет-соединения» при работающей сети.
 */
import fs from 'fs';
import path from 'path';

import {
  NO_WRITE_PATH_TEXT,
  classifyReachability,
  decideWritePath,
  isDefiniteNoInternet,
  isWriteBlocked,
  type NetworkProbe,
  type WriteReachability,
} from '../writePathDecision';

const mockGetNetworkStateAsync = jest.fn();

jest.mock('expo-network', () => ({
  getNetworkStateAsync: (): unknown => mockGetNetworkStateAsync(),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { checkOnlineWrite, requireOnlineWrite } from '../cachePolicy';

const ALL: WriteReachability[] = ['probe-failed', 'unknown', 'disconnected', 'no-internet', 'online'];

function probe(over: Partial<NetworkProbe> = {}): NetworkProbe {
  return { failed: false, connected: true, internetReachable: true, ...over };
}

const MODULE = fs.readFileSync(path.join(__dirname, '..', 'writePathDecision.ts'), 'utf8');
const POLICY = fs.readFileSync(path.join(__dirname, '..', 'cachePolicy.ts'), 'utf8');
const MESSAGING = fs.readFileSync(
  path.join(__dirname, '..', '..', 'social', 'messaging.ts'),
  'utf8'
);
const ROUTER = fs.readFileSync(
  path.join(__dirname, '..', '..', 'transport', 'multiTransport.ts'),
  'utf8'
);

describe('разбор ответа системы про сеть', () => {
  it('провалившийся опрос — отдельный случай, а не «сети нет»', () => {
    expect(classifyReachability(probe({ failed: true }))).toBe('probe-failed');
    // Даже если в упавшем опросе что-то осталось заполнено — провал главнее.
    expect(classifyReachability({ failed: true, connected: false, internetReachable: false }))
      .toBe('probe-failed');
  });

  it('«не знаю» системы не выдаётся за «нет»', () => {
    expect(classifyReachability(probe({ connected: null, internetReachable: null }))).toBe('unknown');
  });

  it('явные ответы разбираются каждый по-своему', () => {
    expect(classifyReachability(probe({ connected: false }))).toBe('disconnected');
    expect(classifyReachability(probe({ internetReachable: false }))).toBe('no-internet');
    expect(classifyReachability(probe())).toBe('online');
  });

  it('подключены, но про интернет система молчит — это не отказ', () => {
    expect(classifyReachability(probe({ internetReachable: null }))).toBe('online');
  });

  it('фактом отсутствия сети считаются только два случая из пяти', () => {
    expect(ALL.filter(isDefiniteNoInternet)).toEqual(['disconnected', 'no-internet']);
  });
});

describe('решение об отправке', () => {
  it('незнание отправку не отменяет — пусть провалится честно', () => {
    for (const reach of ['probe-failed', 'unknown', 'online'] as WriteReachability[]) {
      expect(decideWritePath(reach, false)).toBe('allow');
      expect(decideWritePath(reach, true)).toBe('allow');
    }
  });

  it('Wi-Fi без интернета, но с найденным пиром — отправляем по локальной сети', () => {
    // Это и есть починка: раньше здесь был отказ.
    expect(decideWritePath('no-internet', true)).toBe('allow-local-only');
    expect(decideWritePath('disconnected', true)).toBe('allow-local-only');
  });

  it('отказ — только когда нет ни интернета, ни локального пути', () => {
    expect(decideWritePath('no-internet', false)).toBe('block-offline');
    expect(decideWritePath('disconnected', false)).toBe('block-offline');
  });

  it('блокирует ровно одно решение из трёх', () => {
    const paths = ALL.flatMap((r) => [decideWritePath(r, true), decideWritePath(r, false)]);
    expect(paths.filter(isWriteBlocked).length).toBe(2);
    expect(isWriteBlocked('allow')).toBe(false);
    expect(isWriteBlocked('allow-local-only')).toBe(false);
    expect(isWriteBlocked('block-offline')).toBe(true);
  });

  it('локальный путь только разрешает и никогда не запрещает', () => {
    for (const reach of ALL) {
      const withLocal = decideWritePath(reach, true);
      const withoutLocal = decideWritePath(reach, false);
      expect(isWriteBlocked(withLocal)).toBe(false);
      if (isWriteBlocked(withoutLocal)) expect(withLocal).toBe('allow-local-only');
      else expect(withLocal).toBe(withoutLocal);
    }
  });

  it('текст отказа говорит про обе дороги, а не только про интернет', () => {
    expect(NO_WRITE_PATH_TEXT).toContain('интернета');
    expect(NO_WRITE_PATH_TEXT).toContain('поблизости');
  });
});

describe('политика записи поверх реального опроса сети', () => {
  beforeEach(() => {
    mockGetNetworkStateAsync.mockReset();
  });

  it('обычная сеть — отправляем', async () => {
    mockGetNetworkStateAsync.mockResolvedValue({ isConnected: true, isInternetReachable: true });
    await expect(checkOnlineWrite()).resolves.toEqual({
      ok: true,
      path: 'allow',
      reachability: 'online',
    });
    await expect(requireOnlineWrite()).resolves.toBeUndefined();
  });

  it('упавший опрос сети НЕ отменяет отправку', async () => {
    mockGetNetworkStateAsync.mockRejectedValue(new Error('native module unavailable'));
    const result = await checkOnlineWrite();
    expect(result.ok).toBe(true);
    expect(result.reachability).toBe('probe-failed');
    // Раньше здесь летела ошибка «Нет интернет-соединения» при работающей сети.
    await expect(requireOnlineWrite()).resolves.toBeUndefined();
  });

  it('Wi-Fi без интернета: с локальным пиром отправляем, без него — нет', async () => {
    mockGetNetworkStateAsync.mockResolvedValue({ isConnected: true, isInternetReachable: false });
    await expect(checkOnlineWrite(true)).resolves.toEqual({
      ok: true,
      path: 'allow-local-only',
      reachability: 'no-internet',
    });
    await expect(requireOnlineWrite(true)).resolves.toBeUndefined();

    await expect(checkOnlineWrite(false)).resolves.toEqual({
      ok: false,
      reason: 'offline',
      reachability: 'no-internet',
    });
    await expect(requireOnlineWrite(false)).rejects.toThrow(NO_WRITE_PATH_TEXT);
  });

  it('связи нет вовсе — отказ и понятный текст', async () => {
    mockGetNetworkStateAsync.mockResolvedValue({ isConnected: false, isInternetReachable: false });
    await expect(requireOnlineWrite()).rejects.toThrow(NO_WRITE_PATH_TEXT);
  });

  it('локальный путь по умолчанию не предполагается', async () => {
    mockGetNetworkStateAsync.mockResolvedValue({ isConnected: false, isInternetReachable: false });
    const result = await checkOnlineWrite();
    expect(result.ok).toBe(false);
  });

  it('система молчит про isInternetReachable — отправку это не трогает', async () => {
    mockGetNetworkStateAsync.mockResolvedValue({ isConnected: true });
    const result = await checkOnlineWrite();
    expect(result.ok).toBe(true);
    expect(result.reachability).toBe('online');
  });
});

describe('форма исходников', () => {
  it('модуль решения без импортов — проверяется без expo-network', () => {
    expect(MODULE).not.toMatch(/^import\s/m);
    expect(MODULE).not.toMatch(/\brequire\(/);
  });

  it('политика не решает сама, а спрашивает модуль', () => {
    expect(POLICY).toContain("from './writePathDecision'");
    expect(POLICY).toContain('decideWritePath(reachability, localPathAvailable)');
    // Провал опроса больше не превращается в готовый ответ «оффлайн».
    expect(POLICY).not.toContain("catch {\n    return { ok: false, reason: 'offline' };");
    expect(POLICY).toContain("classifyReachability({ failed: true");
  });

  it('отказ попадает в журнал — молчаливых отказов не остаётся', () => {
    expect(POLICY).toContain("log.warn('network_probe_failed'");
    expect(POLICY).toContain("log.info('write_blocked_offline'");
  });

  it('отправка сообщений спрашивает локальный путь к собеседнику', () => {
    // v4.32.555: две из трёх точек перешли на `checkOnlineWrite` — им нужен не
    // отказ броском, а ответ, потому что локальная половина к тому моменту уже
    // выполнена. Локальный путь при этом по-прежнему спрашивают все три.
    expect(
      (MESSAGING.match(/(requireOnlineWrite|checkOnlineWrite)\(await localPathTo\(contactPubB64\)\)/g) ?? [])
        .length
    ).toBe(3);
    expect((MESSAGING.match(/checkOnlineWrite\(await localPathTo\(contactPubB64\)\)/g) ?? []).length).toBe(2);
    expect(MESSAGING).not.toMatch(/requireOnlineWrite\(\)/);
    expect(MESSAGING).toContain('return multiTransportRouter.hasLocalPath(did);');
  });

  it('локальный путь считает маршрутизатор, а не отправка', () => {
    expect(ROUTER).toContain('async hasLocalPath(targetDid: string): Promise<boolean> {');
    expect(ROUTER).toContain('if (await this.canReachLan(targetDid)) return true;');
    expect(ROUTER).toContain('return await this.canReachWiFiDirect(targetDid);');
  });
});
