/**
 * v4.32.725: «не удалось выяснить» больше не выдают за «через канал не надо».
 *
 * Дефект. `shouldRouteUrlThroughVpn` держал весь разбор под одним
 * `catch { return false; }`. Отказ нативного вызова `isRunning()` — не выдумка:
 * это обращение к другому процессу, и после восстановления приложения из фона
 * или падения службы оно отклоняется. Результат ложился в `false`, а `false` в
 * `fetchWithEmbeddedVpnIfNeeded` означал обычный fetch.
 *
 * Чем это кончается. Обычный fetch о SOCKS не знает — запрос уходит напрямую и
 * открывает настоящий адрес человека. Ровно про это в самом файле написано
 * «Never fall through to React Native's fetch… until then fail closed»: для
 * неподдерживаемых методов выход закрыт, а для невыясненного состояния канала
 * был открыт. Канал при этом включён, и полоска в интерфейсе говорит
 * «Защищённый канал включён».
 *
 * Развязка. Решение стало из двух значений тремя: прямо, через канал, не знаем.
 * «Не знаем» закрывает выход тем же 503, что и неподдерживаемый метод.
 * Осознанные режимы — канал выключен человеком, канал включён, но не поднялся —
 * как были прямым соединением, так и остались.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('airchat-vpn', () => ({
  isRunning: jest.fn(async () => true),
  fetchGet: jest.fn(async () => ({ ok: true, status: 200, bodyBase64: 'b2s=' })),
  postMultipartFile: jest.fn(),
}));
jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({ vpn: { enabled: true, routeHttp: true } })),
}));
jest.mock('../../logger', () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { fetchWithEmbeddedVpnIfNeeded, shouldRouteUrlThroughVpn, vpnRoutingDecision } from '../ipfsFetch';
import AirChatVpn from 'airchat-vpn';
import { Platform } from 'react-native';
import { loadConfig } from '../../config';

const native = AirChatVpn as unknown as {
  isRunning: jest.Mock;
  fetchGet: jest.Mock;
  postMultipartFile: jest.Mock;
};
const mockLoadConfig = loadConfig as unknown as jest.Mock;
const platform = Platform as unknown as { OS: string };

const URL_PUBLIC = 'https://gateway.example/ipfs/cid';

describe('состояние канала не выяснено — наружу не выпускают (v4.32.725)', () => {
  const realFetch = global.fetch;
  const directFetch = jest.fn(async () => new Response('direct'));

  beforeEach(() => {
    platform.OS = 'android';
    native.isRunning.mockReset().mockResolvedValue(true);
    native.fetchGet.mockReset().mockResolvedValue({ ok: true, status: 200, bodyBase64: 'b2s=' });
    mockLoadConfig.mockReset().mockResolvedValue({ vpn: { enabled: true, routeHttp: true } });
    directFetch.mockClear();
    global.fetch = directFetch as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('нативный вызов отказал — решения нет', async () => {
    native.isRunning.mockRejectedValue(new Error('binder is dead'));

    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('unknown');
  });

  it('нативный вызов отказал — запрос не уходит мимо канала', async () => {
    native.isRunning.mockRejectedValue(new Error('binder is dead'));

    const res = await fetchWithEmbeddedVpnIfNeeded(URL_PUBLIC);

    expect(res.status).toBe(503);
    expect(directFetch).not.toHaveBeenCalled();
    expect(native.fetchGet).not.toHaveBeenCalled();
  });

  it('настройки не прочитались — запрос тоже не уходит мимо канала', async () => {
    mockLoadConfig.mockRejectedValue(new Error('config read failed'));

    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('unknown');
    const res = await fetchWithEmbeddedVpnIfNeeded(URL_PUBLIC);
    expect(res.status).toBe(503);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('невыясненное состояние закрывает и POST — тот же 503, без прямого запроса', async () => {
    native.isRunning.mockRejectedValue(new Error('binder is dead'));

    const res = await fetchWithEmbeddedVpnIfNeeded(URL_PUBLIC, { method: 'POST', body: 'x' });

    expect(res.status).toBe(503);
    expect(directFetch).not.toHaveBeenCalled();
  });
});

describe('осознанные режимы остались прямым соединением', () => {
  const realFetch = global.fetch;
  const directFetch = jest.fn(async () => new Response('direct'));

  beforeEach(() => {
    platform.OS = 'android';
    native.isRunning.mockReset().mockResolvedValue(true);
    native.fetchGet.mockReset().mockResolvedValue({ ok: true, status: 200, bodyBase64: 'b2s=' });
    mockLoadConfig.mockReset().mockResolvedValue({ vpn: { enabled: true, routeHttp: true } });
    directFetch.mockClear();
    global.fetch = directFetch as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
    platform.OS = 'android';
  });

  it('канал выключен человеком', async () => {
    mockLoadConfig.mockResolvedValue({ vpn: { enabled: false } });

    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('direct');
    await fetchWithEmbeddedVpnIfNeeded(URL_PUBLIC);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it('маршрут HTTP отключён отдельной настройкой', async () => {
    mockLoadConfig.mockResolvedValue({ vpn: { enabled: true, routeHttp: false } });

    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('direct');
  });

  it('канал включён, но не поднялся — про это сказано в интерфейсе отдельно', async () => {
    native.isRunning.mockResolvedValue(false);

    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('direct');
    await fetchWithEmbeddedVpnIfNeeded(URL_PUBLIC);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it('не Android — канала нет вовсе, и 503 неоткуда взяться', async () => {
    platform.OS = 'ios';
    native.isRunning.mockRejectedValue(new Error('binder is dead'));

    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('direct');
    await fetchWithEmbeddedVpnIfNeeded(URL_PUBLIC);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it('у нативного модуля нет самого метода — проксировать нечем, это не «не знаем»', async () => {
    (native as unknown as { isRunning: unknown }).isRunning = undefined;

    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('direct');
    await fetchWithEmbeddedVpnIfNeeded(URL_PUBLIC);
    expect(directFetch).toHaveBeenCalledTimes(1);

    (native as unknown as { isRunning: unknown }).isRunning = jest.fn(async () => true);
  });

  it('локальный адрес не отправляют в удалённый канал', async () => {
    await expect(vpnRoutingDecision('http://127.0.0.1:5001/api/v0/add')).resolves.toBe('direct');
  });

  it('публичный хост при поднятом канале идёт через канал', async () => {
    await expect(vpnRoutingDecision(URL_PUBLIC)).resolves.toBe('vpn');
    await expect(shouldRouteUrlThroughVpn(URL_PUBLIC)).resolves.toBe(true);
  });
});
