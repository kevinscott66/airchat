/**
 * Путь нового аккаунта через онбординг — по отрисованному экрану.
 *
 * AC-20: на Android онбординг больше не начинается со сводки из пяти
 * системных разрешений — первым человек видит приветствие. Шаги пишутся в
 * журнал событием без слов, ключей и идентификаторов.
 *
 * AC-21: «Я сохранил секретные слова» ведёт на проверку трёх слов по номеру.
 * Номера случайные, поэтому тест читает их с экрана — из подписей полей, как
 * их прочёл бы человек, — и отвечает словами из «записи».
 */
import React from 'react';
import { Platform } from 'react-native';

import {
  changeText,
  getByLabelText,
  getByRole,
  isDisabled,
  press,
  queryAllByRole,
  queryByTestId,
  render,
  unmount,
  visibleLabelOf,
  type Node,
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
    // Метка щита — чтобы проверить, что поля проверки лежат под ним.
    SecretScreenGuard: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
      <View testID={testID} accessibilityHint="secret-screen-guard">
        {children}
      </View>
    ),
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
  setSeedBackupPending: jest.fn(async () => undefined),
  clearSeedBackupPending: jest.fn(async () => undefined),
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
import * as seedPhrase from '../../../core/backup/seedPhrase';

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

/** Дойти до проверки: создать аккаунт и нажать «Я сохранил секретные слова». */
async function toVerify(onComplete = jest.fn()): Promise<{ r: Awaited<ReturnType<typeof render>>; onComplete: jest.Mock }> {
  const r = await render(<OnboardingScreen onComplete={onComplete} />);
  await press(getByRole(r.root, 'button', { name: 'Создать новый аккаунт' }));
  expect(queryByTestId(r.root, 'seed_words')).not.toBeNull();
  await press(getByRole(r.root, 'button', { name: 'Я сохранил секретные слова' }));
  expect(queryByTestId(r.root, 'seed_verify')).not.toBeNull();
  return { r, onComplete };
}

/** Поля проверки и номера слов, прочитанные с видимых подписей «Слово №N». */
function verifyFields(root: Node): Array<{ field: Node; index: number }> {
  const out: Array<{ field: Node; index: number }> = [];
  for (let i = 0; ; i++) {
    const field = queryByTestId(root, `seed_verify_input_${i}`);
    if (!field) break;
    const label = visibleLabelOf(root, field);
    const m = (label ?? '').match(/^Слово №(\d+)$/);
    if (!m) throw new Error(`у поля ${i} нет видимой подписи с номером: ${String(label)}`);
    out.push({ field, index: Number(m[1]) - 1 });
  }
  return out;
}

const verifyBtn = (root: Node): Node => getByRole(root, 'button', { name: 'Проверить' });

describe('AC-21: проверка записи секретных слов', () => {
  let consoleSpies: jest.SpyInstance[] = [];
  beforeEach(() => {
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) =>
      jest.spyOn(console, k).mockImplementation(() => undefined)
    );
  });
  afterEach(() => {
    // Ни одно слово не ушло ни в журнал приложения, ни в консоль.
    const logged = everythingLogged() + JSON.stringify(consoleSpies.map((s) => s.mock.calls));
    for (const w of WORDS) expect(logged).not.toContain(w);
    for (const s of consoleSpies) s.mockRestore();
  });

  it('спрашивает три разных слова по номеру; поля подписаны и лежат под щитом', async () => {
    const { r } = await toVerify();
    const fields = verifyFields(r.root);
    expect(fields).toHaveLength(3);
    expect(new Set(fields.map((f) => f.index)).size).toBe(3);
    const guard = queryByTestId(r.root, 'seed_verify_guard')!;
    for (const { field, index } of fields) {
      expect(getByLabelText(r.root, `Слово №${index + 1}`)).toBe(field);
      let cur: Node | null = field.parent;
      while (cur && cur !== guard) cur = cur.parent;
      expect(cur).toBe(guard);
      expect(field.props.autoComplete).toBe('off');
      expect(field.props.autoCorrect).toBe(false);
    }
    // Пока ответы не введены, проверять нечего.
    expect(isDisabled(verifyBtn(r.root))).toBe(true);
    await unmount(r);
  });

  it('неверное слово не пускает дальше, но к словам можно вернуться', async () => {
    const { r, onComplete } = await toVerify();
    const fields = verifyFields(r.root);
    await changeText(fields[0].field, WORDS[fields[0].index]);
    await changeText(fields[1].field, WORDS[fields[1].index]);
    await changeText(fields[2].field, 'неверно');
    expect(isDisabled(verifyBtn(r.root))).toBe(false);
    await press(verifyBtn(r.root));

    expect(queryByTestId(r.root, 'seed_verify_error')).not.toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
    expect(seedPhrase.setFirstLaunchDone).not.toHaveBeenCalled();
    expect(seedPhrase.setSeedShown).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('onboarding_seed_verify_failed', {});

    await press(getByRole(r.root, 'button', { name: 'Назад к словам' }));
    expect(queryByTestId(r.root, 'seed_verify')).toBeNull();
    expect(queryByTestId(r.root, 'seed_words')).not.toBeNull();
    // Слова те же — аккаунт не заводился заново.
    expect(seedPhrase.generateMnemonicAndStore).toHaveBeenCalledTimes(1);
    await unmount(r);
  });

  it('верные слова (регистр и пробелы не важны) завершают заведение аккаунта', async () => {
    const { r, onComplete } = await toVerify();
    for (const { field, index } of verifyFields(r.root)) {
      await changeText(field, `  ${WORDS[index].toUpperCase()} `);
    }
    await press(verifyBtn(r.root));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(seedPhrase.setFirstLaunchDone).toHaveBeenCalledTimes(1);
    expect(seedPhrase.setSeedShown).toHaveBeenCalledTimes(1);
    expect(seedPhrase.clearSeedBackupPending).toHaveBeenCalledTimes(1);
    expect(seedPhrase.setSeedBackupPending).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('onboarding_seed_verified', {});
    await unmount(r);
  });

  it('«Сделаю позже» пускает дальше и ставит флаг напоминания', async () => {
    const { r, onComplete } = await toVerify();
    await press(getByRole(r.root, 'button', { name: 'Сделаю позже' }));

    expect(seedPhrase.setSeedBackupPending).toHaveBeenCalledTimes(1);
    expect(seedPhrase.clearSeedBackupPending).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('onboarding_seed_backup_deferred', {});
    await unmount(r);
  });
});
