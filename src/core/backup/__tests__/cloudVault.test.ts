import {
  decryptCloudVaultArchive,
  encryptCloudVaultArchive,
  validateCloudPassword,
} from '../cloudVault';
import { accountVaultIdFromMnemonic, type AccountVaultArchive } from '../../storage/accountVault';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'облачный-пароль-2026';

function archive(): AccountVaultArchive {
  const accountId = accountVaultIdFromMnemonic(MNEMONIC);
  return {
    v: 1,
    accountId,
    savedAt: 123,
    manifest: {
      v: 1,
      accountId,
      savedAt: 123,
      dbFiles: ['airchat_local.db'],
      avatarFiles: [],
      profileStateB64: null,
    },
    files: [{ name: 'airchat_local.db', dataB64: 'AAEC' }],
  };
}

describe('cloud vault crypto', () => {
  it('requires a separate strong password', () => {
    expect(validateCloudPassword('short')).toContain('минимум');
    expect(validateCloudPassword(' достаточная длина')).toContain('пробел');
    expect(validateCloudPassword(PASSWORD)).toBeNull();
  });

  it('round-trips with the same seed and cloud password', () => {
    const envelope = encryptCloudVaultArchive(MNEMONIC, PASSWORD, archive());
    expect(envelope.blobB64).not.toContain('airchat_local.db');
    expect(decryptCloudVaultArchive(MNEMONIC, PASSWORD, envelope)).toEqual(archive());
  });

  it('rejects a wrong password and a different seed', () => {
    const envelope = encryptCloudVaultArchive(MNEMONIC, PASSWORD, archive());
    expect(decryptCloudVaultArchive(MNEMONIC, 'другой-облачный-пароль', envelope)).toBeNull();
    const otherSeed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    expect(decryptCloudVaultArchive(otherSeed, PASSWORD, envelope)).toBeNull();
  });

  it('rejects envelopes with attacker-controlled excessive KDF work', () => {
    const envelope = encryptCloudVaultArchive(MNEMONIC, PASSWORD, archive());
    expect(decryptCloudVaultArchive(MNEMONIC, PASSWORD, { ...envelope, iters: 1_000_001 })).toBeNull();
  });
});
