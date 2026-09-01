/**
 * Unit tests for AuthGuard — PBKDF2 verify, attempt counting, lockout, session flags.
 */

// Store lives INSIDE the factory so it's safe from jest.mock hoisting / TDZ issues.
// Access it via jest.requireMock().__store.
jest.mock('../../storage/secureStoreQueued', () => {
  const s: Record<string, string | undefined> = {};
  return {
    __store: s,
    getItemAsync: jest.fn(async (key: string) => s[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { s[key] = value; }),
    deleteItemAsync: jest.fn(async (key: string) => { delete s[key]; }),
  };
});

jest.mock('bip39', () => ({ validateMnemonic: jest.fn(() => true) }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { init: jest.fn(async () => {}), getActiveProfile: jest.fn(() => null) },
}));
jest.mock('../../crypto/keyManager', () => ({ loadKeyPair: jest.fn(async () => null) }));
jest.mock('../../backup/seedPhrase', () => ({
  deriveKeyPairFromMnemonicForProfile: jest.fn(() => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
}));

import { AuthGuard } from '../authGuard';

// Access the in-factory store via requireMock
const mockSecureStore = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string | undefined>;
};
const mockKeyManager = jest.requireMock('../../crypto/keyManager') as { loadKeyPair: jest.Mock };
const mockBip39 = jest.requireMock('bip39') as { validateMnemonic: jest.Mock };

function freshGuard(): AuthGuard {
  // Reset singleton
  // @ts-expect-error accessing private static for test isolation
  AuthGuard.instance = undefined;
  // Wipe all persisted state
  const s = mockSecureStore.__store;
  for (const k of Object.keys(s)) delete s[k];
  return AuthGuard.getInstance();
}

// ── Basic password flow ───────────────────────────────────────────────────────

describe('AuthGuard — basic password flow', () => {
  // v4.32.176: checkPassword БОЛЬШЕ не пропускает при незаданном пароле.
  // Раньше transient SecureStore miss (Keystore race после boot) читался как
  // «пароля нет» и давал password-bypass. Теперь bypass живёт только в явном
  // checkPasswordOrBypassIfUnset, который проверяет hasPassword().
  test('no password → checkPassword returns false (no implicit bypass)', async () => {
    const guard = freshGuard();
    expect(await guard.checkPassword('anything')).toBe(false);
    expect(guard.isSessionUnlocked()).toBe(false);
  });

  test('no password → checkPasswordOrBypassIfUnset returns true (explicit bypass)', async () => {
    const guard = freshGuard();
    expect(await guard.checkPasswordOrBypassIfUnset('anything')).toBe(true);
    expect(guard.isSessionUnlocked()).toBe(true);
  });

  test('password set → checkPasswordOrBypassIfUnset still rejects a wrong password', async () => {
    const guard = freshGuard();
    await guard.setPassword('hunter2!');
    expect(await guard.checkPasswordOrBypassIfUnset('wrong')).toBe(false);
    expect(guard.isSessionUnlocked()).toBe(false);
  });

  test('setPassword + verify correct password', async () => {
    const guard = freshGuard();
    await guard.setPassword('hunter2!');
    expect(await guard.verifyPassword('hunter2!')).toBe(true);
  });

  test('wrong password returns false', async () => {
    const guard = freshGuard();
    await guard.setPassword('hunter2!');
    expect(await guard.verifyPassword('wrong')).toBe(false);
  });

  test('setPassword rejects passwords shorter than minPasswordLength', async () => {
    const guard = freshGuard();
    expect(await guard.setPassword('abc')).toBe(false);
  });

  test('session unlock flag set on correct checkPassword', async () => {
    const guard = freshGuard();
    await guard.setPassword('correct!');
    expect(guard.isSessionUnlocked()).toBe(false);
    await guard.checkPassword('correct!');
    expect(guard.isSessionUnlocked()).toBe(true);
  });

  test('lockSession clears the flag', () => {
    const guard = freshGuard();
    guard.unlockSession();
    guard.lockSession();
    expect(guard.isSessionUnlocked()).toBe(false);
  });
});

