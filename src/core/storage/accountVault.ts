/**
 * Seed-bound local vault for account data.
 *
 * SQLite rows are already encrypted with the deterministic DEK derived from
 * the mnemonic. The vault keeps the database files and the small profile
 * registry together under a seed fingerprint, so a local wallet wipe can be
 * followed by a restore of the same account without mixing identities.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveLocalDekFromMnemonic } from './dekDerivation';
import { ED25519_PUBLIC_KEY_BYTES } from '../crypto/pubKeyFormat';
import { encryptSymmetric, decryptSymmetric } from '../crypto/encrypt';
import * as SecureStore from './secureStoreQueued';
import { PROFILE_STATE_KEY } from '../identity/profileStateKey';
import { log } from '../logger';

const VAULT_ROOT = 'airchat_account_vault_v1';
const MANIFEST_FILE = 'manifest.json';
const DB_FILE_RE = /^(?:airchat_local\.db|airchat_feed_p\d+\.db)(?:-(?:wal|shm))?$/;
const AVATAR_FILE_RE = /^avatar_\d+\.jpg$/;

type VaultManifestV1 = {
  v: 1;
  accountId: string;
  savedAt: number;
  dbFiles: string[];
  avatarFiles: string[];
  profileStateB64: string | null;
};

export type AccountVaultManifest = VaultManifestV1;

export type AccountVaultFile = {
  name: string;
  /** Base64 of the original file bytes. */
  dataB64: string;
};

export type AccountVaultArchive = {
  v: 1;
  accountId: string;
  savedAt: number;
  manifest: VaultManifestV1;
  files: AccountVaultFile[];
};

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().split(/\s+/).join(' ');
}

/** Public, non-secret directory id. It cannot be reversed into the mnemonic. */
export function accountVaultIdFromMnemonic(mnemonic: string): string {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized)) throw new Error('Invalid seed phrase');
  return Buffer.from(sha256(mnemonicToSeedSync(normalized))).toString('hex').slice(0, 32);
}

/**
 * Versioned cloud/sync account id. Unlike the legacy seed fingerprint, this
 * id is independently verifiable by the server from the signed account
 * public key, so an uninitialized account cannot be claimed by a first writer.
 */
export function accountIdFromPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('Invalid account public key');
  }
  return Buffer.from(sha256(publicKey)).toString('hex').slice(0, 32);
}

