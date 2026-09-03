/**
 * Обязательный пароль приложения перед «Резервной копией» и seed-фразой.
 *
 * v4.32.548: раньше пароль был необязательным украшением — если он не задан,
 * раздел открывался сразу, а двадцать четыре слова показывались по одной
 * кнопке «Показать». Между тем из seed-фразы личность восстанавливается
 * целиком: чужие руки на разблокированном телефоне — это и переписка, и
 * аккаунт, и облачная копия. Поэтому вход теперь возможен только двумя
 * путями: ввести пароль или сначала его завести.
 *
 * Логика вынесена из экранов, потому что дверей две — «Настройки → Резервная
 * копия» и «Профиль → Секретные слова», — и разъехаться они не должны.
 */
import { authGuard } from './authGuard';

/**
 * Что делать перед тем, как открыть защищённое место:
 * `set_password` — пароля нет, сперва завести; `verify` — спросить его.
 */
export type SensitiveGate = 'set_password' | 'verify';

/**
 * Итог попытки открыть защищённое место паролем.
 *
 * `empty` отделён от `rejected` намеренно: пустая строка не тратит одну из
 * пяти попыток {@link authGuard}, иначе случайное нажатие «Показать»
 * приближало бы пятнадцатиминутную блокировку.
 */
export type SensitiveUnlock = 'ok' | 'empty' | 'rejected' | 'no_password';

/** Текст для случая, когда пароль ещё не заведён. */
export const SENSITIVE_NO_PASSWORD_TEXT =
  'Раздел защищён паролем приложения. Задайте его в «Настройки → Безопасность».';

export async function sensitiveAccessGate(): Promise<SensitiveGate> {
  return (await authGuard.hasPassword()) ? 'verify' : 'set_password';
}

export async function unlockSensitiveAccess(password: string): Promise<SensitiveUnlock> {
  if (!password.trim()) return 'empty';
  // Пароля нет — verifyPassword вернул бы false и списал попытку, а человек
  // читал бы «неверный пароль» про пароль, которого не существует.
  if (!(await authGuard.hasPassword())) return 'no_password';
  return (await authGuard.verifyPassword(password)) ? 'ok' : 'rejected';
}