// ── Failed attempts & lockout ─────────────────────────────────────────────────

describe('AuthGuard — failed attempts & lockout', () => {
  test('5 wrong attempts trigger lockout', async () => {
    const guard = freshGuard();
    await guard.setPassword('secret!');
    for (let i = 0; i < 5; i++) await guard.checkPassword('wrong');
    expect(await guard.isLocked()).toBe(true);
    expect(await guard.getRemainingAttempts()).toBe(0);
  });

  test('locked guard blocks even correct password', async () => {
    const guard = freshGuard();
    await guard.setPassword('secret!');
    for (let i = 0; i < 5; i++) await guard.checkPassword('x');
    expect(await guard.checkPassword('secret!')).toBe(false);
  });

  test('correct password resets failed attempts counter', async () => {
    const guard = freshGuard();
    await guard.setPassword('p@ssword');
    await guard.checkPassword('wrong');
    await guard.checkPassword('wrong');
    await guard.checkPassword('p@ssword'); // resets counter
    expect(await guard.getRemainingAttempts()).toBe(5);
  });

  test('clearAllAuthData wipes password and session', async () => {
    const guard = freshGuard();
    await guard.setPassword('clear-me!');
    guard.unlockSession();
    await guard.clearAllAuthData();
    expect(guard.isSessionUnlocked()).toBe(false);
    expect(await guard.hasPassword()).toBe(false);
  });
});

// ── changePassword ────────────────────────────────────────────────────────────

describe('AuthGuard — changePassword', () => {
  test('succeeds with correct old password', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    const ok = await guard.changePassword('oldpass!', 'newpass!!');
    expect(ok).toBe(true);
    expect(await guard.verifyPassword('newpass!!')).toBe(true);
    expect(await guard.verifyPassword('oldpass!')).toBe(false);
  });

  test('fails with wrong old password', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    const ok = await guard.changePassword('wrongpass', 'newpass!!');
    expect(ok).toBe(false);
    // original password still valid
    expect(await guard.verifyPassword('oldpass!')).toBe(true);
  });

  test('fails if new password is too short', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    expect(await guard.changePassword('oldpass!', 'ab')).toBe(false);
  });
});

// ── v4.32.315: подбор и порча счётчиков ───────────────────────────────────────

describe('AuthGuard — смена пароля под теми же ограничениями', () => {
  test('неудачная смена пароля тратит попытку', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    await guard.changePassword('wrongpass', 'newpass!!');
    expect(await guard.getRemainingAttempts()).toBe(4);
  });

  test('форма смены пароля не даёт подбирать в обход блокировки', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    for (let i = 0; i < 5; i++) await guard.changePassword('wrong', 'newpass!!');
    expect(await guard.isLocked()).toBe(true);
    // Даже верный старый пароль во время блокировки не проходит.
    expect(await guard.changePassword('oldpass!', 'newpass!!')).toBe(false);
    expect(await guard.verifyPassword('oldpass!')).toBe(false);
  });

  test('удачная смена пароля обнуляет счётчик', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    await guard.changePassword('wrongpass', 'newpass!!');
    expect(await guard.changePassword('oldpass!', 'newpass!!')).toBe(true);
    expect(await guard.getRemainingAttempts()).toBe(5);
  });
});

