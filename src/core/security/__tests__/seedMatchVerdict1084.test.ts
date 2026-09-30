/**
 * ДЕФЕКТ (v4.32.1084). Отказ хранилища ключей выдавался за чужие слова.
 *
 * `verifyMnemonicMatchesWallet` отвечала `boolean`, а поводов сказать «нет» у
 * неё три: ключ этого устройства не прочитался, фраза не сходится по bip39 и
 * настоящее расхождение — слова верные, но от другого аккаунта. Экран
 * восстановления пароля писал на все три одно и то же: «Слова не совпадают с
 * аккаунтом на этом устройстве».
 *
 * ЦЕНА. Хранилище ключей на Android отказывает, пока устройство не
 * разблокировали после перезагрузки, — и ровно тогда человек, забывший
 * пароль, вводит свои настоящие двадцать четыре слова и читает, что они не от
 * этого аккаунта. Следующий его вывод — «записал не ту фразу», а дальше
 * остаётся один ход: стереть аккаунт и завести новый. Переписка, адрес и
 * собеседники теряются навсегда, хотя ключ лежал на месте и хватило бы
 * перезапуска. Слова про это в приложении уже написаны
 * (`KEY_STORE_UNREADABLE_TEXT`), просто сюда не доходили.
 *
 * ПРАВКА. Исход называется своим именем, и у каждого имени свои слова.
 *
 * ГРАНИЦЫ. Дверь открывает по-прежнему только совпадение: ни незнание, ни
 * отказ хранилища пароль не меняют, и `resetPasswordWithVerifiedSeed`
 * проверяет слова сам, как и с v4.32.316.
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
// Мок повторяет обе точки входа модуля, и обе читают одну запись: в жизни
// `loadKeyPair` — это `readKeyRecord().pair`, и разъезжаться они не должны.
jest.mock('../../crypto/keyManager', () => {
  const holder: { read: { state: string; pair: unknown } } = {
    read: { state: 'absent', pair: null },
  };
  return {
    __holder: holder,
    readKeyRecord: jest.fn(async () => holder.read),
    loadKeyPair: jest.fn(async () => holder.read.pair),
  };
});
jest.mock('../../backup/seedPhrase', () => ({
  deriveKeyPairFromMnemonicForProfile: jest.fn(() => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
}));

import fs from 'fs';
import path from 'path';

import { KEY_STORE_UNREADABLE_TEXT } from '../../crypto/keyRecordState';
import { AuthGuard } from '../authGuard';
import {
  SEED_INVALID_WORDS_TEXT,
  SEED_MISMATCH_TEXT,
  SEED_NO_IDENTITY_TEXT,
  type SeedMatch,
  seedMatchIsMatch,
  seedMatchText,
} from '../seedMatchVerdict';

const SEED = 'abandon '.repeat(23) + 'art';

const mockSecureStore = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string | undefined>;
};
const mockKeys = jest.requireMock('../../crypto/keyManager') as {
  __holder: { read: { state: string; pair: unknown } };
};
const mockBip39 = jest.requireMock('bip39') as { validateMnemonic: jest.Mock };

/** Что лежит в хранилище ключей на этот тест. */
function keyRecord(state: string, pub?: Uint8Array): void {
  mockKeys.__holder.read = {
    state,
    pair: pub ? { publicKey: pub, secretKey: new Uint8Array(64) } : null,
  };
}

