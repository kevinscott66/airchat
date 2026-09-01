import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { accountIdFromPublicKey, accountVaultIdFromMnemonic } from '../storage/accountVault';
import { ED25519_SECRET_KEY_BYTES } from '../crypto/keyManager';
import { deriveKeyPairFromMnemonic } from '../backup/seedPhrase';
import { getConfigSync } from '../config';
import { signJson } from '../crypto/signature';
import type { KeyPairBytes } from '../crypto/keyManager';
import * as SecureStore from '../storage/secureStoreQueued';
import type {
  SyncMutation,
  SyncPullResponse,
  SyncPushResponse,
} from './syncProtocol';

const DEVICE_ID_KEY = 'airchat_sync_device_id_v1';
const DEVICE_SECRET_KEY = 'airchat_sync_device_secret_v1';
const DEVICE_PUBLIC_KEY = 'airchat_sync_device_public_v1';
const REQUEST_VERSION = 1;
const SYNC_REQUEST_TIMEOUT_MS = 15_000;

export const SYNC_DEVICE_SECURE_KEYS = [DEVICE_ID_KEY, DEVICE_SECRET_KEY, DEVICE_PUBLIC_KEY] as const;

export type SyncDeviceInfo = {
  platform: 'ios' | 'android' | 'web' | 'macos' | 'windows';
  model: string;
  osVersion: string;
  appVersion: string;
};

