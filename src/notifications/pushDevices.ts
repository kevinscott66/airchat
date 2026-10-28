import { loadKeyPair, type KeyPairBytes } from '../core/crypto/keyManager';
import { publicKeyToB64 } from '../core/crypto/pubKeyFormat';
import { fetchWithDeadline } from '../core/net/timedFetch';
import { signJson } from '../core/crypto/signature';
import { deriveKeyPairFromMnemonicForProfile } from '../core/backup/seedPhrase';
import { loadConfig } from '../core/config';
import { peerIdFromDid, signPushPayload } from './pushEnvelope';

export type PushDevice = { deviceId: string; platform: string; updatedAt: number };

export async function pushDeviceId(): Promise<string> {
  const { syncDeviceId } = await import('../core/sync/syncApi');
  return syncDeviceId();
}

async function request<T>(did: string, deviceId: string | undefined, pair: KeyPairBytes | undefined, read: (response: Response) => Promise<T>): Promise<T> {
  const peerId = peerIdFromDid(did);
  const base = (await loadConfig()).webrtc?.signalingUrl;
  if (!peerId || !base) throw new Error('Сервер уведомлений не настроен.');
  const payload = {
    act: deviceId ? 'push_revoke' : 'push_devices', peerId,
    ...(deviceId ? { deviceId } : {}), ts: Date.now(),
  };
  const envelope = pair ? await signJson(pair, payload) : await signPushPayload(payload);
  if (!envelope) throw new Error('Не удалось подписать запрос уведомлений.');
  return fetchWithDeadline(`${base}/${deviceId ? 'unregister-token' : 'push-devices'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope),
  }, { timeoutMs: 10000 }, read);
}

/** null means an older/unavailable server; never report that as disabled push. */
export async function listPushDevices(did: string): Promise<PushDevice[] | null> {
  try {
    return await request(did, undefined, undefined, async (response) => {
      if (!response.ok) return null;
      if (Number(response.headers?.get('content-length') ?? 0) > 8192) return null;
      const text = await response.text();
      if (text.length > 8192) return null;
      const body = JSON.parse(text) as { devices?: unknown[] };
      if (!Array.isArray(body.devices) || body.devices.length > 8) return null;
      const devices: PushDevice[] = [];
      for (const value of body.devices) {
        if (!value || typeof value !== 'object') return null;
        const item = value as PushDevice;
        if (typeof item.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.deviceId) ||
          !['android', 'ios', 'web'].includes(item.platform) ||
          !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) return null;
        devices.push({ deviceId: item.deviceId, platform: item.platform, updatedAt: item.updatedAt });
      }
      return devices;
    });
  } catch { return null; }
}

export async function revokePushDevice(did: string, deviceId: string, pair?: KeyPairBytes): Promise<boolean> {
  return request(did, deviceId, pair, async (response) => {
    if (response.status === 404) return false;
    if (!response.ok) throw new Error('Не удалось отключить уведомления устройства. Повторите позже.');
    return true;
  });
}

/** A sync session serves every local profile; revoke each matching push slot. */
export async function revokeProfilePushDevices(
  deviceId: string, mnemonic: string,
  profiles: ReadonlyArray<{ did: string; derivationIndex: number }>,
): Promise<boolean> {
  if (!profiles.length) throw new Error('Список профилей недоступен.');
  let supported = true;
  for (const profile of profiles) {
    const pair = deriveKeyPairFromMnemonicForProfile(mnemonic, profile.derivationIndex);
    supported = (await revokePushDevice(profile.did, deviceId, pair)) && supported;
  }
  return supported;
}

/** Keep the registration owner's key, not whichever profile is active at logout. */
export async function capturePushDeviceRevoker(did: string, deviceId: string): Promise<(() => Promise<boolean>) | null> {
  const pair = await loadKeyPair();
  if (!pair || publicKeyToB64(pair.publicKey) !== peerIdFromDid(did)) return null;
  return () => revokePushDevice(did, deviceId, pair);
}
