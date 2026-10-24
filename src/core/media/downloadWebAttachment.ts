import { Buffer } from 'buffer';

/** Download as a file, never navigate to potentially executable attachment content. */
export function downloadWebAttachment(b64: string, name: string): void {
  const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
  if (!bytes.length) throw new Error('empty_attachment');
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    // Strip path separators and control bytes from the untrusted filename.
    // eslint-disable-next-line no-control-regex
    anchor.download = name.replace(/[\\/\u0000-\u001F\u007F-\u009F\u2028\u2029\u061C\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '_').slice(0, 120) || 'attachment';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Safari may consume the URL after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