function freshGuard(): AuthGuard {
  // @ts-expect-error accessing private static for test isolation
  AuthGuard.instance = undefined;
  const s = mockSecureStore.__store;
  for (const k of Object.keys(s)) delete s[k];
  keyRecord('ok', new Uint8Array(32));
  mockBip39.validateMnemonic.mockImplementation(() => true);
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

// ── Поведение: четыре «нет» перестали быть одним ─────────────────────────────

describe('сверка слов: у каждого «нет» своя причина', () => {
  test('ключ не прочитался — это не чужие слова', async () => {
    const guard = freshGuard();
    keyRecord('unreadable');
    expect(await guard.verifyMnemonicMatchesWallet(SEED)).toBe('key_unreadable');
  });

  test('ключа нет вовсе — тоже не чужие слова', async () => {
    const guard = freshGuard();
    keyRecord('absent');
    expect(await guard.verifyMnemonicMatchesWallet(SEED)).toBe('no_identity');
  });

  test('осиротевший открытый ключ считается отсутствием аккаунта', async () => {
    const guard = freshGuard();
    keyRecord('orphan-public');
    expect(await guard.verifyMnemonicMatchesWallet(SEED)).toBe('no_identity');
  });

  test('фраза не сходится сама с собой — говорим про фразу', async () => {
    const guard = freshGuard();
    mockBip39.validateMnemonic.mockImplementation(() => false);
    expect(await guard.verifyMnemonicMatchesWallet(SEED)).toBe('invalid_words');
  });

  test('слова от другого аккаунта — только здесь «не совпадают»', async () => {
    const guard = freshGuard();
    keyRecord('ok', new Uint8Array(32).fill(7));
    expect(await guard.verifyMnemonicMatchesWallet(SEED)).toBe('mismatch');
  });

  test('свои слова подходят', async () => {
    const guard = freshGuard();
    expect(await guard.verifyMnemonicMatchesWallet(SEED)).toBe('match');
  });

  test('починимая запись ключа сверке не мешает', async () => {
    const guard = freshGuard();
    keyRecord('repairable', new Uint8Array(32));
    expect(await guard.verifyMnemonicMatchesWallet(SEED)).toBe('match');
  });

  test('пять исходов — пять разных ответов', async () => {
    const guard = freshGuard();
    const got: SeedMatch[] = [];
    got.push(await guard.verifyMnemonicMatchesWallet(SEED));
    keyRecord('ok', new Uint8Array(32).fill(7));
    got.push(await guard.verifyMnemonicMatchesWallet(SEED));
    keyRecord('ok', new Uint8Array(32));
    mockBip39.validateMnemonic.mockImplementation(() => false);
    got.push(await guard.verifyMnemonicMatchesWallet(SEED));
    keyRecord('unreadable');
    got.push(await guard.verifyMnemonicMatchesWallet(SEED));
    keyRecord('absent');
    got.push(await guard.verifyMnemonicMatchesWallet(SEED));
    expect(new Set(got).size).toBe(5);
  });
});

// ── Слова для человека ───────────────────────────────────────────────────────

describe('слова к исходам', () => {
  test('отказ хранилища объясняется отказом хранилища', () => {
    expect(seedMatchText('key_unreadable')).toBe(KEY_STORE_UNREADABLE_TEXT);
    expect(seedMatchText('key_unreadable')).not.toContain('не совпадают');
  });

  test('про фразу — про фразу, про аккаунт — про аккаунт', () => {
    expect(seedMatchText('invalid_words')).toBe(SEED_INVALID_WORDS_TEXT);
    expect(SEED_INVALID_WORDS_TEXT).not.toContain('не совпадают с аккаунтом');
    expect(seedMatchText('mismatch')).toBe(SEED_MISMATCH_TEXT);
    expect(SEED_MISMATCH_TEXT).toContain('не совпадают с аккаунтом');
    expect(seedMatchText('no_identity')).toBe(SEED_NO_IDENTITY_TEXT);
  });

  test('совпадению говорить нечего', () => {
    expect(seedMatchText('match')).toBeNull();
    expect(seedMatchIsMatch('match')).toBe(true);
    for (const v of ['mismatch', 'invalid_words', 'key_unreadable', 'no_identity'] as const) {
      expect(seedMatchIsMatch(v)).toBe(false);
    }
  });

  test('четыре отказа — четыре разных текста', () => {
    const texts = (
      ['mismatch', 'invalid_words', 'key_unreadable', 'no_identity'] as const
    ).map((v) => seedMatchText(v));
    expect(new Set(texts).size).toBe(4);
    for (const t of texts) expect((t ?? '').length).toBeGreaterThan(20);
  });
});

// ── Форма правки ─────────────────────────────────────────────────────────────

describe('форма правки', () => {
  test('сверка отвечает исходом, а не булевым флагом', () => {
    const code = codeOnly(src('core/security/authGuard.ts'));
    expect(code).toContain('async verifyMnemonicMatchesWallet(mnemonic: string): Promise<SeedMatch>');
    // Состояние записи ключа видно только через readKeyRecord: loadKeyPair
    // схлопывает «не прочиталось» и «нет вовсе» в один null.
    expect(code).toContain('readKeyRecord()');
    expect(code).not.toContain('loadKeyPair');
  });

  test('экран восстановления берёт слова у разбора, а не пишет свои', () => {
    const screen = codeOnly(src('ui/screens/ForgotPasswordScreen.tsx'));
    expect(screen).toContain('seedMatchText(match)');
    expect(screen).not.toContain("showError('Слова не совпадают с аккаунтом на этом устройстве')");
  });

  test('слова про нечитаемый ключ не переписаны заново', () => {
    const verdict = src('core/security/seedMatchVerdict.ts');
    expect(verdict).toContain('KEY_STORE_UNREADABLE_TEXT');
    expect(verdict).toContain("from '../crypto/keyRecordState'");
  });
});

// ── Проверка не пустая ───────────────────────────────────────────────────────

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  test('экран восстановления по-прежнему спрашивает authGuard', () => {
    const screen = codeOnly(src('ui/screens/ForgotPasswordScreen.tsx'));
    expect(screen).toContain('authGuard.verifyMnemonicMatchesWallet(');
    expect(screen).toContain('authGuard.resetPasswordWithVerifiedSeed(');
  });

  test('состояния записи ключа по-прежнему различаются', () => {
    const code = codeOnly(src('core/crypto/keyRecordState.ts'));
    expect(code).toContain("return 'unreadable';");
    expect(code).toContain("return facts.hasPublic ? 'orphan-public' : 'absent';");
  });
});

