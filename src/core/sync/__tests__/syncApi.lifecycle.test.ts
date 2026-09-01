jest.mock('../../storage/secureStoreQueued', () => {
  const secure = new Map<string, string>();
  let releaseSecretRead: ((value: string | null) => void) | null = null;
  const getItemAsync = jest.fn((key: string): Promise<string | null> => {
    if (key === 'airchat_sync_device_secret_v1' && releaseSecretRead === null) {
      return new Promise((resolve) => { releaseSecretRead = resolve; });
    }
    return Promise.resolve(secure.get(key) ?? null);
  });
  const setItemAsync = jest.fn(async (key: string, value: string) => { secure.set(key, value); });
  const deleteItemAsync = jest.fn(async (key: string) => { secure.delete(key); });
  return {
    getItemAsync,
    setItemAsync,
    deleteItemAsync,
    __reset: () => {
      secure.clear();
      getItemAsync.mockClear();
      setItemAsync.mockClear();
      deleteItemAsync.mockClear();
      releaseSecretRead = null;
    },
    __releaseSecretRead: (value: string | null) => releaseSecretRead?.(value),
  };
});
jest.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '18.0', constants: {}, isPad: false },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' }, nativeAppVersion: '1.0.0', platform: { ios: { model: 'iPhone' } } },
}));
jest.mock('../../storage/accountVault', () => ({
  accountIdFromPublicKey: jest.fn(() => 'account-id'),
  accountVaultIdFromMnemonic: jest.fn(() => 'legacy-id'),
}));
jest.mock('../../backup/seedPhrase', () => ({
  deriveKeyPairFromMnemonic: jest.fn(() => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) })),
}));
jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({ cloudBackup: { enabled: true, baseUrl: 'https://sync.example' } })),
}));
jest.mock('../../crypto/signature', () => ({ signJson: jest.fn(async () => ({ payload: '{}', signature: 'sig' })) }));
jest.mock('../../crypto/keyManager', () => ({ ED25519_SECRET_KEY_BYTES: 32 }));

import { clearSyncDeviceCredentials, getSyncDeviceAuth } from '../syncApi';

const mockStore = jest.requireMock('../../storage/secureStoreQueued') as {
  __reset: () => void;
  __releaseSecretRead: (value: string | null) => void;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

beforeEach(() => mockStore.__reset());

it('does not recreate device credentials after a concurrent clear', async () => {
  const auth = getSyncDeviceAuth('valid seed');
  await Promise.resolve();

  const clear = clearSyncDeviceCredentials();
  mockStore.__releaseSecretRead(null);

  await clear;
  await expect(auth).rejects.toThrow('Ключ устройства был сброшен.');
  expect(mockStore.setItemAsync).not.toHaveBeenCalled();
  expect(mockStore.deleteItemAsync).toHaveBeenCalledTimes(3);
});
