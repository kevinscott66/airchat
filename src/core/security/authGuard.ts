/**
 * Пароль приложения: PBKDF2 (SHA-256), лимит попыток, блокировка.
 * Хранение через {@link ../storage/secureStoreQueued} — одна очередь с остальным Keystore.
 */
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { validateMnemonic } from 'bip39';
import * as SecureStore from '../storage/secureStoreQueued';
import { deriveKeyPairFromMnemonicForProfile } from '../backup/seedPhrase';
import { bytesEqualConstTime } from '../crypto/bytesEqual';
import { loadKeyPair } from '../crypto/keyManager';
import { profileManager } from '../identity/profileManager';
import { log } from '../logger';

const AUTH_PAYLOAD_KEY = 'airchat_app_password_v1';
const FAILED_ATTEMPTS_KEY = 'airchat_app_password_failed_v1';
const LAST_ATTEMPT_KEY = 'airchat_app_password_last_attempt_v1';

/**
 * Ключи SecureStore, где лежит проверочный материал пароля приложения.
 *
 * v4.32.353: экспортируется для проверки после сброса кошелька. Хэш пароля —
 * не менее личное, чем ключ: он переживает смену владельца устройства и
 * позволяет подобрать пароль офлайн.
 */
export const AUTH_SECURE_KEYS = [AUTH_PAYLOAD_KEY, FAILED_ATTEMPTS_KEY, LAST_ATTEMPT_KEY] as const;

/**
 * Сколько неудачных попыток до блокировки.
 *
 * v4.32.326: экспортируется, потому что то же число нужно экрану блокировки —
 * он решает по нему, показывать ли счётчик оставшихся попыток. Своя копия
 * пятёрки там уже стояла, и разъехалась бы при первой же правке здесь.
 */
export const AUTH_MAX_ATTEMPTS = 5;
const LOCKOUT_TIME_MS = 15 * 60 * 1000;
const PBKDF2_ITERS = 100_000;
const DK_LEN = 32;

type AuthPayloadV1 = {
  v: 1;
  saltB64: string;
  hashB64: string;
  c: number;
};

function hashPassword(password: string, salt: Uint8Array): Uint8Array {
  const pwd = new TextEncoder().encode(password);
  return pbkdf2(sha256, pwd, salt, { c: PBKDF2_ITERS, dkLen: DK_LEN });
}

/**
 * Счётчик неудачных попыток из хранилища (v4.32.315).
 *
 * `parseInt` от испорченного значения даёт NaN, а NaN тут заразен: `NaN < 5`
 * ложно, значит счётчик не растёт; `NaN + 1` снова NaN, значит и не запишется
 * ничего осмысленного; `5 - NaN` показывается человеку как «осталось NaN
 * попыток». Испорченное значение — это ноль попыток: единственный безопасный
 * ответ здесь тот, который оставляет блокировку работающей дальше.
 */
