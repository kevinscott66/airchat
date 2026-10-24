import { Platform } from 'react-native';

export class AttachmentBodyLimitError extends Error {}

/** RN's global fetch may ignore redirect; Expo's native transport rejects before following. */
export async function fetchAttachmentResponse(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  const transport = Platform.OS === 'web' ? globalThis.fetch : (await import('expo/fetch')).fetch;
  const response = await transport(url, { ...init, signal, redirect: 'error', credentials: 'omit' });
  // Defense in depth for a nonconforming transport. Never consume redirected content.
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('attachment_redirect_rejected');
  }
  return response as Response;
}

/** Bound bytes while streaming, regardless of absent/dishonest Content-Length. */
export async function readBoundedAttachmentBody(
  response: Response, maxBytes: number, controller: AbortController,
): Promise<Uint8Array> {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    void response.body?.cancel().catch(() => {});
    throw new AttachmentBodyLimitError('attachment_body_too_large');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    controller.abort();
    throw new Error('attachment_stream_unavailable');
  }
  const reader = response.body.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('attachment_download_aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  let total = 0;
  let bytes = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  try {
    while (true) {
      if (controller.signal.aborted) throw new Error('attachment_download_aborted');
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('attachment_invalid_chunk');
      if (value.byteLength > maxBytes - total) throw new AttachmentBodyLimitError('attachment_body_too_large');
      if (total + value.byteLength > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(bytes.byteLength * 2, total + value.byteLength)));
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
    return bytes.subarray(0, total);
  } catch (error) {
    controller.abort();
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    controller.signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* A canceled native read may still be settling. */ }
  }
}
