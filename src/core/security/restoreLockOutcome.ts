/**
 * restoreLockOutcome — что говорить человеку, если пароль после восстановления
 * не записался (v4.32.651).
 *
 * Дефект. `authGuard.setPassword` отвечает `boolean`, и оба места
 * восстановления в онбординге ответ выбрасывали: `await
 * authGuard.setPassword(cloudPwd);`. Комментарий над одним из них прямо
 * называет цель — «иначе приложение осталось бы без замка, а человек — с
 * уверенностью, что пароль у него есть», — а код её не выполнял.
 *
 * `false` приходит по двум разным причинам, и обе достижимы именно здесь.
 * Первая: пароль не проходит нынешнюю политику. Облачная копия открылась
 * старым паролем — значит он был заведён прежней версией, где минимума в
 * {@link PASSWORD_MIN_LENGTH} символов ещё не было. Вторая: защищённое
 * хранилище отказало в записи.
 *
 * Отменять из-за этого восстановление нельзя: ключи уже сохранены, аккаунт уже
 * поднят, откат сделал бы хуже. Молчать — тоже: `App` при отсутствии пароля
 * снимает замок и открывает приложение, и так будет каждый следующий запуск.
 * Поэтому восстановление доводится до конца, а про замок говорится прямо и с
 * разной причиной — коротким паролем человек распорядится сам, отказ хранилища
 * стоит просто повторить.
 */

import { passwordPolicyError } from './passwordPolicy';

export const RESTORE_LOCK_POLICY_TEXT =
  'Аккаунт восстановлен. Прежний пароль слишком короткий для этой версии, поэтому замок не поставлен — задайте пароль в «Настройки → Безопасность».';

export const RESTORE_LOCK_STORAGE_TEXT =
  'Аккаунт восстановлен, но сохранить пароль не удалось — приложение осталось без замка. Задайте пароль в «Настройки → Безопасность».';

export type RestoreLockOutcome =
  | { locked: true }
  | { locked: false; reason: 'policy' | 'storage'; message: string };

/**
 * @param saved ответ {@link authGuard.setPassword}
 * @param password тот самый пароль — по нему отличается причина отказа
 */
export function describeRestoreLock(saved: boolean, password: string): RestoreLockOutcome {
  if (saved) return { locked: true };
  if (passwordPolicyError(password)) {
    return { locked: false, reason: 'policy', message: RESTORE_LOCK_POLICY_TEXT };
  }
  return { locked: false, reason: 'storage', message: RESTORE_LOCK_STORAGE_TEXT };
}
