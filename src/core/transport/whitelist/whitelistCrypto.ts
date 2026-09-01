/**
 * Общий симметричный ключ для пары did:key (ECDH X25519 + HKDF).
 * Сервис видит только зашифрованный blob (XChaCha20-Poly1305).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPairBytes } from '../../crypto/keyManager';
import { ecdhSharedSecret } from '../../crypto/keyManager';
import { deriveSymmetricKey, encryptSymmetric, decryptSymmetric } from '../../crypto/encrypt';
import { parseDidKey, publicKeyToDidKey } from '../../identity/did';

function pairwiseSalt(didA: string, didB: string): Uint8Array {
  const sorted = [didA, didB].sort();
  return sha256(new TextEncoder().encode(`airchat-whitelist-pair:${sorted[0]}:${sorted[1]}`));
}

export function deriveWhitelistSymmetricKey(pair: KeyPairBytes, peerDid: string): Uint8Array | null {
  const peerPk = parseDidKey(peerDid);
  if (!peerPk) return null;
  const raw = ecdhSharedSecret(pair.secretKey, peerPk);
  const myDid = publicKeyToDidKey(pair.publicKey);
  const salt = pairwiseSalt(myDid, peerDid);
  return deriveSymmetricKey(raw, salt);
}

export function encryptWhitelistUtf8(
  pair: KeyPairBytes,
  peerDid: string,
  plaintext: string
): Uint8Array | null {
  const key = deriveWhitelistSymmetricKey(pair, peerDid);
  if (!key) return null;
  return encryptSymmetric(key, new TextEncoder().encode(plaintext));
}

export function decryptWhitelistUtf8(
  pair: KeyPairBytes,
  peerDid: string,
  blob: Uint8Array
): string | null {
  const key = deriveWhitelistSymmetricKey(pair, peerDid);
  if (!key) return null;
  const pt = decryptSymmetric(key, blob);
  if (!pt) return null;
  return new TextDecoder().decode(pt);
}
