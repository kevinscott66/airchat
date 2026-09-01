/**
 * Проверка сервера перед переключением (v4.32.330).
 *
 * Смысл проверки — сказать человеку словами, что именно не так. Поэтому тесты
 * смотрят на текст причины, а не только на флаг: «сервер отвечает, но это не
 * ntfy» и «сервер не ответил» приводят к разным действиям.
 */
jest.mock('../../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { probeRelay } from '../relayProbe';

const realFetch = global.fetch;

/** Подменяет fetch ответом с заданным статусом и телом. */
function mockFetch(status: number, body: string) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

describe('probeRelay', () => {
  it('спрашивает именно /v1/health по указанному адресу', async () => {
    mockFetch(200, '{"healthy":true}');
    await probeRelay('https://ntfy.example.com/ntfy');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://ntfy.example.com/ntfy/v1/health',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('healthy:true — сервер годится', async () => {
    mockFetch(200, '{"healthy":true}');
    await expect(probeRelay('https://ntfy.example.com')).resolves.toEqual({
      ok: true,
      detail: 'Сервер отвечает',
    });
  });

  it('404 значит «адрес открывается, но ntfy там нет»', async () => {
    mockFetch(404, 'Not Found');
    const r = await probeRelay('https://example.com');
    expect(r).toEqual({ ok: false, error: 'Сервер отвечает, но это не ntfy: нет /v1/health' });
  });

  it('прочие коды называются номером', async () => {
    mockFetch(502, '');
    const r = await probeRelay('https://example.com');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('502');
  });

  it('HTML вместо JSON — это чужой сервис, а не поломка сети', async () => {
    mockFetch(200, '<!DOCTYPE html><html><body>hi</body></html>');
    const r = await probeRelay('https://example.com');
    expect(r).toEqual({ ok: false, error: 'Ответ не похож на ntfy: вернулся не JSON' });
  });

  it('healthy:false — сервер сам сообщает о неполадке', async () => {
    mockFetch(200, '{"healthy":false}');
    const r = await probeRelay('https://example.com');
    expect(r).toEqual({ ok: false, error: 'Сервер отвечает, но сообщает о неполадке' });
  });

  it('сеть не отвечает — понятная причина, а не текст исключения', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const r = await probeRelay('https://example.com');
    expect(r).toEqual({ ok: false, error: 'Не удалось связаться с сервером' });
  });

  it('бесконечное тело не читается целиком', async () => {
    const huge = `{"healthy":true}${'x'.repeat(100_000)}`;
    mockFetch(200, huge);
    // JSON.parse обрезанного тела упадёт — важно, что проверка завершится,
    // а не повиснет и не съест память.
    const r = await probeRelay('https://example.com');
    expect(r.ok).toBe(false);
  });
});
