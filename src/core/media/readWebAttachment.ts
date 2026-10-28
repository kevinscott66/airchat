import { Buffer } from 'buffer';

export type WebAttachmentRead =
  | { ok: true; b64: string; mime: string; size: number }
  | { ok: false; reason: 'oversize' | 'failed' };

/** Picker-owned URLs only: never fetch a remote URL with the user's credentials. */
export async function readWebAttachment(uri: string, maxBytes: number): Promise<WebAttachmentRead> {
  if (!/^(blob:|data:)/i.test(uri)) return { ok: false, reason: 'failed' };
  // Expo ImagePicker uses data URLs on web; reject obviously oversized payloads
  // before fetch decodes them. Percent encoding can use three characters per byte.
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0 || comma > 1024) return { ok: false, reason: 'failed' };
    const maxEncoded = /;base64$/i.test(uri.slice(0, comma))
      ? Math.ceil(maxBytes / 3) * 4 : maxBytes * 3;
    if (uri.length - comma - 1 > maxEncoded) return { ok: false, reason: 'oversize' };
  }
  try {
    const response = await fetch(uri, { credentials: 'omit' });
    if (!response.ok) return { ok: false, reason: 'failed' };
    const blob = await response.blob();
    if (blob.size > maxBytes) return { ok: false, reason: 'oversize' };
    if (blob.size === 0) return { ok: false, reason: 'failed' };
    const bytes = await blob.arrayBuffer();
    return {
      ok: true,
      b64: Buffer.from(bytes).toString('base64'),
      mime: blob.type || 'application/octet-stream',
      size: bytes.byteLength,
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
