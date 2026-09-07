/**
 * Круг 4.32.651. Восстановление аккаунта: отказ записи и сбой чтения не должны
 * выглядеть как успех.
 *
 * Три разных места сводили отрицательный ответ к молчанию:
 * 1) оба вызова `authGuard.setPassword` в онбординге выбрасывали `boolean` —
 *    приложение оставалось без замка, а человек считал, что пароль у него есть;
 * 2) welcome не отличал «фразы нет» от «фраза не открылась» и оставлял живой
 *    кнопку, которая затирает нечитаемую фразу навсегда;
 * 3) экран восстановления пароля разбирал ввод одним `trim()` и отвечал
 *    «слова не совпадают с аккаунтом» на правильную, но нумерованную фразу.
 */

import fs from 'fs';
import path from 'path';

import { describeRestoreLock, RESTORE_LOCK_POLICY_TEXT, RESTORE_LOCK_STORAGE_TEXT } from '../../../core/security/restoreLockOutcome';
import { decideStoredPhraseState } from '../../../core/backup/storedPhraseState';
import { PASSWORD_MIN_LENGTH } from '../../../core/security/passwordPolicy';

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

const ONB = (): string => read('ui/screens/OnboardingScreen.tsx');
const FORGOT = (): string => read('ui/screens/ForgotPasswordScreen.tsx');
const GUARD = (): string => read('core/security/authGuard.ts');
const APP = (): string => read('App.tsx');
const PHRASE = (): string => read('core/backup/seedPhrase.ts');

