import fs from 'fs';
import path from 'path';

import {
  CLOUD_VAULT_MAX_BYTES,
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

/**
 * v4.32.615: разбор списка файлов раскодировал каждый файл дважды — сначала
 * ради ответа «да/нет», потом ради суммы, — и каждый раз в полные
 * CLOUD_VAULT_MAX_BYTES вместо остатка. Ниже проверено, что после
 * объединения проходов отбраковка не ослабла.
 */
describe('облачная копия: разбор списка файлов', () => {
  function withData(dataB64: string) {
    const a = archive();
    a.files = [{ name: 'airchat_local.db', dataB64 }];
    return encryptCloudVaultArchive(MNEMONIC, PASSWORD, a);
  }

  it('отвергает файл с посторонними символами в base64', () => {
    expect(decryptCloudVaultArchive(MNEMONIC, PASSWORD, withData('!!!!'))).toBeNull();
  });

  it('отвергает пустое тело файла', () => {
    expect(decryptCloudVaultArchive(MNEMONIC, PASSWORD, withData(''))).toBeNull();
  });

  it('отвергает неканоническую запись base64', () => {
    // 'AB==' раскодируется в тот же байт, что и 'AA==', но обратно кодируется
    // в 'AA==' — две записи одного файла нам не нужны.
    expect(decryptCloudVaultArchive(MNEMONIC, PASSWORD, withData('AB=='))).toBeNull();
  });

  it('пропускает корректное тело файла', () => {
    expect(decryptCloudVaultArchive(MNEMONIC, PASSWORD, withData('AA=='))).not.toBeNull();
  });
});

describe('храповик: разбор списка файлов', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'cloudVault.ts'), 'utf8');
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const BODY = CODE.slice(
    CODE.indexOf('function validateArchiveFileList'),
    CODE.indexOf('async function signedRequest'),
  );

  it('раскодирует каждый файл ровно один раз', () => {
    expect(BODY).not.toBe('');
    expect(BODY.match(/decodeBase64\(/g) ?? []).toHaveLength(1);
  });

  it('отдаёт в потолок остаток бюджета, а не весь бюджет', () => {
    expect(BODY).toContain('CLOUD_VAULT_MAX_BYTES - totalBytes');
    expect(CLOUD_VAULT_MAX_BYTES).toBeGreaterThan(0);
  });
});
