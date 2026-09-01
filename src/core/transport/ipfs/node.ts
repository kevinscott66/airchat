import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { create, type KuboRPCClient } from 'kubo-rpc-client';
import { loadConfig } from '../../config';
import {
  fetchWithEmbeddedVpnIfNeeded,
  postMultipartFileViaVpn,
  shouldRouteUrlThroughVpn,
} from '../../vpn/ipfsFetch';
import { log } from '../../logger';
import { getHeliaUnixfs, isIpfsEnabled } from './heliaNode';
import { cachePut } from './blockstore';
import { getWorkingAddUrl } from './healthCheck';

let client: KuboRPCClient | null = null;
let lastUrl: string | null = null;

export async function getIpfsClient(): Promise<KuboRPCClient | null> {
  // v4.32.19: kill switch — на mobile Kubo RPC всегда смотрит на 127.0.0.1:5001
  // где нет daemon'а, потому любой вызов висит до timeout (8s). Сразу null.
  if (!isIpfsEnabled()) return null;
  try {
    const cfg = await loadConfig();
    if (client && lastUrl === cfg.ipfs.apiUrl) return client;
    client = create({ url: cfg.ipfs.apiUrl, timeout: 8000 });
    lastUrl = cfg.ipfs.apiUrl;
    return client;
  } catch (e) {
    log.warn('ipfs_client_init_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export function resetIpfsClient(): void {
  client = null;
  lastUrl = null;
}

/** Kubo на эмуляторе часто недоступен без демона на хосте — даём запас по времени. */
const IPFS_ADD_TIMEOUT_MS = 12000;
/** Fallback через in-process Helia (bootstrap из config), если RPC не отвечает. */
const HELIA_ADD_FALLBACK_TIMEOUT_MS = 30000;
const HTTP_ADD_TIMEOUT_MS = 60000;
const HTTP_CAT_TIMEOUT_MS = 20000;

function uniqueUrls(list: string[]): string[] {
  return Array.from(new Set(list.map((u) => u.trim()).filter(Boolean)));
}

// v4.32.193 (Round-23 #1): strict CIDv0/CIDv1 validation. A malicious Kubo
// gateway can respond with Hash="Z".repeat(1M) — we'd cache it and emit it
// as a "CID" in chat messages. Only accept real base58btc CIDv0 (Qm…) or
// base32 CIDv1 (b…), length 46..128.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,127})$/;
function parseKuboAddResponseBody(text: string): string | null {
  const lines = text.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as { Hash?: string };
      if (j.Hash && typeof j.Hash === 'string' && j.Hash.length <= 128 && CID_RE.test(j.Hash)) return j.Hash;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function gatewayFetchUrlForCid(base: string, cid: string): string {
  const b = base.replace(/\/$/, '');
  if (b.endsWith('/ipfs')) return `${b}/${cid}`;
  return `${b}/ipfs/${cid}`;
}

/**
 * HTTP POST в Kubo-совместимый /api/v0/add (локальный узел, Pinata, Infura и т.д. — по addApiUrls в конфиге).
 */
async function addViaHttpApiFallback(data: Uint8Array): Promise<string | null> {
  const cfg = await loadConfig();
  const defaults = [
    'https://ipfs.io/api/v0/add',
    'https://cloudflare-ipfs.com/api/v0/add',
    'https://dweb.link/api/v0/add',
  ];
  const primaries = uniqueUrls(cfg.ipfs.addApiUrls ?? []);
  const retries = Math.max(1, cfg.ipfs.retries ?? 2);
  const timeoutMs = Math.max(1000, cfg.ipfs.timeoutMs ?? HTTP_ADD_TIMEOUT_MS);
  const usePrimaryFirst = cfg.ipfs.usePrimaryFirst !== false;
  const urls = usePrimaryFirst
    ? uniqueUrls([...primaries, ...defaults])
    : uniqueUrls([...defaults, ...primaries]);
  if (urls.length === 0) return null;

  const cachePath = `${FileSystem.cacheDirectory ?? ''}ipfs_http_add_${Date.now()}.bin`;
  try {
    await FileSystem.writeAsStringAsync(cachePath, Buffer.from(data).toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (e) {
    log.warn('ipfs_http_add_tempfile_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }

  const uri = cachePath.startsWith('file') ? cachePath : `file://${cachePath}`;
  try {
    const healthyPrimary = await getWorkingAddUrl(primaries, Math.min(timeoutMs, 3000));
    const ordered = healthyPrimary ? [healthyPrimary, ...urls.filter((u) => u !== healthyPrimary)] : urls;
    for (const url of ordered) {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
        if (await shouldRouteUrlThroughVpn(url)) {
          const vpnRes = await postMultipartFileViaVpn(url, uri, 'file');
          if (vpnRes.ok) {
            const hash = parseKuboAddResponseBody(vpnRes.bodyText);
            if (hash) {
              await cachePut(hash, data);
              log.info('ipfs_add_via_http', { urlPrefix: url.slice(0, 40), cidPrefix: hash.slice(0, 12) });
              return hash;
            }
          }
          log.warn('ipfs_http_add_vpn_failed', { url, status: vpnRes.status, attempt: attempt + 1 });
          // Не падаем на обычный fetch — иначе трафик пойдёт не через VPN.
          continue;
        }
        const form = new FormData();
        form.append('file', {
          uri,
          name: 'data.bin',
          type: 'application/octet-stream',
        } as unknown as Blob);
        const res = await Promise.race([
          fetchWithEmbeddedVpnIfNeeded(url, { method: 'POST', body: form }),
          new Promise<Response>((_, rej) => {
            setTimeout(() => rej(new Error('http_add_timeout')), timeoutMs);
          }),
        ]);
        // v4.32.193 (Round-23 #2): cap response body before await res.text() —
        // a hostile add endpoint can stream unbounded JSON-lines and OOM the heap.
        const cl = res.headers.get('content-length');
        if (cl && Number(cl) > 1 * 1024 * 1024) {
          log.warn('ipfs_http_add_oversize_drop', { url, contentLength: cl });
          continue;
        }
        const raw = await res.text();
        if (raw.length > 1 * 1024 * 1024) {
          log.warn('ipfs_http_add_oversize_drop_post', { url, bytes: raw.length });
          continue;
        }
        if (!res.ok) {
          log.warn('ipfs_http_add_http_status', { url, status: res.status, attempt: attempt + 1 });
          continue;
        }
        const hash = parseKuboAddResponseBody(raw);
        if (hash) {
          await cachePut(hash, data);
          log.info('ipfs_add_via_http', { urlPrefix: url.slice(0, 40), cidPrefix: hash.slice(0, 12) });
          return hash;
        }
        } catch (e) {
          log.warn('ipfs_http_add_url_failed', {
            url,
            attempt: attempt + 1,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  } finally {
    try {
      await FileSystem.deleteAsync(cachePath, { idempotent: true });
    } catch {
      /* noop */
    }
  }
  return null;
}

async function catViaHttpGateways(cid: string): Promise<Uint8Array | null> {
  const cfg = await loadConfig();
  const timeoutMs = Math.max(1000, cfg.ipfs.timeoutMs ?? HTTP_CAT_TIMEOUT_MS);
  const bases = [...(cfg.ipfs.gatewayUrls ?? []), cfg.ipfs.gatewayUrl, ...(cfg.ipfs.fallbackGateways ?? [])]
    .map((u) => u.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const base of bases) {
    const url = gatewayFetchUrlForCid(base, cid);
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await Promise.race([
        fetchWithEmbeddedVpnIfNeeded(url),
        new Promise<Response>((_, rej) => {
          setTimeout(() => rej(new Error('http_cat_timeout')), timeoutMs);
        }),
      ]);
      if (!res.ok) continue;
      // v4.32.192 (Round-22 #3): reject oversized responses before reading
      // entire body into JS. A malicious gateway can stream hundreds of MB.
      const IPFS_MAX_BYTES = 50 * 1024 * 1024;
      const cl = res.headers.get('content-length');
      if (cl && Number(cl) > IPFS_MAX_BYTES) {
        log.warn('ipfs_cat_oversize_drop', { cidPrefix: cid.slice(0, 12), contentLength: cl });
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > IPFS_MAX_BYTES) {
        log.warn('ipfs_cat_oversize_drop_post', { cidPrefix: cid.slice(0, 12), bytes: buf.byteLength });
        continue;
      }
      await cachePut(cid, buf);
      log.info('ipfs_cat_via_http_gateway', { cidPrefix: cid.slice(0, 12) });
      return buf;
    } catch (e) {
      log.warn('ipfs_cat_http_gateway_failed', {
        err: e instanceof Error ? e.message : String(e),
        url: url.slice(0, 64),
      });
    }
  }
  return null;
}

async function addViaKubo(data: Uint8Array): Promise<string | null> {
  const cfg = await loadConfig();
  const retries = Math.max(1, cfg.ipfs.retries ?? 2);
  const timeoutMs = Math.max(1000, cfg.ipfs.timeoutMs ?? IPFS_ADD_TIMEOUT_MS);
  const urls = uniqueUrls(cfg.ipfs.addApiUrls ?? []);
  if (urls.length === 0) return null;
  const healthy = await getWorkingAddUrl(urls, Math.min(timeoutMs, 3000));
  const ordered = healthy ? [healthy, ...urls.filter((u) => u !== healthy)] : urls;
  const body = new Uint8Array(data);
  for (const url of ordered) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await Promise.race([
          fetchWithEmbeddedVpnIfNeeded(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body,
          }),
          new Promise<Response>((_, rej) => {
            setTimeout(() => rej(new Error(`kubo_add_timeout_${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        // v4.32.193 (Round-23 #2): cap Kubo add response before text().
        const cl = res.headers.get('content-length');
        if (cl && Number(cl) > 1 * 1024 * 1024) {
          log.warn('ipfs_add_kubo_oversize_drop', { url, contentLength: cl });
          continue;
        }
        const raw = await res.text();
        if (raw.length > 1 * 1024 * 1024) {
          log.warn('ipfs_add_kubo_oversize_drop_post', { url, bytes: raw.length });
          continue;
        }
        if (!res.ok) {
          log.warn('ipfs_add_kubo_http_status', { url, status: res.status, attempt: attempt + 1 });
          continue;
        }
        const hash = parseKuboAddResponseBody(raw);
        if (hash) {
          await cachePut(hash, data);
          log.info('ipfs_add_via_kubo', { cidPrefix: hash.slice(0, 12), urlPrefix: url.slice(0, 40) });
          return hash;
        }
      } catch (e) {
        log.warn('ipfs_add_kubo_failed', {
          url,
          attempt: attempt + 1,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return null;
}

async function addViaHeliaFallback(data: Uint8Array): Promise<string | null> {
  try {
    const fs = await getHeliaUnixfs();
    if (!fs) {
      log.warn('ipfs_add_via_helia_skipped_no_unixfs');
      return null;
    }
    const cid = await Promise.race([
      fs.addBytes(data),
      new Promise<never>((_, rej) => {
        setTimeout(
          () => rej(new Error(`helia_add_fallback_timeout_${HELIA_ADD_FALLBACK_TIMEOUT_MS}ms`)),
          HELIA_ADD_FALLBACK_TIMEOUT_MS
        );
      }),
    ]).catch((e) => {
      log.warn('ipfs_add_helia_fallback_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    });
    if (!cid) return null;
    const s = cid.toString();
    await cachePut(s, data);
    log.info('ipfs_add_via_helia', { cidPrefix: s.slice(0, 12) });
    return s;
  } catch (e) {
    log.warn('ipfs_add_helia_fallback_err', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function addToIpfs(data: Uint8Array): Promise<string | null> {
  // v4.32.19: kill switch — IPFS отключён на mobile (см. isIpfsEnabled/heliaNode.ts).
  // Возвращаем null сразу, не тратим JS thread на мёртвые HTTP fallbacks каждые 6 секунд.
  if (!isIpfsEnabled()) return null;
  // On phones, Kubo RPC is usually pointed at 127.0.0.1 (no daemon) and the JS client is the most fragile.
  // Helia first; HTTP only if Helia/Kubo path cannot produce a CID (offline / no unixfs), not «instead of» Helia when online.
  const helia = await addViaHeliaFallback(data);
  if (helia) return helia;
  const http = await addViaHttpApiFallback(data);
  if (http) return http;
  return addViaKubo(data);
}

export async function catFromIpfs(cid: string): Promise<Uint8Array | null> {
  // v4.32.19: kill switch — IPFS отключён на mobile.
  if (!isIpfsEnabled()) return null;
  try {
    const c = await getIpfsClient();
    if (c) {
      // v4.32.192 (Round-22 #3): bound stream size — poisoned CID can stream
      // unbounded bytes and OOM the JS heap.
      const IPFS_MAX_BYTES = 50 * 1024 * 1024;
      const chunks: Uint8Array[] = [];
      let running = 0;
      for await (const buf of c.cat(cid)) {
        running += buf.length;
        if (running > IPFS_MAX_BYTES) {
          log.warn('ipfs_cat_kubo_oversize_drop', { cidPrefix: cid.slice(0, 12), bytes: running });
          return null;
        }
        chunks.push(buf);
      }
      const total = chunks.reduce((a, b) => a + b.length, 0);
      const merged = new Uint8Array(total);
      let o = 0;
      for (const ch of chunks) {
        merged.set(ch, o);
        o += ch.length;
      }
      return merged;
    }
  } catch (e) {
    log.warn('ipfs_cat_failed', { err: e instanceof Error ? e.message : String(e), cid });
    resetIpfsClient();
  }
  return catViaHttpGateways(cid);
}

export async function ipfsId(): Promise<string | null> {
  // v4.32.19: kill switch — IPFS отключён на mobile.
  if (!isIpfsEnabled()) return null;
  try {
    const c = await getIpfsClient();
    if (!c) return null;
    const id = await c.id();
    return id.id.toString();
  } catch (e) {
    log.warn('ipfs_id_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
