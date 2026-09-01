import { randomBytes } from '@noble/hashes/utils.js';
import { decryptSymmetric, deriveSymmetricKey, encryptSymmetric } from '../encrypt';

describe('encrypt', () => {
  it('roundtrips symmetric encryption', () => {
    const shared = randomBytes(32);
    const salt = new TextEncoder().encode('salt');
    const key = deriveSymmetricKey(shared, salt);
    const pt = new TextEncoder().encode('hello airchat');
    const ct = encryptSymmetric(key, pt);
    const out = decryptSymmetric(key, ct);
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out!)).toBe('hello airchat');
  });
});
