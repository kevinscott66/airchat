/**
 * Persistent cloud copy of the seed-bound account vault.
 *
 * The cloud service receives an authenticated ciphertext envelope only. The
 * mnemonic and cloud password are combined locally for key derivation; neither
 * is persisted or sent over the network.
 */
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { encryptSymmetric, decryptSymmetric, SYMMETRIC_KEY_BYTES } from '../crypto/encrypt';
import { signJson } from '../crypto/signature';
import { deriveKeyPairFromMnemonic } from './seedPhrase';
import { getSyncDeviceAuth } from '../sync/syncApi';
import { getConfigSync } from '../config';
import {
  accountIdFromPublicKey,
  accountVaultIdFromMnemonic,
  readAccountVaultArchive,
  restoreAccountVaultArchive,
  snapshotAccountVault,
  type AccountVaultArchive,
  type AccountVaultFile,
} from '../storage/accountVault';
import { PROFILE_STATE_KEY } from '../identity/profileStateKey';
import * as SecureStore from '../storage/secureStoreQueued';
import { log } from '../logger';
import { deriveLocalDekFromMnemonic } from '../storage/dekDerivation';
import { bytesToBase64Url } from '../utils/base64url';

export const CLOUD_VAULT_VERSION = 1;
export const CLOUD_VAULT_KDF_ITERS = 180_000;
export const CLOUD_PASSWORD_MIN_LENGTH = 12;
export const CLOUD_VAULT_MAX_BYTES = 80 * 1024 * 1024;
export const CLOUD_VAULT_MAX_KDF_ITERS = 1_000_000;
const CLOUD_REQUEST_TIMEOUT_MS = 30_000;
const CLOUD_VAULT_MAX_FILES = 64;

const CLOUD_AAD_PREFIX = 'airchat-cloud-vault-example-v1:';
const REQUEST_VERSION = 1;

export type CloudVaultEnvelope = {
  v: 1;
  accountId: string;
  savedAt: number;
  saltB64: string;
  iters: number;
  blobB64: string;
};

export type CloudVaultStatus = 'restored' | 'not_found';

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().split(/\s+/).join(' ');
}

function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

function decodeBase64(value: string, maxBytes: number): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(value, 'base64'));
    if (bytes.length === 0 || Buffer.from(bytes).toString('base64') !== value || bytes.length > maxBytes) return null;
    return bytes;
  } catch {
    return null;
  }
}

function isSafeArchiveFile(name: string): boolean {
  return /^(?:airchat_local\.db|airchat_feed_p\d+\.db)(?:-(?:wal|shm))?$/.test(name)
    || /^avatar_\d+\.jpg$/.test(name);
}

export function validateCloudPassword(password: string): string | null {
  if (typeof password !== 'string' || password.normalize('NFC').length < CLOUD_PASSWORD_MIN_LENGTH) {
    return `Облачный пароль должен содержать минимум ${CLOUD_PASSWORD_MIN_LENGTH} символов.`;
  }
  if (password.trim() !== password) {
    return 'Облачный пароль не должен начинаться или заканчиваться пробелом.';
  }
  return null;
}

function deriveCloudKey(mnemonic: string, password: string, salt: Uint8Array, iters: number): Uint8Array {
  const seedKey = deriveLocalDekFromMnemonic(mnemonic);
  const passwordBytes = new TextEncoder().encode(normalizePassword(password));
  const material = new Uint8Array(seedKey.length + passwordBytes.length);
  material.set(seedKey, 0);
  material.set(passwordBytes, seedKey.length);
  return pbkdf2(sha256, material, salt, {
    c: Math.max(iters, CLOUD_VAULT_KDF_ITERS),
    dkLen: SYMMETRIC_KEY_BYTES,
  });
}

function aad(accountId: string): Uint8Array {
  return new TextEncoder().encode(`${CLOUD_AAD_PREFIX}${accountId}`);
}

/** Pure crypto primitive kept public for deterministic unit tests. */
export function encryptCloudVaultArchive(
  mnemonic: string,
  password: string,
  archive: AccountVaultArchive,
): CloudVaultEnvelope {
  const passwordError = validateCloudPassword(password);
  if (passwordError) throw new Error(passwordError);
  const legacyAccountId = accountVaultIdFromMnemonic(mnemonic);
  const accountId = accountIdFromPublicKey(deriveKeyPairFromMnemonic(mnemonic).publicKey);
  if (archive?.v !== 1 || archive.accountId !== legacyAccountId) throw new Error('Неверная привязка облачной копии к seed-фразе.');
  const plain = new TextEncoder().encode(JSON.stringify(archive));
  if (plain.length > CLOUD_VAULT_MAX_BYTES) throw new Error('Облачная копия слишком большая.');
  const salt = randomBytes(16);
  const key = deriveCloudKey(normalizeMnemonic(mnemonic), password, salt, CLOUD_VAULT_KDF_ITERS);
  const blob = encryptSymmetric(key, plain, aad(accountId));
  return {
    v: CLOUD_VAULT_VERSION,
    accountId,
    savedAt: archive.savedAt,
    saltB64: Buffer.from(salt).toString('base64'),
    iters: CLOUD_VAULT_KDF_ITERS,
    blobB64: Buffer.from(blob).toString('base64'),
  };
}

