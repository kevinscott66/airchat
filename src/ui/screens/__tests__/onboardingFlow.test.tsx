/**
 * Путь нового аккаунта через онбординг — по отрисованному экрану.
 *
 * AC-20: на Android онбординг больше не начинается со сводки из пяти
 * системных разрешений — первым человек видит приветствие. Шаги пишутся в
 * журнал событием без слов, ключей и идентификаторов.
 */
import React from 'react';
import { Platform } from 'react-native';

import { getByRole, press, queryAllByRole, render, unmount } from '../../__tests__/support/renderA11y';

jest.mock('../../components/AuthBackdrop', () => ({ AuthBackdrop: () => null }));
jest.mock('../../components/GlassSurface', () => {
  const { View } = jest.requireActual('react-native');
  return { GlassSurface: ({ children }: { children?: React.ReactNode }) => <View>{children}</View> };
});
jest.mock('../../components/SafeScreen', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeScreen: ({ children }: { children?: React.ReactNode }) => <View>{children}</View> };
});
jest.mock('../../components/SecretScreenGuard', () => {
  const { View } = jest.requireActual('react-native');
  return {
    SecretScreenGuard: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
  };
});
jest.mock('../../components/WelcomeStage', () => {
  const { View } = jest.requireActual('react-native');
  return {
    WelcomeLayout: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    WelcomeSheen: () => null,
  };
});
jest.mock('../../components/AirChatLockup', () => ({ AirChatLockup: () => null }));
jest.mock('../../components/ThemeSwitchButton', () => ({ ThemeSwitchButton: () => null }));
jest.mock('../../components/LoadingOverlay', () => ({ LoadingOverlay: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const WORDS = Array.from({ length: 24 }, (_, i) => `слово${i + 1}`);

jest.mock('../../../core/backup/seedPhrase', () => ({
  generateMnemonicAndStore: jest.fn(async () => ({
    mnemonic: Array.from({ length: 24 }, (_, i) => `слово${i + 1}`).join(' '),
    pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  })),
  getStoredMnemonic: jest.fn(async () => null),
  hasSeedShown: jest.fn(async () => true),
  hasStoredMnemonic: jest.fn(async () => false),
  importEncryptedBackup: jest.fn(),
  restoreFromMnemonic: jest.fn(),
  setFirstLaunchDone: jest.fn(async () => undefined),
  setSeedShown: jest.fn(async () => undefined),
  wipeMnemonicAndSessionFlags: jest.fn(),
}));
jest.mock('../../../core/crypto/keyManager', () => ({
  deleteKeyPairFromStore: jest.fn(),
  loadKeyPair: jest.fn(async () => null),
}));
jest.mock('../../../core/backup/cloudVault', () => ({
  isCloudVaultConfigured: () => false,
  restoreCloudVault: jest.fn(),
}));
jest.mock('../../../core/backup/seedBinding', () => ({
  decryptSeedBinding: jest.fn(),
  fetchSeedBinding: jest.fn(),
  listSeedBindingProviders: jest.fn(async () => []),
}));
jest.mock('../../../core/auth/appleSignIn', () => ({
  isAppleSignInAvailable: jest.fn(async () => false),
  signInWithApple: jest.fn(),
}));
jest.mock('../../../core/security/authGuard', () => ({
  authGuard: { setPassword: jest.fn() },
}));
jest.mock('../../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { OnboardingScreen } from '../OnboardingScreen';
import { log } from '../../../core/logger';

const originalOS = Platform.OS;
function setOS(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}
afterEach(() => {
  setOS(originalOS);
  jest.clearAllMocks();
});

/** Всё, что ушло в журнал, одной строкой — чтобы искать в ней слова. */
function everythingLogged(): string {
  const l = log as unknown as Record<string, jest.Mock>;
  return JSON.stringify(['debug', 'info', 'warn', 'error'].map((k) => l[k].mock.calls));
}

describe('AC-20: разрешения не в обязательном пути', () => {
  it.each(['android', 'ios'] as const)('%s: первым открывается приветствие, а не сводка разрешений', async (os) => {
    setOS(os);
    const r = await render(<OnboardingScreen onComplete={jest.fn()} />);
    expect(getByRole(r.root, 'button', { name: 'Создать новый аккаунт' })).toBeTruthy();
    expect(queryAllByRole(r.root, 'button', { name: 'Разрешить всё' })).toHaveLength(0);
    await unmount(r);
  });

  it('заведение аккаунта пишет событие шага без слов и ключей', async () => {
    const r = await render(<OnboardingScreen onComplete={jest.fn()} />);
    await press(getByRole(r.root, 'button', { name: 'Создать новый аккаунт' }));
    expect(log.info).toHaveBeenCalledWith('onboarding_account_created', {});
    const logged = everythingLogged();
    for (const w of WORDS) expect(logged).not.toContain(w);
    await unmount(r);
  });
});