function parseAttempts(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export class AuthGuard {
  private static instance: AuthGuard;

  private sessionUnlocked = false;
  // SecureStore has no atomic increment. Serialize password checks so two
  // concurrent screens cannot both read the same attempt count and overwrite
  // each other's failed-attempt update.
  private attemptQueue: Promise<unknown> = Promise.resolve();

  static getInstance(): AuthGuard {
    if (!AuthGuard.instance) AuthGuard.instance = new AuthGuard();
    return AuthGuard.instance;
  }

  /** Минимальная длина пароля приложения. */
  minPasswordLength = 4;

  isSessionUnlocked(): boolean {
    return this.sessionUnlocked;
  }

  unlockSession(): void {
    this.sessionUnlocked = true;
  }

  lockSession(): void {
    this.sessionUnlocked = false;
  }

  async hasPassword(): Promise<boolean> {
    const raw = await SecureStore.getItemAsync(AUTH_PAYLOAD_KEY);
    return !!raw?.trim();
  }

  async setPassword(password: string): Promise<boolean> {
    if (password.length < this.minPasswordLength) return false;
    try {
      const salt = randomBytes(32);
      const hash = hashPassword(password, salt);
      const payload: AuthPayloadV1 = {
        v: 1,
        saltB64: Buffer.from(salt).toString('base64'),
        hashB64: Buffer.from(hash).toString('base64'),
        c: PBKDF2_ITERS,
      };
      await SecureStore.setItemAsync(AUTH_PAYLOAD_KEY, JSON.stringify(payload));
      await this.resetFailedAttempts();
      return true;
    } catch (e) {
      log.error('auth_set_password_failed', { err: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /**
   * Проверка пароля для экрана блокировки: при успехе разблокирует сессию.
   */
  async checkPassword(password: string): Promise<boolean> {
    return this.serializeAttempt(() => this.checkPasswordOnce(password));
  }

  private async checkPasswordOnce(password: string): Promise<boolean> {
    if (await this.isLocked()) return false;
    const ok = await this.verifyPasswordInternal(password);
    if (ok) {
      await this.resetFailedAttempts();
      this.sessionUnlocked = true;
      return true;
    }
    await this.recordFailedAttempt();
    return false;
  }

  /**
   * Проверка пароля без смены флага сессии (например просмотр seed).
   */
  async verifyPassword(password: string): Promise<boolean> {
    return this.serializeAttempt(() => this.verifyPasswordOnce(password));
  }

  private async verifyPasswordOnce(password: string): Promise<boolean> {
    if (await this.isLocked()) return false;
    const ok = await this.verifyPasswordInternal(password);
    if (ok) {
      await this.resetFailedAttempts();
      return true;
    }
    await this.recordFailedAttempt();
    return false;
  }

  private serializeAttempt<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.attemptQueue.catch(() => undefined).then(operation);
    this.attemptQueue = current.catch(() => undefined);
    return current;
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    if (newPassword.length < this.minPasswordLength) return false;
    // v4.32.315: через verifyPassword, а не напрямую. Прямой вызов проходил мимо
    // счётчика попыток и мимо блокировки — то есть форма «сменить пароль» была
    // площадкой для подбора старого пароля без ограничений, в обход тех самых
    // пяти попыток и пятнадцати минут, которыми защищён экран блокировки.
    if (!(await this.verifyPassword(oldPassword))) return false;
    return this.setPassword(newPassword);
  }

  private async verifyPasswordInternal(password: string): Promise<boolean> {
    const raw = await SecureStore.getItemAsync(AUTH_PAYLOAD_KEY);
    // v4.32.176: если payload отсутствует — возвращаем false, а не true.
    // Раньше transient SecureStore miss (Keystore race после boot) давал
    // эффект password-bypass в changePassword и других местах, которые
    // вызывают verifyPasswordInternal. Bypass-when-unset должен жить только
    // в checkPasswordOrBypassIfUnset (явно проверяющем hasPassword).
    if (!raw?.trim()) return false;
    let payload: AuthPayloadV1;
    try {
      payload = JSON.parse(raw) as AuthPayloadV1;
    } catch {
      return false;
    }
    if (payload.v !== 1 || !payload.saltB64 || !payload.hashB64) return false;
    const salt = new Uint8Array(Buffer.from(payload.saltB64, 'base64'));
    const expected = new Uint8Array(Buffer.from(payload.hashB64, 'base64'));
    const computed = hashPassword(password, salt);
    return bytesEqualConstTime(computed, expected);
  }

  /** Пароль не задан — вход без запроса. */
  async checkPasswordOrBypassIfUnset(password: string): Promise<boolean> {
    if (!(await this.hasPassword())) {
      this.sessionUnlocked = true;
      return true;
    }
    return this.checkPassword(password);
  }

  async verifyMnemonicMatchesWallet(mnemonic: string): Promise<boolean> {
    const kp = await loadKeyPair();
    if (!kp) return false;
    const normalized = mnemonic.trim().split(/\s+/).join(' ');
    if (!validateMnemonic(normalized)) return false;
    await profileManager.init();
    const ap = profileManager.getActiveProfile();
    const idx = ap?.derivationIndex ?? 0;
    const derived = deriveKeyPairFromMnemonicForProfile(normalized, idx);
    return bytesEqualConstTime(derived.publicKey, kp.publicKey);
  }

  /**
   * Задать новый пароль, не зная старого, — по секретным словам.
   *
   * v4.32.316: слова принимаются сюда, а не проверяются снаружи. Это
   * единственный способ сменить пароль приложения, не предъявив его, и до сих
   * пор он полагался на то, что вызывающий сам сходил в
   * {@link verifyMnemonicMatchesWallet} — название обещало проверку, которой
   * внутри не было. Один невнимательный вызов означал бы снятие пароля с чужого
   * устройства без всяких слов; теперь такого вызова написать нельзя.
   *
   * Экран восстановления всё равно проверяет слова и до этого — чтобы сказать
   * «слова не совпадают с аккаунтом» отдельно от «не удалось сохранить». Лишняя
   * проверка стоит одного bip39-вывода на нажатие кнопки раз в жизни.
   */
  async resetPasswordWithVerifiedSeed(mnemonic: string, newPassword: string): Promise<boolean> {
    if (newPassword.length < this.minPasswordLength) return false;
    if (!(await this.verifyMnemonicMatchesWallet(mnemonic))) return false;
    const ok = await this.setPassword(newPassword);
    if (ok) {
      await this.resetFailedAttempts();
      this.sessionUnlocked = true;
    }
    return ok;
  }

  async getRemainingAttempts(): Promise<number> {
    const attempts = await this.getFailedAttempts();
    return Math.max(0, AUTH_MAX_ATTEMPTS - attempts);
  }

  async getLockoutTimeRemaining(): Promise<number> {
    if (!(await this.isLocked())) return 0;
    const since = await this.msSinceLastAttempt();
    if (since === null) return 0;
    return Math.max(0, LOCKOUT_TIME_MS - since);
  }

  async isLocked(): Promise<boolean> {
    const attempts = await this.getFailedAttempts();
    if (attempts < AUTH_MAX_ATTEMPTS) return false;
    const since = await this.msSinceLastAttempt();
    if (since === null || since >= LOCKOUT_TIME_MS) {
      await this.resetFailedAttempts();
      return false;
    }
    return true;
  }

  /**
   * Сколько прошло с последней неудачной попытки; `null` — «неизвестно».
   *
   * v4.32.315: неизвестно — значит блокировку надо снять, и вот почему. Отметка
   * времени хранится как строка, и раньше её испорченное значение давало NaN:
   * `NaN >= 15 минут` ложно, поэтому блокировка не истекала НИКОГДА, а
   * оставшееся время показывалось как NaN. Выйти из этого можно было только
   * сбросом пароля по seed-фразе.
   *
   * Отметка в будущем (часы перевели назад — например телефон впервые поймал
   * точное время и отъехал на год) считается тем же «неизвестно». Слабее защита
   * от этого не становится: подбирающий может перевести часы и вперёд, а вот
   * хозяин от съехавших часов оказывался заперт всерьёз и надолго.
   */
  private async msSinceLastAttempt(): Promise<number | null> {
    const raw = await SecureStore.getItemAsync(LAST_ATTEMPT_KEY);
    const ts = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(ts)) return null;
    const delta = Date.now() - ts;
    return delta < 0 ? null : delta;
  }

  async clearAllAuthData(): Promise<void> {
    this.sessionUnlocked = false;
    try {
      await SecureStore.deleteItemAsync(AUTH_PAYLOAD_KEY);
    } catch {
      /* ignore */
    }
    await this.resetFailedAttempts();
  }

  private async recordFailedAttempt(): Promise<void> {
    const attempts = (await this.getFailedAttempts()) + 1;
    await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, attempts.toString());
    await SecureStore.setItemAsync(LAST_ATTEMPT_KEY, Date.now().toString());
  }

  private async resetFailedAttempts(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(FAILED_ATTEMPTS_KEY);
    } catch {
      /* ignore */
    }
    try {
      await SecureStore.deleteItemAsync(LAST_ATTEMPT_KEY);
    } catch {
      /* ignore */
    }
  }

  private async getFailedAttempts(): Promise<number> {
    return parseAttempts(await SecureStore.getItemAsync(FAILED_ATTEMPTS_KEY));
  }
}

export const authGuard = AuthGuard.getInstance();