/** Pure crypto primitive: wrong seed or password returns null. */
export function decryptCloudVaultArchive(
  mnemonic: string,
  password: string,
  envelope: CloudVaultEnvelope,
): AccountVaultArchive | null {
  try {
    const passwordError = validateCloudPassword(password);
    if (passwordError) return null;
    const legacyAccountId = accountVaultIdFromMnemonic(mnemonic);
    const accountId = accountIdFromPublicKey(deriveKeyPairFromMnemonic(mnemonic).publicKey);
    const acceptedAccountIds = new Set([accountId, legacyAccountId]);
    if (
      !envelope ||
      envelope.v !== CLOUD_VAULT_VERSION ||
      !acceptedAccountIds.has(envelope.accountId) ||
      typeof envelope.saltB64 !== 'string' ||
      typeof envelope.blobB64 !== 'string' ||
      envelope.blobB64.length > CLOUD_VAULT_MAX_BYTES * 2
    ) return null;
    if (!Number.isSafeInteger(envelope.savedAt) || envelope.savedAt < 0
      || !Number.isSafeInteger(envelope.iters)
      || envelope.iters < CLOUD_VAULT_KDF_ITERS
      || envelope.iters > CLOUD_VAULT_MAX_KDF_ITERS) return null;
    const salt = decodeBase64(envelope.saltB64, 16);
    if (!salt || salt.length !== 16) return null;
    const blob = decodeBase64(envelope.blobB64, CLOUD_VAULT_MAX_BYTES * 2);
    if (!blob) return null;
    const key = deriveCloudKey(normalizeMnemonic(mnemonic), password, salt, envelope.iters);
    const plain = decryptSymmetric(key, blob, aad(envelope.accountId));
    if (!plain || plain.length > CLOUD_VAULT_MAX_BYTES) return null;
    const archive = JSON.parse(new TextDecoder().decode(plain)) as AccountVaultArchive;
    if (
      archive?.v !== 1 ||
      archive.accountId !== legacyAccountId ||
      !archive.manifest ||
      !Array.isArray(archive.files)
    ) return null;
    if (!validateArchiveFileList(archive)) return null;
    return archive;
  } catch {
    return null;
  }
}

function cloudBaseUrl(): string | null {
  const config = getConfigSync().cloudBackup;
  if (!config?.enabled || !config.baseUrl) return null;
  return config.baseUrl.replace(/\/+$/, '');
}

function randomNonce(): string {
  return bytesToBase64Url(randomBytes(16));
}