// ── Границы ──────────────────────────────────────────────────────────────────

describe('ГРАНИЦА', () => {
  test('без совпадения пароль не меняется ни по одной причине', async () => {
    for (const setup of [
      (): void => keyRecord('unreadable'),
      (): void => keyRecord('absent'),
      (): void => keyRecord('ok', new Uint8Array(32).fill(7)),
      (): void => {
        mockBip39.validateMnemonic.mockImplementation(() => false);
      },
    ]) {
      const guard = freshGuard();
      await guard.setPassword('забытый!');
      setup();
      expect(await guard.resetPasswordWithVerifiedSeed(SEED, 'новый!!!')).toBe(false);
      expect(guard.isSessionUnlocked()).toBe(false);
      keyRecord('ok', new Uint8Array(32));
      mockBip39.validateMnemonic.mockImplementation(() => true);
      expect(await guard.verifyPassword('забытый!')).toBe('ok');
    }
  });

  test('свои слова по-прежнему меняют пароль и открывают сессию', async () => {
    const guard = freshGuard();
    await guard.setPassword('забытый!');
    expect(await guard.resetPasswordWithVerifiedSeed(SEED, 'новый!!!')).toBe(true);
    expect(guard.isSessionUnlocked()).toBe(true);
    expect(await guard.verifyPassword('новый!!!')).toBe('ok');
  });

  test('разбор фразы остался у экрана: сверка регистр не приводит (v4.32.651)', () => {
    const code = codeOnly(src('core/security/authGuard.ts'));
    const a = code.indexOf('async verifyMnemonicMatchesWallet(mnemonic: string)');
    const body = code.slice(a, code.indexOf('\n  }\n', a));
    expect(body).toContain("const normalized = mnemonic.trim().split(/\\s+/).join(' ');");
    expect(body).not.toContain('toLowerCase');
  });
});

// ── Повод для правки жив ─────────────────────────────────────────────────────

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  test('хранилище ключей по-прежнему умеет отказывать после перезагрузки', () => {
    expect(KEY_STORE_UNREADABLE_TEXT).toContain('Разблокируйте телефон');
    expect(KEY_STORE_UNREADABLE_TEXT).not.toBe(SEED_MISMATCH_TEXT);
  });

  test('экран восстановления по-прежнему один на все причины отказа', () => {
    const screen = codeOnly(src('ui/screens/ForgotPasswordScreen.tsx'));
    // Один showError на весь исход сверки — потому и важно, что он говорит.
    const calls = screen.split('verifyMnemonicMatchesWallet(').length - 1;
    expect(calls).toBe(1);
  });
});
