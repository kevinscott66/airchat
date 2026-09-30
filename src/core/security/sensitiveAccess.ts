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
import { PASSWORD_UNUSABLE_TEXT } from './passwordVerdict';

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
 *
 * v4.32.1083: `unusable` — запись пароля есть, но сверить с ней нечего. Это
 * не отказ по паролю: попытка не тратится, и говорить «неверный» не о чем.
 */
export type SensitiveUnlock = 'ok' | 'empty' | 'rejected' | 'no_password' | 'unusable';

/** Слово про повреждённую запись — одно на все двери, см. passwordVerdict.ts. */
export const SENSITIVE_UNUSABLE_TEXT = PASSWORD_UNUSABLE_TEXT;

/** Текст для случая, когда пароль ещё не заведён. */
export const SENSITIVE_NO_PASSWORD_TEXT =
  'Раздел защищён паролем приложения. Задайте его в «Настройки → Безопасность».';

export async function sensitiveAccessGate(): Promise<SensitiveGate> {
  return (await authGuard.hasPassword()) ? 'verify' : 'set_password';
}

export async function unlockSensitiveAccess(password: string): Promise<SensitiveUnlock> {
  if (!password.trim()) return 'empty';
  // Пароля нет — verifyPassword ответил бы «сверять не с чем», а человеку
  // здесь надо сказать не про повреждённую запись, а про незаведённый пароль.
  if (!(await authGuard.hasPassword())) return 'no_password';
  const verdict = await authGuard.verifyPassword(password);
  if (verdict === 'ok') return 'ok';
  // v4.32.1083: «сверять не с чем» — не «не подошёл». За обеими дверьми
  // лежат секретные слова, и отправлять за ними человека с верным паролем,
  // сказав ему, что пароль неверный, — худшее, что здесь можно сделать.
  return verdict === 'unusable' ? 'unusable' : 'rejected';
}
