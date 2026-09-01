import { ed25519 } from '@noble/curves/ed25519.js';
import { ecdhSharedSecret } from '../keyManager';

describe('keyManager', () => {
  it('ECDH produces matching shared secrets', () => {
    const a = ed25519.keygen();
    const b = ed25519.keygen();
    const s1 = ecdhSharedSecret(a.secretKey, b.publicKey);
    const s2 = ecdhSharedSecret(b.secretKey, a.publicKey);
    expect(Buffer.from(s1).equals(Buffer.from(s2))).toBe(true);
  });
});
