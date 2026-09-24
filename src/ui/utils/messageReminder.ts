/**
 * messageReminder — диалог «Напомнить о сообщении» и постановка напоминания.
 *
 * v4.32.257: раньше этот диалог был выписан в трёх местах целиком, вместе с
 * созданием канала уведомлений и обработкой ошибки. Варианты и тексты живут в
 * reminderSchedule (чистый модуль с тестами), а notifee — здесь.
 *
 * v4.32.857: сама постановка уехала в `reminderNotifications`. Здесь остался
 * диалог — и только он. Напоминание надо не только поставить, но и снять
 * (при удалении личности и при полном сбросе устройства), а звать ради этого
 * модуль с `Alert` из слоя кошелька было бы неправильно.
 */

import { Alert } from 'react-native';
import { REMINDER_CHOICES } from '../../core/notifications/reminderSchedule';
import { scheduleMessageReminder } from '../../notifications/reminderNotifications';

/**
 * Показывает выбор срока. Подтверждение показывается только после того, как
 * напоминание действительно создано, — иначе экран рапортует об успехе там,
 * где notifee отказал (нет разрешения на уведомления).
 */
export function promptMessageReminder(
  preview: string,
  onSuccess: (message: string) => void,
  onError: (message: string) => void
): void {
  Alert.alert('Напомнить о сообщении', `«${preview}»`, [
    ...REMINDER_CHOICES.map((choice) => ({
      text: choice.label,
      onPress: () => {
        void scheduleMessageReminder(choice.kind, preview)
          .then(() => onSuccess(choice.success))
          .catch(() => onError('Не удалось создать напоминание'));
      },
    })),
    { text: 'Отмена', style: 'cancel' as const },
  ]);
}
