import { log } from '../../logger';

export async function checkIPFSEndpoint(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const idUrl = url.replace(/\/api\/v0\/add(?:\?.*)?$/i, '/api/v0/id');
    const res = await Promise.race([
      fetch(idUrl, { method: 'POST' }),
      new Promise<Response>((_, rej) => {
        setTimeout(() => rej(new Error('ipfs_health_timeout')), timeoutMs);
      }),
    ]);
    return res.ok;
  } catch {
    return false;
  }
}

export async function getWorkingAddUrl(urls: string[], timeoutMs = 3000): Promise<string | null> {
  for (const url of urls) {
    const ok = await checkIPFSEndpoint(url, timeoutMs);
    if (ok) return url;
  }
  log.warn('ipfs_no_working_add_endpoint', { count: urls.length });
  return null;
}

