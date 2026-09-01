/**
 * Regression tests for symmetric key derivation — fix from commit 48a9a50.
 *
 * Проблема была в том, что sender и receiver получали разные ключи из-за
 * non-canonical соли: "contact:${peerPubB64}" отличается у каждой стороны.
 *
 * Фикс: соль = отсортированная пара ключей → "airchat-dm:<kMin>:<kMax>".
 * Оба участника вычисляют ОДИНАКОВЫЙ ключ независимо от порядка.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { deriveSymmetricKey, encryptSymmetric, decryptSymmetric } from '../encrypt';

function makeX25519Pair() {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

function canonicalSalt(pubA: Uint8Array, pubB: Uint8Array): Uint8Array {
  const b64A = Buffer.from(pubA).toString('base64');
  const b64B = Buffer.from(pubB).toString('base64');
  const [kMin, kMax] = [b64A, b64B].sort();
  return new TextEncoder().encode(`airchat-dm:${kMin}:${kMax}`);
}

describe('decrypt pipeline regression — canonical symKey derivation', () => {
  test('sender and receiver derive identical key with canonical salt', () => {
    const alice = makeX25519Pair();
    const bob = makeX25519Pair();

    const sharedAlice = x25519.getSharedSecret(alice.secretKey, bob.publicKey);
    const sharedBob = x25519.getSharedSecret(bob.secretKey, alice.publicKey);

    const salt = canonicalSalt(alice.publicKey, bob.publicKey);
    const keyAlice = deriveSymmetricKey(sharedAlice, salt);
    const keyBob = deriveSymmetricKey(sharedBob, salt);

    expect(Buffer.from(keyAlice).toString('hex')).toBe(Buffer.from(keyBob).toString('hex'));
  });

  test('canonical salt is order-independent: alice→bob and bob→alice give same salt', () => {
    const alice = makeX25519Pair();
    const bob = makeX25519Pair();

    const saltAB = canonicalSalt(alice.publicKey, bob.publicKey);
    const saltBA = canonicalSalt(bob.publicKey, alice.publicKey);

    expect(Buffer.from(saltAB).toString('hex')).toBe(Buffer.from(saltBA).toString('hex'));
  });

  test('message encrypted by sender decrypts successfully on receiver', () => {
    const alice = makeX25519Pair();
    const bob = makeX25519Pair();

    const sharedAlice = x25519.getSharedSecret(alice.secretKey, bob.publicKey);
    const sharedBob = x25519.getSharedSecret(bob.secretKey, alice.publicKey);
    const salt = canonicalSalt(alice.publicKey, bob.publicKey);

    const keyAlice = deriveSymmetricKey(sharedAlice, salt);
    const keyBob = deriveSymmetricKey(sharedBob, salt);

    const plaintext = new TextEncoder().encode(JSON.stringify({ text: 'Привет!', mediaCids: [] }));
    const ciphertext = encryptSymmetric(keyAlice, plaintext);
    const decrypted = decryptSymmetric(keyBob, ciphertext);

    expect(decrypted).not.toBeNull();
    expect(new TextDecoder().decode(decrypted!)).toBe(new TextDecoder().decode(plaintext));
  });

  test('non-canonical salt (old bug) causes decryption failure', () => {
    const alice = makeX25519Pair();
    const bob = makeX25519Pair();

    const sharedAlice = x25519.getSharedSecret(alice.secretKey, bob.publicKey);
    const sharedBob = x25519.getSharedSecret(bob.secretKey, alice.publicKey);

    // Старый баг: каждая сторона использует свой ключ пира как соль → разные ключи
    const saltAliceSide = new TextEncoder().encode(
      `contact:${Buffer.from(bob.publicKey).toString('base64')}`
    );
    const saltBobSide = new TextEncoder().encode(
      `contact:${Buffer.from(alice.publicKey).toString('base64')}`
    );

    const keyAlice = deriveSymmetricKey(sharedAlice, saltAliceSide);
    const keyBob = deriveSymmetricKey(sharedBob, saltBobSide);

    // Ключи должны быть РАЗНЫМИ (баг)
    expect(Buffer.from(keyAlice).toString('hex')).not.toBe(Buffer.from(keyBob).toString('hex'));

    // Следовательно — расшифровка провалится
    const plaintext = new TextEncoder().encode('test');
    const ciphertext = encryptSymmetric(keyAlice, plaintext);
    const decrypted = decryptSymmetric(keyBob, ciphertext);
    expect(decrypted).toBeNull();
  });
});
