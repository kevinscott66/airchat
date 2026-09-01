/**
 * Проверка сервера-ретранслятора перед тем, как на него переключиться (v4.32.330).
 *
 * Ошибиться в адресе легко — опечатка в домене, забытый порт, прокси, который
 * отдаёт HTML вместо ntfy. Без проверки это выясняется молчаливо: сообщения
 * перестают доходить, а приложение выглядит работающим. Поэтому адрес
 * проверяется до сохранения, и человеку показывается, что именно не так.
 *
 * У ntfy есть ровно для этого GET /v1/health → {"healthy":true}. Ответ читаем
 * с ограничением по размеру: по адресу может стоять что угодно, включая
 * бесконечный поток.
 */
import { log } from '../../logger';

export type RelayProbeResult =
  | { ok: true; detail: string }
  | { ok: false; error: string };

/** Сколько ждём ответа. Столько же, сколько отведено на отправку конверта. */
const PROBE_TIMEOUT_MS = 8_000;
/** Тело /v1/health — это два десятка байт. Всё, что длиннее, — не ntfy. */
const MAX_BODY_CHARS = 4_096;

/**
 * Спрашивает сервер, жив ли он.
 *
 * Отрицательный ответ — не всегда «сервера нет»: за адресом может стоять
 * веб-страница или чужой сервис, и это тоже стоит сказать словами, а не
 * «ошибка сети».
 */
export async function probeRelay(relayBase: string): Promise<RelayProbeResult> {
  const url = `${relayBase}/v1/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 404 — самый частый случай: адрес открывается, но ntfy там нет.
      return {
        ok: false,
        error:
          res.status === 404
            ? 'Сервер отвечает, но это не ntfy: нет /v1/health'
            : `Сервер ответил ошибкой ${res.status}`,
      };
    }
    const body = (await res.text()).slice(0, MAX_BODY_CHARS);
    let healthy: unknown;
    try {
      healthy = (JSON.parse(body) as { healthy?: unknown }).healthy;
    } catch {
      return { ok: false, error: 'Ответ не похож на ntfy: вернулся не JSON' };
    }
    if (healthy !== true) return { ok: false, error: 'Сервер отвечает, но сообщает о неполадке' };
    return { ok: true, detail: 'Сервер отвечает' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('relay_probe_failed', { err: msg });
    return {
      ok: false,
      error: controller.signal.aborted ? 'Сервер не ответил за 8 секунд' : 'Не удалось связаться с сервером',
    };
  } finally {
    clearTimeout(timeout);
  }
}