function currentDeviceInfo(): SyncDeviceInfo {
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web'
    || Platform.OS === 'macos' || Platform.OS === 'windows' ? Platform.OS : 'web';
  const nativeConstants = Platform.constants as typeof Platform.constants & {
    Manufacturer?: string;
    Model?: string;
    Release?: string;
    osVersion?: string;
  };
  const model = platform === 'android'
    ? `${nativeConstants.Manufacturer || 'Android'} ${nativeConstants.Model || 'device'}`
    : platform === 'ios'
      ? (Constants.platform?.ios?.model || (Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone'))
      : platform === 'web' ? 'Web browser' : platform;
  const osVersion = platform === 'android'
    ? String(nativeConstants.Release || Platform.Version)
    : platform === 'ios'
      ? String(nativeConstants.osVersion || Platform.Version)
      : String(Platform.Version || 'unknown');
  const appVersion = String(Constants.expoConfig?.version || Constants.nativeAppVersion || 'unknown');
  return {
    platform,
    model: model.replace(/\s+/g, ' ').trim().slice(0, 96) || 'Unknown device',
    osVersion: osVersion.slice(0, 32) || 'unknown',
    appVersion: appVersion.slice(0, 32) || 'unknown',
  };
}

export function syncDeviceInfo(): SyncDeviceInfo {
  return currentDeviceInfo();
}

function syncBaseUrl(): string | null {
  const cloudBackup = getConfigSync().cloudBackup;
  if (!cloudBackup?.enabled) return null;
  const base = cloudBackup.baseUrl;
  return base ? base.replace(/\/+$/, '') : null;
}

type SyncDeviceAuth = {
  deviceId: string;
  pair: KeyPairBytes;
};

let deviceAuthPromise: Promise<SyncDeviceAuth> | null = null;
let deviceAuthEpoch = 0;
let deviceCredentialsClearPromise: Promise<void> | null = null;

async function deviceAuth(): Promise<SyncDeviceAuth> {
  if (deviceCredentialsClearPromise) {
    await deviceCredentialsClearPromise;
    return deviceAuth();
  }
  if (deviceAuthPromise) return deviceAuthPromise;
  const epoch = deviceAuthEpoch;
  deviceAuthPromise = (async () => {
    const assertCurrent = () => {
      if (epoch !== deviceAuthEpoch) throw new Error('Ключ устройства был сброшен.');
    };
    const secretRaw = await SecureStore.getItemAsync(DEVICE_SECRET_KEY);
    assertCurrent();
    let secretKey: Uint8Array;
    if (secretRaw) {
      secretKey = new Uint8Array(Buffer.from(secretRaw, 'base64'));
      if (secretKey.length !== ED25519_SECRET_KEY_BYTES) throw new Error('Повреждён ключ устройства.');
    } else {
      secretKey = randomBytes(ED25519_SECRET_KEY_BYTES);
      assertCurrent();
      await SecureStore.setItemAsync(DEVICE_SECRET_KEY, Buffer.from(secretKey).toString('base64'));
    }
    assertCurrent();
    const publicKey = ed25519.getPublicKey(secretKey);
    const publicKeyB64 = Buffer.from(publicKey).toString('base64');
    if ((await SecureStore.getItemAsync(DEVICE_PUBLIC_KEY)) !== publicKeyB64) {
      assertCurrent();
      await SecureStore.setItemAsync(DEVICE_PUBLIC_KEY, publicKeyB64);
    }
    const fingerprint = Buffer.from(sha256(publicKey)).toString('hex').slice(0, 24);
    const nextDeviceId = `device-${fingerprint}`;
    if ((await SecureStore.getItemAsync(DEVICE_ID_KEY)) !== nextDeviceId) {
      assertCurrent();
      await SecureStore.setItemAsync(DEVICE_ID_KEY, nextDeviceId);
    }
    assertCurrent();
    return { deviceId: nextDeviceId, pair: { publicKey, secretKey } };
  })().catch((error) => {
    deviceAuthPromise = null;
    throw error;
  });
  return deviceAuthPromise;
}

export async function syncDeviceId(): Promise<string> {
  return (await deviceAuth()).deviceId;
}

function responseError(status: number, code?: string): Error {
  if (code === 'device_revoked') return new Error('Это устройство отозвано. Войдите снова на этом устройстве.');
  if (status === 401 || status === 403) return new Error('Синхронизация отклонена сервером.');
  if (status === 409) return new Error('Устройство или версия данных устарели.');
  if (status === 429) return new Error('Слишком много запросов синхронизации.');
  if (status === 413) return new Error('Облачное хранилище переполнено.');
  return new Error(`Сервер синхронизации недоступен (HTTP ${status}).`);
}

async function fetchSigned<T>(url: string, signed: { payload: string; signature: string }): Promise<T> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timeout = setTimeout(() => controller?.abort(), SYNC_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch {
      if (controller?.signal.aborted) throw new Error('Сервер синхронизации не отвечает.');
      throw new Error('Нет соединения с сервером синхронизации.');
    }
    if (!response.ok) {
      let code: string | undefined;
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === 'string') code = body.error;
      } catch { /* non-JSON proxy error */ }
      throw responseError(response.status, code);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

let enrollmentForDevice: { key: string; promise: Promise<void> } | null = null;

async function ensureDeviceEnrolled(mnemonic: string, accountPair: KeyPairBytes, auth: SyncDeviceAuth): Promise<void> {
  const base = syncBaseUrl();
  if (!base) throw new Error('Сервер синхронизации не настроен.');
  const accountId = accountIdFromPublicKey(accountPair.publicKey);
  const legacyAccountId = accountVaultIdFromMnemonic(mnemonic);
  const enrollmentKey = `${accountId}:${auth.deviceId}`;
  if (enrollmentForDevice?.key === enrollmentKey) return enrollmentForDevice.promise;
  const promise = (async () => {
    const accountPublicKeyB64 = Buffer.from(accountPair.publicKey).toString('base64');
    const devicePublicKeyB64 = Buffer.from(auth.pair.publicKey).toString('base64');
    const payload = {
      v: REQUEST_VERSION,
      op: 'enroll',
      accountId,
      legacyAccountId,
      publicKeyB64: accountPublicKeyB64,
      accountPublicKeyB64,
      deviceId: auth.deviceId,
      devicePublicKeyB64,
      deviceLabel: `AirChat ${Platform.OS}`,
      timestamp: Date.now(),
      nonce: Buffer.from(randomBytes(16)).toString('base64url'),
      deviceInfo: currentDeviceInfo(),
    };
    await fetchSigned(`${base}/v1/sync/${accountId}/devices/enroll`, await signJson(accountPair, payload));
  })().catch((error) => {
    if (enrollmentForDevice?.key === enrollmentKey) enrollmentForDevice = null;
    throw error;
  });
  enrollmentForDevice = { key: enrollmentKey, promise };
  return promise;
}

export async function getSyncDeviceAuth(mnemonic: string): Promise<SyncDeviceAuth> {
  const accountPair = deriveKeyPairFromMnemonic(mnemonic);
  const auth = await deviceAuth();
  await ensureDeviceEnrolled(mnemonic, accountPair, auth);
  return auth;
}

export async function clearSyncDeviceCredentials(): Promise<void> {
  if (deviceCredentialsClearPromise) return deviceCredentialsClearPromise;
  const pending = deviceAuthPromise;
  deviceAuthEpoch += 1;
  deviceAuthPromise = null;
  enrollmentForDevice = null;
  const clear = (async () => {
    // Wait for a read/write already in progress before deleting. The epoch
    // check makes it fail before any subsequent write, while this await closes
    // the small window where a write was already inside SecureStore.
    await pending?.catch(() => {});
    for (const key of SYNC_DEVICE_SECURE_KEYS) await SecureStore.deleteItemAsync(key);
  })().finally(() => {
    if (deviceCredentialsClearPromise === clear) deviceCredentialsClearPromise = null;
  });
  deviceCredentialsClearPromise = clear;
  return clear;
}

async function request<T>(
  mnemonic: string,
  _pair: KeyPairBytes,
  operation: string,
  extra: Record<string, unknown> = {},
  pathOperation = operation,
): Promise<T> {
  const base = syncBaseUrl();
  if (!base) throw new Error('Сервер синхронизации не настроен.');
  // Sync belongs to the seed-bound account, not to one local profile. Using
  // the active profile key here made profile 2+ fail after profile 1 had
  // registered the account on the server.
  const accountPair = deriveKeyPairFromMnemonic(mnemonic);
  const accountId = accountIdFromPublicKey(accountPair.publicKey);
  const legacyAccountId = accountVaultIdFromMnemonic(mnemonic);
  const auth = await getSyncDeviceAuth(mnemonic);
  const accountPublicKeyB64 = Buffer.from(accountPair.publicKey).toString('base64');
  const devicePublicKeyB64 = Buffer.from(auth.pair.publicKey).toString('base64');
  const payload = {
    v: REQUEST_VERSION,
    op: operation,
    accountId,
    legacyAccountId,
    publicKeyB64: devicePublicKeyB64,
    accountPublicKeyB64,
    deviceId: auth.deviceId,
    devicePublicKeyB64,
    deviceLabel: `AirChat ${Platform.OS}`,
    timestamp: Date.now(),
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    deviceInfo: currentDeviceInfo(),
    ...extra,
  };
  const signed = await signJson(auth.pair, payload);
  return fetchSigned<T>(`${base}/v1/sync/${accountId}/${pathOperation}`, signed);
}

export function pushSyncMutations(
  mnemonic: string,
  pair: KeyPairBytes,
  mutations: SyncMutation[],
): Promise<SyncPushResponse> {
  return request<SyncPushResponse>(mnemonic, pair, 'push', { mutations });
}

export function pullSyncMutations(
  mnemonic: string,
  pair: KeyPairBytes,
  cursor: string | null,
  ownerProfileId: number,
  limit = 100,
): Promise<SyncPullResponse> {
  return request<SyncPullResponse>(mnemonic, pair, 'pull', { cursor, ownerProfileId, limit });
}

export async function uploadSyncMedia(
  mnemonic: string,
  pair: KeyPairBytes,
  mediaId: string,
  ciphertext: Uint8Array,
  mime?: string,
): Promise<boolean> {
  const ciphertextB64 = Buffer.from(ciphertext).toString('base64');
  const response = await request<{ ok: boolean }>(
    mnemonic,
    pair,
    'media_put',
    { mediaId, ciphertextB64, mime },
    'media/put',
  );
  return response.ok === true;
}

export async function downloadSyncMedia(
  mnemonic: string,
  pair: KeyPairBytes,
  mediaId: string,
): Promise<Uint8Array | null> {
  try {
    const response = await request<{ mediaId: string; ciphertextB64: string }>(
      mnemonic,
      pair,
      'media_get',
      { mediaId },
      'media/get',
    );
    if (response.mediaId !== mediaId || typeof response.ciphertextB64 !== 'string') return null;
    const bytes = new Uint8Array(Buffer.from(response.ciphertextB64, 'base64'));
    return bytes.length > 0 ? bytes : null;
  } catch {
    // A missing cloud copy is expected for legacy blobs; other errors remain
    // best-effort because relay/LAN delivery may still succeed.
    return null;
  }
}

/** Keep server-side media retention aligned with encrypted message references. */
export function setSyncMediaReference(
  mnemonic: string,
  pair: KeyPairBytes,
  mediaId: string,
  referenceId: string,
  present: boolean,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    mnemonic,
    pair,
    'media_reference',
    { mediaId, referenceId, present },
    'media/reference',
  );
}

/** Mark a cloud media object for deferred deletion after references release. */
export function deleteSyncMedia(
  mnemonic: string,
  pair: KeyPairBytes,
  mediaId: string,
): Promise<{ ok: boolean; pending: boolean; activeReferences: number }> {
  return request<{ ok: boolean; pending: boolean; activeReferences: number }>(
    mnemonic,
    pair,
    'media_delete',
    { mediaId },
    'media/delete',
  );
}

/** Run account-scoped media GC; deletion remains reference-aware on the server. */
export function gcSyncMedia(
  mnemonic: string,
  pair: KeyPairBytes,
): Promise<{ ok: boolean; deleted: number }> {
  return request<{ ok: boolean; deleted: number }>(mnemonic, pair, 'media_gc', {}, 'media/gc');
}

export type SyncDevice = {
  deviceId: string;
  devicePublicKeyB64: string | null;
  label: string | null;
  platform: SyncDeviceInfo['platform'] | null;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  countryCode: string | null;
  city: string | null;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

export async function listSyncDevices(
  mnemonic: string,
  pair: KeyPairBytes,
): Promise<SyncDevice[]> {
  const response = await request<{ devices: SyncDevice[] }>(mnemonic, pair, 'list_devices', {}, 'devices');
  return Array.isArray(response.devices) ? response.devices : [];
}

export function revokeSyncDevice(
  mnemonic: string,
  pair: KeyPairBytes,
  targetDeviceId: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(mnemonic, pair, 'revoke_device', { targetDeviceId }, 'devices/revoke');
}
