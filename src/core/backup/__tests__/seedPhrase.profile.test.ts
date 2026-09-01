import { generateMnemonic } from 'bip39';
import { deriveKeyPairFromMnemonic, deriveKeyPairFromMnemonicForProfile } from '../seedPhrase';

describe('seedPhrase multi-profile', () => {
  it('derivation index 0 matches legacy deriveKeyPairFromMnemonic', () => {
    const m = generateMnemonic(256);
    const legacy = deriveKeyPairFromMnemonic(m);
    const p0 = deriveKeyPairFromMnemonicForProfile(m, 0);
    expect(Buffer.from(legacy.secretKey).equals(Buffer.from(p0.secretKey))).toBe(true);
    expect(Buffer.from(legacy.publicKey).equals(Buffer.from(p0.publicKey))).toBe(true);
  });

  it('different indices yield different keys', () => {
    const m = generateMnemonic(256);
    const a = deriveKeyPairFromMnemonicForProfile(m, 1);
    const b = deriveKeyPairFromMnemonicForProfile(m, 2);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(false);
  });
});
