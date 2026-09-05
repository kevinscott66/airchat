/**
 * Вход по биометрии.
 *
 * Проверяется порядок записей, а не сам системный запрос: он нативный, и в
 * тесте его нет. Порядок и есть то, что здесь можно сломать молча — признак
 * «включено» и запертый пароль живут раздельно, и любая их рассинхронизация
 * даёт либо кнопку, которая ничего не открывает, либо забытый в хранилище
 * пароль.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const s: Record<string, string | undefined> = {};
  return {
    __store: s,
    getItemAsync: jest.fn(async (key: string) => s[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { s[key] = value; }),
    deleteItemAsync: jest.fn(async (key: string) => { delete s[key]; }),
  };
});

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  canUseBiometricAuthentication: jest.fn(() => true),
}));

import {
  BIOMETRIC_SECURE_KEYS,
  disableBiometricUnlock,
  enableBiometricUnlock,
  isBiometricAvailable,
  isBiometricUnlockEnabled,
  readBiometricPassword,
} from '../biometricUnlock';

const store = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string | undefined>;
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};
const expo = jest.requireMock('expo-secure-store') as { canUseBiometricAuthentication: jest.Mock };

const [SECRET_KEY, FLAG_KEY] = BIOMETRIC_SECURE_KEYS;

beforeEach(() => {
  for (const k of Object.keys(store.__store)) delete store.__store[k];
  store.getItemAsync.mockClear();
  store.setItemAsync.mockClear();
  store.deleteItemAsync.mockClear();
  expo.canUseBiometricAuthentication.mockReturnValue(true);
});

describe('biometricUnlock', () => {
  it('выключен, пока не включили', async () => {
    expect(await isBiometricUnlockEnabled()).toBe(false);
    expect(await readBiometricPassword()).toBeNull();
  });

  it('включение кладёт пароль и признак, чтение отдаёт пароль', async () => {
    expect(await enableBiometricUnlock('secret123')).toBe(true);
    expect(await isBiometricUnlockEnabled()).toBe(true);
    expect(await readBiometricPassword()).toBe('secret123');
  });

  it('пароль пишется под запросом биометрии, признак — без него', async () => {
    await enableBiometricUnlock('secret123');
    const calls = store.setItemAsync.mock.calls as Array<[string, string, Record<string, unknown>?]>;
    const secretCall = calls.find(([key]) => key === SECRET_KEY);
    const flagCall = calls.find(([key]) => key === FLAG_KEY);
    expect(secretCall?.[2]).toMatchObject({ requireAuthentication: true });
    // Признак спрашивается при каждом открытии приложения; будь он заперт,
    // Face ID поднимался бы ещё до того, как человек об этом попросил.
    expect(flagCall?.[2]).toBeUndefined();
  });

  it('признак ставится после пароля: отказ на запросе не оставляет пустую кнопку', async () => {
    store.setItemAsync.mockImplementationOnce(async () => { throw new Error('user cancelled'); });
    expect(await enableBiometricUnlock('secret123')).toBe(false);
    expect(await isBiometricUnlockEnabled()).toBe(false);
  });

  it('без настроенной биометрии включать нечего', async () => {
    expo.canUseBiometricAuthentication.mockReturnValue(false);
    expect(isBiometricAvailable()).toBe(false);
    expect(await enableBiometricUnlock('secret123')).toBe(false);
    expect(await isBiometricUnlockEnabled()).toBe(false);
  });

  it('пустой пароль не сохраняется', async () => {
    expect(await enableBiometricUnlock('')).toBe(false);
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  it('выключение снимает признак первым и стирает пароль', async () => {
    await enableBiometricUnlock('secret123');
    store.deleteItemAsync.mockClear();
    await disableBiometricUnlock();
    const order = (store.deleteItemAsync.mock.calls as Array<[string]>).map(([key]) => key);
    expect(order[0]).toBe(FLAG_KEY);
    expect(order).toContain(SECRET_KEY);
    expect(await isBiometricUnlockEnabled()).toBe(false);
    expect(await readBiometricPassword()).toBeNull();
  });

  it('отказ на стирании пароля всё равно выключает биометрию', async () => {
    await enableBiometricUnlock('secret123');
    store.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === SECRET_KEY) throw new Error('user cancelled');
      delete store.__store[key];
    });
    await disableBiometricUnlock();
    expect(await isBiometricUnlockEnabled()).toBe(false);
    // Пароль остался в хранилище, но добраться до него больше нечем.
    expect(await readBiometricPassword()).toBeNull();
  });

  it('отказ на чтении отдаёт null, а не роняет экран блокировки', async () => {
    await enableBiometricUnlock('secret123');
    store.getItemAsync.mockImplementation(async (key: string) => {
      if (key === SECRET_KEY) throw new Error('user cancelled');
      return store.__store[key] ?? null;
    });
    expect(await readBiometricPassword()).toBeNull();
  });
});
