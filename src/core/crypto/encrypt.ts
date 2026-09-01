import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { log } from '../logger';

const NONCE_LEN = 24;

/**
 * XChaCha20-Poly1305: ключ — 32 байта.
 *
 * v4.32.427. Число то же, что у открытого ключа, но понятие другое, и имя
 * здесь именно затем, чтобы их нельзя было спутать: `key.length !== 32` в
 * коде не говорит, о каком ключе речь, а `SYMMETRIC_KEY_BYTES` — говорит.
 */
export const SYMMETRIC_KEY_BYTES = 32;

export function deriveSymmetricKey(sharedSecret: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, salt, new TextEncoder().encode('airchat-v1'), SYMMETRIC_KEY_BYTES);
}

export function encryptSymmetric(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = xchacha20poly1305(key, nonce, aad);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

export function decryptSymmetric(
  key: Uint8Array,
  blob: Uint8Array,
  aad?: Uint8Array
): Uint8Array | null {
  try {
    if (blob.length < NONCE_LEN + 16) return null;
    const nonce = blob.subarray(0, NONCE_LEN);
    const ct = blob.subarray(NONCE_LEN);
    const cipher = xchacha20poly1305(key, nonce, aad);
    return cipher.decrypt(ct);
  } catch (e) {
    log.warn('decrypt_symmetric_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