function vaultRootUri(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${VAULT_ROOT}/` : null;
}

function vaultUri(accountId: string): string | null {
  const root = vaultRootUri();
  return root ? `${root}${accountId}/` : null;
}

async function exists(uri: string): Promise<boolean> {
  try {
    return (await FileSystem.getInfoAsync(uri)).exists;
  } catch {
    return false;
  }
}

function isSafeVaultFile(name: string): boolean {
  return DB_FILE_RE.test(name) || AVATAR_FILE_RE.test(name);
}

function encryptedProfileStateB64(raw: string, mnemonic: string): string {
  const encrypted = encryptSymmetric(
    deriveLocalDekFromMnemonic(mnemonic),
    new TextEncoder().encode(raw),
  );
  return Buffer.from(encrypted).toString('base64');
}

function decryptProfileState(raw: string, mnemonic: string): string | null {
  try {
    const encrypted = new Uint8Array(Buffer.from(raw, 'base64'));
    const plain = decryptSymmetric(deriveLocalDekFromMnemonic(mnemonic), encrypted);
    return plain ? new TextDecoder().decode(plain) : null;
  } catch {
    return null;
  }
}

async function copyFiles(
  sourceDir: string,
  destinationDir: string,
  names: readonly string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const name of names) {
    const source = `${sourceDir}${name}`;
    if (!(await exists(source))) continue;
    await FileSystem.copyAsync({ from: source, to: `${destinationDir}${name}` });
    copied.push(name);
  }
  return copied;
}

async function replaceFile(source: string, destination: string): Promise<void> {
  await FileSystem.deleteAsync(destination, { idempotent: true });
  await FileSystem.copyAsync({ from: source, to: destination });
}

async function removeUnlistedFiles(directory: string, allowed: readonly string[], pattern: RegExp): Promise<void> {
  if (!(await exists(directory))) return;
  const keep = new Set(allowed);
  for (const name of await FileSystem.readDirectoryAsync(directory)) {
    if (pattern.test(name) && !keep.has(name)) {
      await FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true });
    }
  }
}

async function replaceVaultDirectory(stageDir: string, finalDir: string, root: string, accountId: string): Promise<void> {
  const previousDir = `${root}.previous-${accountId}-${Date.now()}/`;
  const hadPrevious = await exists(finalDir);
  if (hadPrevious) await FileSystem.moveAsync({ from: finalDir, to: previousDir });
  try {
    await FileSystem.moveAsync({ from: stageDir, to: finalDir });
  } catch (error) {
    await FileSystem.deleteAsync(finalDir, { idempotent: true }).catch(() => {});
    if (hadPrevious) {
      await FileSystem.moveAsync({ from: previousDir, to: finalDir }).catch(() => {});
    }
    throw error;
  }
  if (hadPrevious) await FileSystem.deleteAsync(previousDir, { idempotent: true });
}

/** Snapshot closed local databases before the wallet wipe removes them. */
export async function snapshotAccountVault(
  mnemonic: string,
  profileStateRaw: string | null,
): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const root = vaultRootUri();
  const finalDir = vaultUri(accountId);
  const base = FileSystem.documentDirectory;
  if (!root || !finalDir || !base) return false;

  const stageDir = `${root}.staging-${accountId}-${Date.now()}/`;
  await FileSystem.makeDirectoryAsync(`${stageDir}SQLite/`, { intermediates: true });
  await FileSystem.makeDirectoryAsync(`${stageDir}avatars/`, { intermediates: true });

  try {
    const dbDir = `${base}SQLite/`;
    const dbNames = (await exists(dbDir) ? await FileSystem.readDirectoryAsync(dbDir) : [])
      .filter((name) => DB_FILE_RE.test(name));
    const avatarNames = (await FileSystem.readDirectoryAsync(base))
      .filter((name) => AVATAR_FILE_RE.test(name));
    const copiedDbFiles = await copyFiles(dbDir, `${stageDir}SQLite/`, dbNames);
    const copiedAvatarFiles = await copyFiles(base, `${stageDir}avatars/`, avatarNames);
    const manifest: VaultManifestV1 = {
      v: 1,
      accountId,
      savedAt: Date.now(),
      dbFiles: copiedDbFiles,
      avatarFiles: copiedAvatarFiles,
      profileStateB64: profileStateRaw
        ? encryptedProfileStateB64(profileStateRaw, normalizeMnemonic(mnemonic))
        : null,
    };
    await FileSystem.writeAsStringAsync(`${stageDir}${MANIFEST_FILE}`, JSON.stringify(manifest));
    await replaceVaultDirectory(stageDir, finalDir, root, accountId);
    log.info('account_vault_snapshot_saved', {
      accountId,
      dbFiles: copiedDbFiles.length,
      avatarFiles: copiedAvatarFiles.length,
    });
    return true;
  } catch (e) {
    log.warn('account_vault_snapshot_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    await FileSystem.deleteAsync(stageDir, { idempotent: true });
    return false;
  }
}

/** Delete the seed-bound local restore point as part of a full wallet wipe. */
export async function deleteAccountVault(mnemonic: string): Promise<void> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  if (!dir) return;
  await FileSystem.deleteAsync(dir, { idempotent: true });
  log.info('account_vault_deleted', { accountId });
}

/** Restore the seed-bound snapshot, if one exists on this installation. */
export async function hasAccountVaultSnapshot(mnemonic: string): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  return !!dir && (await exists(`${dir}${MANIFEST_FILE}`));
}

/** Restore the seed-bound snapshot, if one exists on this installation. */
export async function restoreAccountVault(mnemonic: string): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  const base = FileSystem.documentDirectory;
  if (!dir || !base) return false;
  const manifestUri = `${dir}${MANIFEST_FILE}`;
  if (!(await exists(manifestUri))) return false;

  try {
    const raw = await FileSystem.readAsStringAsync(manifestUri);
    const manifest = JSON.parse(raw) as VaultManifestV1;
    if (
      manifest?.v !== 1 ||
      manifest.accountId !== accountId ||
      !Array.isArray(manifest.dbFiles) ||
      !Array.isArray(manifest.avatarFiles)
    ) return false;

    if (manifest.profileStateB64) {
      const profileState = decryptProfileState(manifest.profileStateB64, normalizeMnemonic(mnemonic));
      if (profileState) await SecureStore.setItemAsync(PROFILE_STATE_KEY, profileState);
    } else {
      await SecureStore.deleteItemAsync(PROFILE_STATE_KEY);
    }

    const dbDir = `${base}SQLite/`;
    await FileSystem.makeDirectoryAsync(dbDir, { intermediates: true });
    await removeUnlistedFiles(dbDir, manifest.dbFiles, DB_FILE_RE);
    await removeUnlistedFiles(base, manifest.avatarFiles, AVATAR_FILE_RE);
    for (const name of manifest.dbFiles.filter((value) => typeof value === 'string' && DB_FILE_RE.test(value))) {
      const destination = `${dbDir}${name}`;
      if (await exists(`${dir}SQLite/${name}`)) await replaceFile(`${dir}SQLite/${name}`, destination);
    }
    for (const name of manifest.avatarFiles.filter((value) => typeof value === 'string' && AVATAR_FILE_RE.test(value))) {
      const destination = `${base}${name}`;
      if (await exists(`${dir}avatars/${name}`)) await replaceFile(`${dir}avatars/${name}`, destination);
    }
    log.info('account_vault_restored', {
      accountId,
      dbFiles: manifest.dbFiles.length,
      avatarFiles: manifest.avatarFiles.length,
    });
    return true;
  } catch (e) {
    log.warn('account_vault_restore_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Read the local seed-bound snapshot as a transport-neutral archive. The
 * caller encrypts this object before it leaves the device.
 */
export async function readAccountVaultArchive(mnemonic: string): Promise<AccountVaultArchive | null> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const dir = vaultUri(accountId);
  if (!dir) return null;
  const manifestUri = `${dir}${MANIFEST_FILE}`;
  if (!(await exists(manifestUri))) return null;

  try {
    const manifest = JSON.parse(await FileSystem.readAsStringAsync(manifestUri)) as VaultManifestV1;
    if (
      manifest?.v !== 1 ||
      manifest.accountId !== accountId ||
      !Array.isArray(manifest.dbFiles) ||
      !Array.isArray(manifest.avatarFiles)
    ) return null;

    const files: AccountVaultFile[] = [];
    for (const name of [...manifest.dbFiles, ...manifest.avatarFiles]) {
      if (typeof name !== 'string' || !isSafeVaultFile(name)) continue;
      const uri = DB_FILE_RE.test(name) ? `${dir}SQLite/${name}` : `${dir}avatars/${name}`;
      if (!(await exists(uri))) continue;
      files.push({
        name,
        dataB64: await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
      });
    }
    return { v: 1, accountId, savedAt: manifest.savedAt, manifest, files };
  } catch (e) {
    log.warn('account_vault_archive_read_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Restore an already decrypted archive without allowing path traversal. */
export async function restoreAccountVaultArchive(
  mnemonic: string,
  archive: AccountVaultArchive,
): Promise<boolean> {
  const accountId = accountVaultIdFromMnemonic(mnemonic);
  const base = FileSystem.documentDirectory;
  if (
    !base ||
    archive?.v !== 1 ||
    archive.accountId !== accountId ||
    archive.manifest?.v !== 1 ||
    archive.manifest.accountId !== accountId ||
    !Array.isArray(archive.files)
  ) return false;

  try {
    await FileSystem.makeDirectoryAsync(`${base}SQLite/`, { intermediates: true });
    const manifestDbFiles = Array.isArray(archive.manifest.dbFiles) ? archive.manifest.dbFiles : [];
    const manifestAvatarFiles = Array.isArray(archive.manifest.avatarFiles) ? archive.manifest.avatarFiles : [];
    const manifestFiles = new Set([...manifestDbFiles, ...manifestAvatarFiles]);
    await removeUnlistedFiles(`${base}SQLite/`, manifestDbFiles, DB_FILE_RE);
    await removeUnlistedFiles(base, manifestAvatarFiles, AVATAR_FILE_RE);
    for (const file of archive.files) {
      if (!file || typeof file.name !== 'string' || !manifestFiles.has(file.name)
        || !isSafeVaultFile(file.name) || typeof file.dataB64 !== 'string') continue;
      const destination = DB_FILE_RE.test(file.name)
        ? `${base}SQLite/${file.name}`
        : `${base}${file.name}`;
      const temporary = `${destination}.restore-${Date.now()}`;
      await FileSystem.deleteAsync(temporary, { idempotent: true });
      await FileSystem.writeAsStringAsync(temporary, file.dataB64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await FileSystem.deleteAsync(destination, { idempotent: true });
      await FileSystem.moveAsync({ from: temporary, to: destination });
    }
    if (archive.manifest?.profileStateB64) {
      const profileState = decryptProfileState(archive.manifest.profileStateB64, normalizeMnemonic(mnemonic));
      if (profileState) await SecureStore.setItemAsync(PROFILE_STATE_KEY, profileState);
    } else {
      await SecureStore.deleteItemAsync(PROFILE_STATE_KEY);
    }
    log.info('account_vault_archive_restored', {
      accountId,
      files: archive.files.length,
    });
    return true;
  } catch (e) {
    log.warn('account_vault_archive_restore_failed', {
      accountId,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
