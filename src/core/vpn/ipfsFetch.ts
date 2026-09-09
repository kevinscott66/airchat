import { Buffer } from 'buffer';
import { Platform } from 'react-native';
import AirChatVpn from 'airchat-vpn';
import { loadConfig } from '../config';

// v4.32.221 (Paranoid HIGH-2): VPN must tunnel ALL non-local HTTP/S, not
// just IPFS gateways. Previous whitelist only routed 7 IPFS domains, so
// ntfy.sh (the sole online DM transport), Firebase/FCM, signaling, and any
// future endpoint leaked the real client IP while the user saw "VPN: ON".
// Now we invert: route everything except private/loopback/mDNS addresses.
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  // IPv4 loopback / RFC1918 / link-local
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const a = Number(m4[1]), b = Number(m4[2]);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 loopback / unique-local / link-local.
  // v4.32.224 (Paranoid follow-up): previous check `h.startsWith('fc')` matched
  // *any* hostname starting with "fc" (e.g. fcm.googleapis.com) and routed it
  // DIRECT, leaking the real IP for Firebase Cloud Messaging even with VPN on.
  // Now gate strictly on IPv6-literal form before doing prefix checks.
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  const isIPv6Literal = bare.includes(':') && /^[0-9a-f:]+$/i.test(bare);
  if (isIPv6Literal) {
    if (bare === '::1') return true;
    if (/^fe80:/i.test(bare)) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true;
  }
  return false;
}

/**
 * Маршрутизация известного HTTP(S)-трафика приложения через локальный SOCKS.
 * Это не системный VPN: сокеты сторонних библиотек и трафик устройства этот
 * модуль перехватить не может.
 */
export async function shouldRouteUrlThroughVpn(url: string): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = AirChatVpn;
  if (!mod) return false;
  try {
    const cfg = await loadConfig();
    if (!cfg.vpn?.enabled || cfg.vpn.routeHttp === false) return false;
    if (!(await mod.isRunning())) return false;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !isPrivateOrLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

export async function fetchWithEmbeddedVpnIfNeeded(url: string, init?: RequestInit): Promise<Response> {
  const use = await shouldRouteUrlThroughVpn(url);
  const mod = AirChatVpn;
  if (!use || !mod) {
    return fetch(url, init);
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  // The native helper supports GET and a dedicated multipart upload only.
  // Never fall through to React Native's fetch for other methods: it ignores
  // the SOCKS proxy and would reveal the user's IP while the channel is on.
  // A real solution for arbitrary requests needs Android VpnService +
  // tun2socks; until then fail closed.
  if (method !== 'GET') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { log } = require('../logger');
      log.warn('vpn_method_blocked', { method, host: (() => { try { return new URL(url).hostname; } catch { return '?'; } })() });
    } catch {
      /* logger import optional at early-init paths */
    }
    return new Response(new Uint8Array(0), { status: 503, statusText: 'VPN cannot proxy this request method' });
  }

  const r = await mod.fetchGet(url, false);
  // v4.32.203 (Round-33 #1): cap VPN-routed response body before base64 decode.
  // A hostile gateway can otherwise return a multi-MB body and OOM the heap
  // before `new Response(buf)` yields. 50MB raw ≈ ~67M base64 chars.
  if (typeof r.bodyBase64 !== 'string' || r.bodyBase64.length > 67 * 1024 * 1024) {
    return new Response(new Uint8Array(0), { status: 502, statusText: 'Oversize' });
  }
  const buf = Uint8Array.from(Buffer.from(r.bodyBase64, 'base64'));
  return new Response(buf, { status: r.status, statusText: r.ok ? 'OK' : 'Error' });
}

export async function postMultipartFileViaVpn(
  url: string,
  fileUri: string,
  fieldName = 'file'
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const mod = AirChatVpn;
  if (!mod) {
    return { ok: false, status: 0, bodyText: 'no_native_module' };
  }
  return mod.postMultipartFile(url, fileUri, fieldName, false);
}
