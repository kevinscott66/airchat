import { Alert, Platform, ToastAndroid } from 'react-native';
import { authGuard } from '../../core/security/authGuard';
import { localHalfDone, peerHalfDone, type TwoSidedOutcome } from '../../core/social/twoSidedEdit';
import { pushConfirm, pushToast, type ConfirmActionSpec } from './appNotify';

/**
 * Понятные уведомления без технического жаргона для пользователя.
 *
 * v4.32.578: уведомления рисует само приложение, а не система. Раньше здесь
 * стоял `Alert.alert` на iOS и `ToastAndroid` на Android — и то и другое живёт
 * снаружи темы: поверх тёмного приложения открывалось светлое системное окно,
 * а «Скопировано» требовало нажать «ОК». Теперь обе ветки зовут шину
 * `appNotify`, а системное окно остаётся запасным выходом на тот случай, если
 * хост ещё не смонтирован (ранний старт, тесты): молча терять уведомление
 * нельзя.
 */
export function showError(message: string): void {
  if (pushToast('error', message)) return;
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
  if (pushToast('success', message)) return;
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('Готово', message);
  }
}

/**
 * Диалог подтверждения в теме приложения — замена `Alert.alert` с кнопками.
 *
 * Отличие от системного окна не только в цвете. `Alert.alert` на Android
 * рендерит лишь ПЕРВЫЕ ТРИ кнопки и молча выбрасывает остальные (это же
 * объяснено в `ActionSheet.tsx`), поэтому «Удалить у себя / Удалить у всех /
 * Отмена» держалось ровно на пределе. Здесь список кнопок не ограничен.
 *
 * `cancel: true` у последней кнопки — не стиль, а поведение: она закрывает окно
 * и не зовёт обработчик, как и тап по подложке.
 */
export function showConfirm(spec: { title: string; message?: string; actions: ConfirmActionSpec[] }): void {
  if (pushConfirm(spec)) return;
  Alert.alert(
    spec.title,
    spec.message ?? '',
    spec.actions.map((a) => ({
      text: a.label,
      style: a.cancel ? ('cancel' as const) : a.destructive ? ('destructive' as const) : ('default' as const),
      onPress: a.onPress,
    }))
  );
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