/** Убирает строки-комментарии: собственный русский текст не должен подменять код. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const slice = (src: string, from: string, to: string): string => {
  const i = src.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf(to, i + from.length);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j + to.length);
};

describe('повод для правки жив', () => {
  it('setPassword по-прежнему может ответить false', () => {
    const g = GUARD();
    expect(g).toContain('async setPassword(password: string): Promise<boolean> {');
    expect(g).toContain('if (passwordPolicyError(password)) return false;');
    expect(g).toContain("log.error('auth_set_password_failed'");
  });

  it('отсутствие пароля по-прежнему открывает приложение без замка', () => {
    const a = APP();
    const body = slice(a, 'const hasPwd = await authGuard.hasPassword();', 'setPasswordGateResolved(true);');
    expect(body).toContain('if (!hasPwd) {');
    expect(body).toContain('authGuard.unlockSession();');
    expect(body).toContain('setAppUnlocked(true);');
  });

  it('getStoredMnemonic по-прежнему отвечает null и на «нет», и на «не открылась»', () => {
    const p = PHRASE();
    expect(p).toContain('export async function getStoredMnemonic(): Promise<string | null> {');
    expect(p).toContain('export async function hasStoredMnemonic(): Promise<boolean> {');
  });

  it('verifyMnemonicMatchesWallet по-прежнему не приводит регистр и не убирает нумерацию', () => {
    const g = GUARD();
    const body = slice(g, 'async verifyMnemonicMatchesWallet(mnemonic: string)', '\n  }\n');
    expect(body).toContain('const normalized = mnemonic.trim().split(/\\s+/).join(\' \');');
    expect(body).not.toContain('toLowerCase');
    expect(body).not.toContain('normalizeSeedInput');
  });

  it('минимум пароля по-прежнему шесть символов', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(6);
  });
});

describe('describeRestoreLock — замок после восстановления', () => {
  it('записался — говорить нечего', () => {
    expect(describeRestoreLock(true, 'abcdef')).toEqual({ locked: true });
    expect(describeRestoreLock(true, '123')).toEqual({ locked: true });
  });

  it('короткий прежний пароль — причина названа отдельно', () => {
    const out = describeRestoreLock(false, '1234');
    expect(out.locked).toBe(false);
    expect(out).toMatchObject({ reason: 'policy', message: RESTORE_LOCK_POLICY_TEXT });
  });

  it('годный пароль и всё равно false — это отказ хранилища', () => {
    const out = describeRestoreLock(false, 'abcdef');
    expect(out.locked).toBe(false);
    expect(out).toMatchObject({ reason: 'storage', message: RESTORE_LOCK_STORAGE_TEXT });
  });

  it('оба текста разные и оба говорят, что замка нет и куда идти', () => {
    expect(RESTORE_LOCK_POLICY_TEXT).not.toBe(RESTORE_LOCK_STORAGE_TEXT);
    for (const t of [RESTORE_LOCK_POLICY_TEXT, RESTORE_LOCK_STORAGE_TEXT]) {
      expect(t).toContain('Настройки → Безопасность');
      expect(t).toMatch(/замок|замка/);
    }
  });
});

describe('decideStoredPhraseState — «нет» и «не открылась» это не одно', () => {
  it('записи нет', () => {
    expect(decideStoredPhraseState(false, null)).toBe('none');
    expect(decideStoredPhraseState(false, 'abandon ability')).toBe('none');
  });

  it('запись есть, а фразы нет — значит не открылась', () => {
    expect(decideStoredPhraseState(true, null)).toBe('unreadable');
    expect(decideStoredPhraseState(true, undefined)).toBe('unreadable');
    expect(decideStoredPhraseState(true, '   ')).toBe('unreadable');
  });

  it('запись есть и открылась', () => {
    expect(decideStoredPhraseState(true, 'abandon ability able')).toBe('ready');
  });
});

describe('онбординг проверяет ответ setPassword в обоих местах', () => {
  it('оба вызова обёрнуты, голых не осталось', () => {
    const src = codeOnly(ONB());
    expect(src.split('authGuard.setPassword(').length - 1).toBe(2);
    expect(src.split('describeRestoreLock(await authGuard.setPassword(').length - 1).toBe(2);
    expect(src).not.toContain('await authGuard.setPassword(cloudPwd);');
    expect(src.split("if (!lock.locked) Alert.alert('AirChat', lock.message);").length - 1).toBe(2);
  });

  it('восстановление доводится до конца, а не отменяется', () => {
    const src = ONB();
    const binding = slice(src, 'const handleRestoreFromBinding = async ()', '\n  };\n');
    const i = binding.indexOf('describeRestoreLock(');
    const j = binding.indexOf('await onComplete(pair);');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(binding.slice(i, j)).not.toContain('return;');
  });
});

describe('онбординг отличает нечитаемую фразу от её отсутствия', () => {
  it('эффект welcome спрашивает решение и запоминает его до вопроса о сидке', () => {
    const src = ONB();
    const eff = slice(src, 'const present = await hasStoredMnemonic();', "setStep('showSeed');");
    expect(eff).toContain('const phraseState = decideStoredPhraseState(present, stored);');
    expect(eff).toContain("setPhraseUnreadable(phraseState === 'unreadable');");
    expect(eff).toContain("if (phraseState !== 'ready') return;");
    expect(eff.indexOf('setPhraseUnreadable(')).toBeLessThan(eff.indexOf('await hasSeedShown()'));
    // отказ чтения тоже должен стать «не открылась», а не пролететь наружу
    expect(eff).toContain('stored = await getStoredMnemonic();');
    expect(eff).toContain('} catch {');
  });

  it('создание нового аккаунта поверх нечитаемой фразы переспрашивает', () => {
    const src = ONB();
    const body = slice(src, 'const handleCreateNew = async (): Promise<void> => {', 'setBusy(true);');
    expect(body).toContain('if (phraseUnreadable && !(await confirmOverwriteUnreadable())) return;');
    const dialog = slice(src, 'const confirmOverwriteUnreadable =', '\n    });\n');
    expect(dialog).toContain("style: 'cancel', onPress: () => resolve(false)");
    expect(dialog).toContain('onDismiss: () => resolve(false)');
    expect(dialog).toContain('сотрёт их навсегда');
    // запрета быть не должно: у кого запись правда испорчена — это его выход
    expect(codeOnly(src)).not.toContain('disabled={phraseUnreadable}');
  });

  it('welcome предупреждает вслух', () => {
    const src = ONB();
    const banner = slice(src, 'testID="onboarding_phrase_unreadable"', '</Text>');
    expect(banner).toContain('не читаются');
    expect(banner).toContain('Восстановить аккаунт');
    expect(src.indexOf('testID="onboarding_phrase_unreadable"')).toBeLessThan(
      src.indexOf('testID="btn_create_new"')
    );
  });
});

describe('восстановление пароля разбирает фразу так же, как онбординг', () => {
  it('используется общий разбор, свой trim убран', () => {
    const src = codeOnly(FORGOT());
    expect(src).toContain("import { checkSeedWordCount, normalizeSeedInput } from './seedInput';");
    expect(src).toContain('const m = normalizeSeedInput(mnemonic);');
    expect(src).toContain('const countCheck = checkSeedWordCount(m);');
    expect(src).toContain('showError(countCheck.message);');
    expect(src).not.toContain('const m = mnemonic.trim();');
    expect(src).not.toContain("showError('Введите секретные слова');");
  });

  it('разбор идёт до проверки пароля и до похода в хранилище', () => {
    // codeOnly обязателен: собственный комментарий выше цитирует
    // `verifyMnemonicMatchesWallet` и обрезал бы срез до самого кода.
    const src = codeOnly(FORGOT());
    const body = slice(src, 'const submit = async (): Promise<void> => {', 'authGuard.verifyMnemonicMatchesWallet(');
    expect(body.indexOf('normalizeSeedInput(')).toBeLessThan(body.indexOf('passwordPolicyError('));
  });

  it('подсказка про длину пароля берётся у политики, а не выдумана', () => {
    const src = codeOnly(FORGOT());
    expect(src).toContain('placeholder={`Минимум ${PASSWORD_MIN_LENGTH} символов`}');
    expect(src).not.toContain('Минимум 4 символа');
    expect(src).toContain("import { PASSWORD_MIN_LENGTH, passwordPolicyError } from '../../core/security/passwordPolicy';");
  });
});

describe('проверка не пустая', () => {
  it('файлы читаются и непусты', () => {
    for (const f of [ONB(), FORGOT(), GUARD(), APP(), PHRASE()]) {
      expect(f.length).toBeGreaterThan(500);
    }
  });

  it('codeOnly действительно срезает комментарии', () => {
    expect(codeOnly('// абв\nconst a = 1;\n')).toBe('const a = 1;\n');
  });
});
