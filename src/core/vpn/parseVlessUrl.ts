/**
 * Разбор share-ссылки `vless://` (VLESS + Reality) в поля конфигурации VPN.
 *
 * Провайдеры обычно отдают готовую ссылку вида:
 *   vless://<uuid>@<host>:<port>?encryption=none&flow=xtls-rprx-vision
 *           &security=reality&sni=<sni>&fp=<fp>&pbk=<publicKey>&sid=<shortId>&type=tcp#<label>
 *
 * Парсер ручной (без `new URL`) — кастомная схема `vless://` в некоторых движках
 * трактуется как opaque, а нам нужны userinfo + host:port + query детерминированно
 * и в Node (jest), и в Hermes.
 */

export type ParsedVless = {
  uuid: string;
  address: string;
  port: number;
  flow?: string;
  sni?: string;
  publicKey?: string;
  shortId?: string;
  fingerprint?: string;
  /** Метка после `#` (имя сервера в ссылке), чисто для UI. */
  label?: string;
};

const VLESS_PREFIX = 'vless://';

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Разобрать `host:port`, поддерживая IPv6 в скобках `[::1]:443`. */
function splitHostPort(authority: string): { host: string; port: number } | null {
  let host: string;
  let portStr: string;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return null;
    host = authority.slice(1, close);
    const rest = authority.slice(close + 1); // ожидаем ":port"
    if (!rest.startsWith(':')) return null;
    portStr = rest.slice(1);
  } else {
    const idx = authority.lastIndexOf(':');
    if (idx === -1) return null;
    host = authority.slice(0, idx);
    portStr = authority.slice(idx + 1);
  }
  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Возвращает разобранные поля или `null`, если ссылка не похожа на vless://
 * с обязательными uuid/host/port. Неизвестные query-параметры игнорируются.
 */
export function parseVlessUrl(input: string): ParsedVless | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s.toLowerCase().startsWith(VLESS_PREFIX)) return null;
  s = s.slice(VLESS_PREFIX.length);

  // Отрезаем фрагмент (#label) — это просто человекочитаемое имя.
  let label: string | undefined;
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) {
    label = decode(s.slice(hashIdx + 1));
    s = s.slice(0, hashIdx);
  }

  // userinfo@authority?query
  const atIdx = s.indexOf('@');
  if (atIdx === -1) return null;
  const uuid = decode(s.slice(0, atIdx)).trim();
  if (!uuid) return null;

  let authorityAndQuery = s.slice(atIdx + 1);
  let query = '';
  const qIdx = authorityAndQuery.indexOf('?');
  if (qIdx !== -1) {
    query = authorityAndQuery.slice(qIdx + 1);
    authorityAndQuery = authorityAndQuery.slice(0, qIdx);
  }

  const hp = splitHostPort(authorityAndQuery.trim());
  if (!hp) return null;

  const params: Record<string, string> = {};
  if (query) {
    for (const pair of query.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
      const val = eq === -1 ? '' : decode(pair.slice(eq + 1));
      params[key] = val;
    }
  }

  const out: ParsedVless = {
    uuid,
    address: hp.host,
    port: hp.port,
  };
  if (params.flow) out.flow = params.flow;
  if (params.sni) out.sni = params.sni;
  if (params.pbk) out.publicKey = params.pbk;
  if (params.sid) out.shortId = params.sid;
  if (params.fp) out.fingerprint = params.fp;
  if (label) out.label = label;
  return out;
}