async function fetchCloud(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timeout = setTimeout(() => controller?.abort(), CLOUD_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (e) {
    if (controller?.signal.aborted) throw new Error('Облачный сервер не отвечает.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function validateArchiveFileList(
  archive: AccountVaultArchive,
): { names: Set<string>; files: AccountVaultFile[] } | null {
  if (!archive || !Array.isArray(archive.files) || archive.files.length > CLOUD_VAULT_MAX_FILES) return null;
  const dbFiles = archive.manifest?.dbFiles;
  const avatarFiles = archive.manifest?.avatarFiles;
  if (!Array.isArray(dbFiles) || !Array.isArray(avatarFiles)
    || dbFiles.length + avatarFiles.length > CLOUD_VAULT_MAX_FILES) return null;
  const names = [...dbFiles, ...avatarFiles];
  if (names.some((name) => typeof name !== 'string' || !isSafeArchiveFile(name))) return null;
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) return null;
  const fileNames = archive.files.map((file) => file?.name);
  if (new Set(fileNames).size !== fileNames.length) return null;
  if (archive.files.some((file) => !file || typeof file.name !== 'string'
    || !uniqueNames.has(file.name) || !isSafeArchiveFile(file.name)
    || typeof file.dataB64 !== 'string' || !decodeBase64(file.dataB64, CLOUD_VAULT_MAX_BYTES))) return null;
  const files = archive.files as AccountVaultFile[];
  let totalBytes = 0;
  for (const file of files) {
    const decoded = decodeBase64(file.dataB64, CLOUD_VAULT_MAX_BYTES);
    if (!decoded) return null;
    totalBytes += decoded.length;
    if (totalBytes > CLOUD_VAULT_MAX_BYTES) return null;
  }
  return { names: uniqueNames, files };
}

async function signedRequest(
  mnemonic: string,
  operation: 'put' | 'get',
  envelope?: CloudVaultEnvelope,
): Promise<{ payload: string; signature: string }> {
  const pair = deriveKeyPairFromMnemonic(mnemonic);
  const auth = await getSyncDeviceAuth(mnemonic);
  const publicKeyB64 = Buffer.from(auth.pair.publicKey).toString('base64');
  const accountPublicKeyB64 = Buffer.from(pair.publicKey).toString('base64');
  const accountId = accountIdFromPublicKey(pair.publicKey);
  const payload: Record<string, unknown> = {
    v: REQUEST_VERSION,
    op: operation,
    accountId,
    legacyAccountId: accountVaultIdFromMnemonic(mnemonic),
    publicKeyB64,
    accountPublicKeyB64,
    // Cloud-vault requests use the same device registry as live sync. This
    // prevents a revoked installation from falling back to the legacy API.
    deviceId: auth.deviceId,
    devicePublicKeyB64: publicKeyB64,
    timestamp: Date.now(),
    nonce: randomNonce(),
  };
  if (envelope) payload.envelope = envelope;
  return signJson(auth.pair, payload);
}

function requestError(status: number): Error {
  if (status === 404) return new Error('Облачная копия ещё не создана.');
  if (status === 413) return new Error('Облачная копия слишком большая для сервера.');
  if (status === 401 || status === 403) return new Error('Облачный запрос отклонён сервером.');
  if (status === 409) return new Error('На сервере уже сохранена более новая облачная копия.');
  return new Error(`Облачный сервер недоступен (HTTP ${status}).`);
}

/** Snapshot current files, encrypt them, and upload the ciphertext. */
export async function uploadCloudVault(mnemonic: string, password: string): Promise<void> {
  const base = cloudBaseUrl();
  if (!base) throw new Error('Облачное хранилище не настроено.');
  const passwordError = validateCloudPassword(password);
  if (passwordError) throw new Error(passwordError);

  // The snapshot is a point-in-time export. Closing SQLite first ensures WAL
  // pages are checkpointed before the archive is read.
  const { closeFeedStorage } = await import('../social/feedService');
  const { closeLocalDatabase } = await import('../storage/local');
  await closeFeedStorage();
  await closeLocalDatabase();
  const profileState = await SecureStore.getItemAsync(PROFILE_STATE_KEY);
  if (!(await snapshotAccountVault(mnemonic, profileState))) {
    throw new Error('Не удалось собрать локальную копию аккаунта.');
  }
  const archive = await readAccountVaultArchive(mnemonic);
  if (!archive) throw new Error('Не удалось прочитать локальную копию аккаунта.');
  const envelope = encryptCloudVaultArchive(mnemonic, password, archive);
  const signed = await signedRequest(mnemonic, 'put', envelope);
  const response = await fetchCloud(`${base}/v1/cloud-vault/${envelope.accountId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  });
  if (!response.ok) throw requestError(response.status);
  log.info('cloud_vault_uploaded', { accountId: envelope.accountId, savedAt: envelope.savedAt });
}

/** Download, decrypt, validate and restore a cloud copy for the same seed. */
export async function restoreCloudVault(
  mnemonic: string,
  password: string,
): Promise<CloudVaultStatus> {
  const base = cloudBaseUrl();
  if (!base) throw new Error('Облачное хранилище не настроено.');
  const signed = await signedRequest(mnemonic, 'get');
  const response = await fetchCloud(
    `${base}/v1/cloud-vault/${accountIdFromPublicKey(deriveKeyPairFromMnemonic(mnemonic).publicKey)}/get`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    },
  );
  if (response.status === 404) return 'not_found';
  if (!response.ok) throw requestError(response.status);
  const envelope = (await response.json()) as CloudVaultEnvelope;
  const archive = decryptCloudVaultArchive(mnemonic, password, envelope);
  if (!archive) throw new Error('Неверный облачный пароль или повреждённая копия.');
  const { closeFeedStorage } = await import('../social/feedService');
  const { closeLocalDatabase } = await import('../storage/local');
  await closeFeedStorage();
  await closeLocalDatabase();
  if (!(await restoreAccountVaultArchive(mnemonic, archive))) {
    throw new Error('Не удалось восстановить облачную копию на устройстве.');
  }
  log.info('cloud_vault_restored', { accountId: envelope.accountId, savedAt: envelope.savedAt });
  return 'restored';
}

export function isCloudVaultConfigured(): boolean {
  return cloudBaseUrl() !== null;
}
