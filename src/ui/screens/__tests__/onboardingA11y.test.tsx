/**
 * AC-13: основные действия входа — кнопки с именем, поля — с подписью.
 *
 * Раньше «Создать новый аккаунт», «Восстановить аккаунт» и «Восстановить» были
 * нажимаемыми без роли и без имени: озвучка читала их как безымянную группу,
 * а на вебе это был фокусируемый `div`. Поля ввода держались на placeholder,
 * который исчезает с первым символом, — подписи не оставалось ни глазу, ни
 * озвучке.
 *
 * Проверка идёт по отрисованному дереву, а не по исходнику: кнопку ищем так,
 * как её ищет озвучка (роль + имя), поле — по подписи. Декоративные компоненты
 * (стекло, фон, сцена приветствия) подменены простыми View — к доступности они
 * отношения не имеют, а в jest тянут нативные модули.
 */
import React from 'react';

import {
  changeText,
  getByLabelText,
  getByRole,
  press,
  queryAllByRole,
  render,
  unmount,
  visibleLabelOf,
} from '../../__tests__/support/renderA11y';

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
jest.mock('../../components/PinPad', () => ({ PinPad: () => null }));
jest.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../core/backup/seedPhrase', () => ({
  generateMnemonicAndStore: jest.fn(),
  getStoredMnemonic: jest.fn(async () => null),
  hasSeedShown: jest.fn(async () => true),
  hasStoredMnemonic: jest.fn(async () => false),
  importEncryptedBackup: jest.fn(),
  restoreFromMnemonic: jest.fn(),
  setFirstLaunchDone: jest.fn(),
  setSeedShown: jest.fn(),
  wipeMnemonicAndSessionFlags: jest.fn(),
}));
jest.mock('../../../core/crypto/keyManager', () => ({
  deleteKeyPairFromStore: jest.fn(),
  loadKeyPair: jest.fn(async () => null),
}));
jest.mock('../../../core/backup/cloudVault', () => ({
  // Облако включено — чтобы на шаге восстановления появилось и поле
  // пароля приложения: у него тоже должна быть подпись.
  isCloudVaultConfigured: () => true,
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
  AUTH_MAX_ATTEMPTS: 5,
  authGuard: {
    getRemainingAttempts: jest.fn(async () => 5),
    getLockoutTimeRemaining: jest.fn(async () => 0),
    checkPassword: jest.fn(async () => false),
    setPassword: jest.fn(),
  },
}));
jest.mock('../../../core/security/biometricUnlock', () => ({
  isBiometricUnlockEnabled: jest.fn(async () => false),
  readBiometricPassword: jest.fn(async () => null),
}));
jest.mock('../../../core/identity/profile', () => ({ buildSignedProfile: jest.fn() }));
jest.mock('../../../core/identity/profileManager', () => ({
  profileManager: { init: jest.fn(), getActiveProfile: jest.fn(() => null), renameProfile: jest.fn() },
}));

import { OnboardingScreen } from '../OnboardingScreen';
import { LoginScreen } from '../LoginScreen';
import { PasswordScreen } from '../PasswordScreen';

const PAIR = { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(64).fill(2) };

describe('Приветствие: основные действия озвучиваются как кнопки', () => {
  it('«Создать новый аккаунт» и «Восстановить аккаунт» — кнопки с именем', async () => {
    const r = await render(<OnboardingScreen onComplete={jest.fn()} />);
    expect(getByRole(r.root, 'button', { name: 'Создать новый аккаунт' })).toBeTruthy();
    expect(getByRole(r.root, 'button', { name: 'Восстановить аккаунт' })).toBeTruthy();
    await unmount(r);
  });

  it('шаг восстановления: у полей есть видимая подпись, у действия — роль и имя', async () => {
    const r = await render(<OnboardingScreen onComplete={jest.fn()} />);
    await press(getByRole(r.root, 'button', { name: 'Восстановить аккаунт' }));

    const seed = getByLabelText(r.root, 'Секретные слова или резервная копия');
    // Подпись не только для озвучки: её же видно на экране, и после ввода
    // первого слова она остаётся (placeholder бы исчез).
    expect(visibleLabelOf(r.root, seed)).toBe('Секретные слова или резервная копия');
    await changeText(seed, 'abandon abandon');
    expect(visibleLabelOf(r.root, getByLabelText(r.root, 'Секретные слова или резервная копия'))).toBe(
      'Секретные слова или резервная копия'
    );

    const cloud = getByLabelText(r.root, 'Пароль приложения');
    expect(visibleLabelOf(r.root, cloud)).toBe('Пароль приложения');

    expect(getByRole(r.root, 'button', { name: 'Восстановить' })).toBeTruthy();
    await unmount(r);
  });
});

describe('Вход по имени', () => {
  it('поле «Имя» подписано, действие — кнопка', async () => {
    const r = await render(<LoginScreen pair={PAIR as never} onDone={jest.fn()} />);
    const name = getByLabelText(r.root, 'Имя');
    expect(visibleLabelOf(r.root, name)).toBe('Имя');
    expect(getByRole(r.root, 'button', { name: 'Создать / войти' })).toBeTruthy();
    await unmount(r);
  });
});

describe('Пароль приложения', () => {
  it('поле пароля подписано видимой подсказкой, «Забыли пароль?» — кнопка', async () => {
    const r = await render(<PasswordScreen onSuccess={jest.fn()} onForgot={jest.fn()} />);
    // По умолчанию открыт PIN-блок; переключатель на текстовый пароль — тоже кнопка.
    await press(getByRole(r.root, 'button', { name: 'Ввести текстовый пароль' }));
    const field = getByLabelText(r.root, 'Пароль приложения');
    expect(visibleLabelOf(r.root, field)).toBe('Введите пароль');
    expect(getByRole(r.root, 'button', { name: 'Ввести PIN-код' })).toBeTruthy();
    expect(getByRole(r.root, 'button', { name: 'Забыли пароль?' })).toBeTruthy();
    await unmount(r);
  });
});

describe('AppPressable: роль задаёт вызывающий', () => {
  it('без явной роли кнопкой не становится; явная роль и имя доходят до host-элемента', async () => {
    const { AppPressable } = jest.requireActual('../../components/AppPressable') as typeof import('../../components/AppPressable');
    const { Text } = jest.requireActual('react-native') as typeof import('react-native');
    const r = await render(
      <>
        <AppPressable onPress={jest.fn()} testID="row">
          <Text>Строка списка</Text>
        </AppPressable>
        <AppPressable onPress={jest.fn()} accessibilityRole="button" accessibilityLabel="Готово">
          <Text>Готово</Text>
        </AppPressable>
      </>
    );
    expect(queryAllByRole(r.root, 'button', { name: /.*/ })).toHaveLength(1);
    expect(getByRole(r.root, 'button', { name: 'Готово' })).toBeTruthy();
    await unmount(r);
  });
});
