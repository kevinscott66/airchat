/**
 * ДЕФЕКТ (v4.32.1083). Испорченная запись пароля выдавалась за неверный пароль.
 *
 * `verifyPasswordInternal` отвечала `boolean`, а исходов у сверки три: пароль
 * сошёлся, пароль не сошёлся и сверять было не с чем. Третий случай — записи
 * нет, она не разбирается как JSON, в ней другая версия формата или нет полей
 * соли и хэша — до сравнения не доходил вовсе: `bytesEqualConstTime` не
 * вызывался, а наружу уходил тот же `false`, что и у настоящего промаха.
 *
 * ЦЕНА. `checkPasswordOnce` на `false` списывал одну из пяти попыток, и экран
 * блокировки писал «Неверный пароль. Осталось попыток: 4», потом 3, 2, 1,
 * потом пятнадцать минут ожидания. Человек вводит свой настоящий пароль и
 * читает о нём утверждение, которого приложение не проверяло. Ровно то же
 * говорили пять дверей к секретным словам и резервной копии и форма смены
 * пароля. Вывод, к которому это подталкивает, — «я забыл пароль», а у того,
 * кто на заведении аккаунта выбрал «Сделаю позже», секретных слов нет, и
 * единственный оставшийся ход — стереть аккаунт вместе с перепиской.
 *
 * ПРАВКА. Исход называется своим именем: `ok` / `wrong` / `unusable`.
 * Незнание попытку не тратит, и на экране у него свои слова — про запись, а
 * не про пароль.
 *
 * ГРАНИЦЫ. Доступа незнание не даёт: политика v4.32.176 не тронута. Счётчик
 * попыток и блокировка на настоящих промахах работают как прежде (v4.32.315).
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
jest.mock('bip39', () => ({ validateMnemonic: jest.fn(() => true) }));
jest.mock('../biometricUnlock', () => ({
  isBiometricUnlockEnabled: jest.fn(async () => false),
  enableBiometricUnlock: jest.fn(async () => true),
  disableBiometricUnlock: jest.fn(async () => true),
}));
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

import fs from 'fs';
import path from 'path';

import { AUTH_SECURE_KEYS, AuthGuard } from '../authGuard';
import { PASSWORD_UNUSABLE_TEXT, passwordVerdictCostsAttempt } from '../passwordVerdict';

const PAYLOAD_KEY = AUTH_SECURE_KEYS[0];

const mockSecureStore = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string | undefined>;
};

function freshGuard(): AuthGuard {
  // @ts-expect-error accessing private static for test isolation
  AuthGuard.instance = undefined;
  const s = mockSecureStore.__store;
  for (const k of Object.keys(s)) delete s[k];
  return AuthGuard.getInstance();
}

const src = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

const codeOnly = (text: string): string =>
  text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = text.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return text.slice(a, b);
}

// ── Поведение: сверка не состоялась — это отдельный исход ────────────────────

describe('сверять не с чем — не «неверный пароль»', () => {
  test('порченая запись: checkPassword говорит «сверять не с чем»', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    mockSecureStore.__store[PAYLOAD_KEY] = '{битый json';
    expect(await guard.checkPassword('oldpass!')).toBe('unusable');
  });

  test('порченая запись не тратит попытку и не пускает', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    mockSecureStore.__store[PAYLOAD_KEY] = '{битый json';
    await guard.checkPassword('oldpass!');
    await guard.checkPassword('oldpass!');
    await guard.checkPassword('oldpass!');
    expect(await guard.getRemainingAttempts()).toBe(5);
    expect(await guard.isLocked()).toBe(false);
    expect(guard.isSessionUnlocked()).toBe(false);
  });

  test('чужая версия формата — тоже «сверять не с чем»', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    const payload = JSON.parse(mockSecureStore.__store[PAYLOAD_KEY] as string) as {
      v: number;
    };
    payload.v = 2;
    mockSecureStore.__store[PAYLOAD_KEY] = JSON.stringify(payload);
    expect(await guard.checkPassword('oldpass!')).toBe('unusable');
  });

  test('запись без хэша — тоже «сверять не с чем»', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    const payload = JSON.parse(mockSecureStore.__store[PAYLOAD_KEY] as string) as {
      hashB64?: string;
    };
    delete payload.hashB64;
    mockSecureStore.__store[PAYLOAD_KEY] = JSON.stringify(payload);
    expect(await guard.checkPassword('oldpass!')).toBe('unusable');
  });

  test('настоящий промах по-прежнему промах: имя, попытка, блокировка', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    expect(await guard.checkPassword('не тот')).toBe('wrong');
    expect(await guard.getRemainingAttempts()).toBe(4);
  });

  test('верный пароль по-прежнему открывает сессию', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    expect(await guard.checkPassword('oldpass!')).toBe('ok');
    expect(guard.isSessionUnlocked()).toBe(true);
  });

  test('три исхода — три разных ответа, а не два', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    const ok = await guard.verifyPassword('oldpass!');
    const wrong = await guard.verifyPassword('не тот');
    mockSecureStore.__store[PAYLOAD_KEY] = '{битый json';
    const unusable = await guard.verifyPassword('oldpass!');
    expect(new Set([ok, wrong, unusable]).size).toBe(3);
  });

  test('смена пароля: порченая запись не выдаётся за неверный старый пароль', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    mockSecureStore.__store[PAYLOAD_KEY] = '{битый json';
    expect(await guard.changePassword('oldpass!', 'newpass!!')).toBe('unusable');
    expect(await guard.getRemainingAttempts()).toBe(5);
  });

  test('попытку тратит только промах', () => {
    expect(passwordVerdictCostsAttempt('wrong')).toBe(true);
    expect(passwordVerdictCostsAttempt('unusable')).toBe(false);
    expect(passwordVerdictCostsAttempt('ok')).toBe(false);
  });

  test('слова про порченую запись говорят про запись и называют выход', () => {
    expect(PASSWORD_UNUSABLE_TEXT).not.toContain('Неверный пароль');
    expect(PASSWORD_UNUSABLE_TEXT).not.toContain('Осталось попыток');
    expect(PASSWORD_UNUSABLE_TEXT).toContain('секретным словам');
  });
});

// ── Форма правки ─────────────────────────────────────────────────────────────

describe('форма правки', () => {
  test('исход сверки назван типом, а не булевым флагом', () => {
    const code = codeOnly(src('core/security/authGuard.ts'));
    expect(code).toContain('async checkPassword(password: string): Promise<PasswordVerdict>');
    expect(code).toContain('async verifyPassword(password: string): Promise<PasswordVerdict>');
    expect(code).toContain('verifyPasswordInternal(password: string): Promise<PasswordVerdict>');
  });

  test('слово про порченую запись одно на всё приложение', () => {
    const verdict = src('core/security/passwordVerdict.ts');
    expect(verdict).toContain('export const PASSWORD_UNUSABLE_TEXT');
    // Модуль ни от чего не зависит: его читают и ядро, и экраны.
    expect(verdict).not.toContain('\nimport ');
    const sensitive = codeOnly(src('core/security/sensitiveAccess.ts'));
    expect(sensitive).toContain('PASSWORD_UNUSABLE_TEXT');
    expect(sensitive).toContain("'unusable'");
  });

  test('экран блокировки развёл порченую запись и промах', () => {
    const screen = codeOnly(src('ui/screens/PasswordScreen.tsx'));
    expect(screen).toContain('PASSWORD_UNUSABLE_TEXT');
    const branch = slice(screen, "verdict === 'unusable'", 'shake()');
    expect(branch).toContain('showError(PASSWORD_UNUSABLE_TEXT)');
  });

  test('все двери к секретным словам говорят это же', () => {
    const settings = codeOnly(src('ui/screens/SettingsScreen.tsx'));
    const doors = settings.split('SENSITIVE_UNUSABLE_TEXT').length - 1;
    // Пять дверей плюс форма смены пароля плюс импорт.
    expect(doors).toBeGreaterThanOrEqual(7);
    expect(settings).toContain("res === 'save_failed'");
  });
});

// ── Проверка не пустая ───────────────────────────────────────────────────────

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  test('до сравнения хэшей ведут несколько досрочных выходов', () => {
    const code = codeOnly(src('core/security/authGuard.ts'));
    const body = slice(code, 'getItemAsync(AUTH_PAYLOAD_KEY)', 'bytesEqualConstTime(computed');
    expect((body.match(/return /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('экран блокировки читает исход у authGuard, а не решает сам', () => {
    const screen = codeOnly(src('ui/screens/PasswordScreen.tsx'));
    expect(screen).toContain('authGuard.checkPassword(value)');
  });
});

// ── Границы ──────────────────────────────────────────────────────────────────

describe('ГРАНИЦА', () => {
  test('пароля нет — внутрь всё равно не пускают (v4.32.176)', async () => {
    const guard = freshGuard();
    expect(await guard.checkPassword('что угодно')).not.toBe('ok');
    expect(guard.isSessionUnlocked()).toBe(false);
  });

  test('подбор старого пароля через форму смены упирается в блокировку (v4.32.315)', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    for (let i = 0; i < 5; i++) await guard.changePassword('wrong', 'newpass!!');
    expect(await guard.isLocked()).toBe(true);
    expect(await guard.changePassword('oldpass!', 'newpass!!')).not.toBe('ok');
  });

  test('верный пароль обнуляет счётчик промахов', async () => {
    const guard = freshGuard();
    await guard.setPassword('oldpass!');
    await guard.checkPassword('не тот');
    expect(await guard.getRemainingAttempts()).toBe(4);
    await guard.checkPassword('oldpass!');
    expect(await guard.getRemainingAttempts()).toBe(5);
  });
});

// ── Повод для правки жив ─────────────────────────────────────────────────────

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  test('слова «Неверный пароль» никуда не делись — они для промаха', () => {
    expect(src('ui/components/userFeedback.ts')).toContain('Неверный пароль. Осталось попыток:');
    expect(src('ui/screens/PasswordScreen.tsx')).toContain('Неверный пароль. Осталось попыток:');
  });

  test('запись пароля по-прежнему может не разобраться', () => {
    const code = codeOnly(src('core/security/authGuard.ts'));
    expect(code).toContain('JSON.parse(raw)');
    expect(code).toContain('payload.v !== 1');
  });
});
