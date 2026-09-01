import { Alert, Platform, ToastAndroid } from 'react-native';
import { authGuard } from '../../core/security/authGuard';
import { localHalfDone, peerHalfDone, type TwoSidedOutcome } from '../../core/social/twoSidedEdit';

/**
 * Понятные уведомления без технического жаргона для пользователя.
 * Понятное уведомление об ошибке (Toast на Android, Alert на iOS).
 */
export function showError(message: string): void {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.LONG);
  } else {
    Alert.alert('Ошибка', message);
  }
}

/**
 * Пароль приложения не подошёл — сказать, почему именно (v4.32.315).
 *
 * Отказ бывает двух видов, и путать их нельзя. «Неверный пароль» на самом деле
 * означало ещё и «попыток больше нет, подождите» — и человек с ВЕРНЫМ паролем
 * читал, что пароль неверный, пробовал снова и снова получал то же самое, не
 * понимая, что происходит и когда это кончится. Экран блокировки про срок
 * говорит с самого начала; смена пароля и просмотр seed-фразы — теперь тоже.
 */
export async function showPasswordRejected(): Promise<void> {
  const waitMs = await authGuard.getLockoutTimeRemaining();
  if (waitMs > 0) {
    showError(`Слишком много попыток. Повторите через ${Math.ceil(waitMs / 60_000)} мин`);
    return;
  }
  const left = await authGuard.getRemainingAttempts();
  showError(left > 0 ? `Неверный пароль. Осталось попыток: ${left}` : 'Неверный пароль');
}

/** Краткое уведомление об успехе. */
export function showSuccess(message: string): void {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('Готово', message);
  }
}

/**
 * Чем кончилось «удалить у всех» / «изменить у всех» — словами.
 *
 * v4.32.431. Формулировок было две на два вызова, и обе неверные. Одна
 * говорила «Не удалось удалить — нет связи с облаком», хотя у себя сообщение к
 * тому моменту не удалялось вовсе (порядок операций был обратный), а вторая не
 * говорила ничего: результат просто выбрасывался.
 *
 * v4.32.555. Исходов оказалось не два, а три. Слов было два — «у всех» и «у
 * вас, но собеседнику не удалось», — и второе становилось ложью, когда у себя
 * тоже ничего не произошло: сообщение оставалось на экране, а текст уверял,
 * что оно удалено. Третий исход теперь называется своим именем, а сам тип
 * `TwoSidedOutcome` не позволяет его пропустить.
 */
export function reportTwoSided(outcome: TwoSidedOutcome, op: 'delete' | 'edit'): void {
  const done = op === 'delete' ? 'удалено' : 'изменено';
  const verb = op === 'delete' ? 'удалить' : 'изменить';
  if (!localHalfDone(outcome)) {
    showError(`Не удалось ${verb} сообщение`);
    return;
  }
  if (peerHalfDone(outcome)) {
    showSuccess(`Сообщение ${done} у всех`);
    return;
  }
  showError(`Сообщение ${done} у вас, но собеседнику отправить не удалось`);
}
