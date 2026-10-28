let mockPair = { publicKey: 'owner', index: 0 };
jest.mock('../../core/crypto/keyManager', () => ({ loadKeyPair: async () => mockPair }));
jest.mock('../../core/crypto/pubKeyFormat', () => ({ publicKeyToB64: (key: string) => key }));
jest.mock('../../core/config', () => ({ loadConfig: async () => ({ webrtc: { signalingUrl: 'https://signal.test' } }) }));
jest.mock('../pushEnvelope', () => ({ peerIdFromDid: (did: string) => did, signPushPayload: async (value: unknown) => value }));
jest.mock('../../core/crypto/signature', () => ({ signJson: async (pair: { index: number }, value: unknown) => ({ value, signerIndex: pair.index }) }));
jest.mock('../../core/backup/seedPhrase', () => ({ deriveKeyPairFromMnemonicForProfile: (_seed: string, index: number) => ({ index }) }));
jest.mock('../../core/sync/syncApi', () => ({ syncDeviceId: async () => 'device-stable' }));
import { listPushDevices, pushDeviceId, revokePushDevice, revokeProfilePushDevices, capturePushDeviceRevoker } from '../pushDevices';

beforeEach(() => {
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204, text: async () => JSON.stringify({ devices: [] }) });
});
test('uses the sync installation identity', async () => { expect(await pushDeviceId()).toBe('device-stable'); });
test('an unavailable list is unknown, not an empty list', async () => {
  (fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
  expect(await listPushDevices('peer')).toBeNull();
});
test('old-server revoke reports unsupported and network failure is not success', async () => {
  (fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
  expect(await revokePushDevice('peer', 'phone')).toBe(false);
  (fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  await expect(revokePushDevice('peer', 'phone')).rejects.toThrow('offline');
});
test('session revocation covers all local profiles with their own signing keys', async () => {
  await expect(revokeProfilePushDevices('phone', 'fixture seed', [
    { did: 'peer-one', derivationIndex: 0 }, { did: 'peer-two', derivationIndex: 3 },
  ])).resolves.toBe(true);
  const payloads = (fetch as jest.Mock).mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(payloads.map((body) => body.signerIndex)).toEqual([0, 3]);
  expect(payloads.map((body) => body.value.peerId)).toEqual(['peer-one', 'peer-two']);
  expect(payloads.every((body) => body.value.deviceId === 'phone' && body.value.act === 'push_revoke')).toBe(true);
});

test('captured revocation still signs as the owner after the active profile switches', async () => {
  mockPair = { publicKey: 'owner', index: 0 };
  const revoke = await capturePushDeviceRevoker('owner', 'phone');
  mockPair = { publicKey: 'other', index: 3 };
  expect(await capturePushDeviceRevoker('owner', 'phone')).toBeNull();
  await revoke!();
  const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
  expect(body.signerIndex).toBe(0);
  expect(body.value.peerId).toBe('owner');
});
test.each([
  { devices: Array(9).fill({ deviceId: 'phone', platform: 'ios', updatedAt: 1 }) },
  { devices: [{ deviceId: 'phone', platform: 'unknown', updatedAt: 1 }] },
  { devices: [{ deviceId: '../invalid', platform: 'ios', updatedAt: 1 }] },
])('rejects malformed or oversized device listings', async (body) => {
  (fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
  expect(await listPushDevices('owner')).toBeNull();
});
test('the deadline includes a response body that never completes', async () => {
  jest.useFakeTimers();
  try {
    (fetch as jest.Mock).mockImplementation(async (_url, init) => ({
      ok: true,
      text: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }));
    const result = listPushDevices('owner');
    await jest.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toBeNull();
  } finally { jest.useRealTimers(); }
});