describe('AuthGuard — испорченные значения в хранилище', () => {
  test('нечитаемый счётчик попыток не показывается человеку как NaN', async () => {
    const guard = freshGuard();
    await guard.setPassword('secret!');
    mockSecureStore.__store['airchat_app_password_failed_v1'] = 'что-то не то';
    expect(await guard.getRemainingAttempts()).toBe(5);
    expect(await guard.isLocked()).toBe(false);
  });

  test('нечитаемая отметка времени не запирает навсегда', async () => {
    const guard = freshGuard();
    await guard.setPassword('secret!');
    for (let i = 0; i < 5; i++) await guard.checkPassword('wrong');
    mockSecureStore.__store['airchat_app_password_last_attempt_v1'] = 'сломано';
    expect(await guard.isLocked()).toBe(false);
    expect(await guard.getLockoutTimeRemaining()).toBe(0);
    expect(await guard.checkPassword('secret!')).toBe(true);
  });

  test('часы, переведённые назад, не запирают навсегда', async () => {
    const guard = freshGuard();
    await guard.setPassword('secret!');
    for (let i = 0; i < 5; i++) await guard.checkPassword('wrong');
    expect(await guard.isLocked()).toBe(true);
    // Телефон впервые поймал точное время и отъехал на год назад.
    const yearAhead = Date.now() + 365 * 24 * 60 * 60 * 1000;
    mockSecureStore.__store['airchat_app_password_last_attempt_v1'] = String(yearAhead);
    expect(await guard.isLocked()).toBe(false);
    expect(await guard.checkPassword('secret!')).toBe(true);
  });

  test('блокировка истекает по истечении срока', async () => {
    const guard = freshGuard();
    await guard.setPassword('secret!');
    for (let i = 0; i < 5; i++) await guard.checkPassword('wrong');
    expect(await guard.isLocked()).toBe(true);
    const longAgo = Date.now() - 16 * 60 * 1000;
    mockSecureStore.__store['airchat_app_password_last_attempt_v1'] = String(longAgo);
    expect(await guard.isLocked()).toBe(false);
    expect(await guard.getRemainingAttempts()).toBe(5);
  });
});

// ── v4.32.316: сброс пароля по секретным словам ───────────────────────────────

describe('AuthGuard — сброс пароля по секретным словам', () => {
  const SEED = 'слова которые человек записал на бумажке';

  afterEach(() => {
    mockKeyManager.loadKeyPair.mockImplementation(async () => null);
    mockBip39.validateMnemonic.mockImplementation(() => true);
  });

  test('слова от этого аккаунта — пароль меняется и сессия открывается', async () => {
    const guard = freshGuard();
    await guard.setPassword('забытый!');
    // Ключ, выведенный из слов (мок отдаёт нули), совпадает с ключом кошелька.
    mockKeyManager.loadKeyPair.mockImplementation(async () => ({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    }));

    expect(await guard.resetPasswordWithVerifiedSeed(SEED, 'новый!!!')).toBe(true);
    expect(guard.isSessionUnlocked()).toBe(true);
    expect(await guard.verifyPassword('новый!!!')).toBe(true);
  });

  test('чужие слова пароль не меняют', async () => {
    const guard = freshGuard();
    await guard.setPassword('забытый!');
    mockKeyManager.loadKeyPair.mockImplementation(async () => ({
      publicKey: new Uint8Array(32).fill(7),
      secretKey: new Uint8Array(64),
    }));

    expect(await guard.resetPasswordWithVerifiedSeed(SEED, 'новый!!!')).toBe(false);
    expect(guard.isSessionUnlocked()).toBe(false);
    expect(await guard.verifyPassword('забытый!')).toBe(true);
  });

  test('слова не из словаря bip39 пароль не меняют', async () => {
    const guard = freshGuard();
    await guard.setPassword('забытый!');
    mockKeyManager.loadKeyPair.mockImplementation(async () => ({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    }));
    mockBip39.validateMnemonic.mockImplementation(() => false);

    expect(await guard.resetPasswordWithVerifiedSeed(SEED, 'новый!!!')).toBe(false);
    expect(await guard.verifyPassword('забытый!')).toBe(true);
  });

  test('слов нет на устройстве — менять нечему и не с чем', async () => {
    const guard = freshGuard();
    await guard.setPassword('забытый!');
    // loadKeyPair отдаёт null: кошелька на устройстве нет.
    expect(await guard.resetPasswordWithVerifiedSeed(SEED, 'новый!!!')).toBe(false);
    expect(await guard.verifyPassword('забытый!')).toBe(true);
  });
});
