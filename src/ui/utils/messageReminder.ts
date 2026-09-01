/**
 * messageReminder — диалог «Напомнить о сообщении» и постановка напоминания.
 *
 * v4.32.257: раньше этот диалог был выписан в трёх местах целиком, вместе с
 * созданием канала уведомлений и обработкой ошибки. Варианты и тексты живут в
 * reminderSchedule (чистый модуль с тестами), а notifee — здесь.
 */

import { Alert } from 'react-native';
import notifee, { TriggerType } from '@notifee/react-native';
import { REMINDER_CHOICES, reminderTimestamp, type ReminderKind } from '../../core/notifications/reminderSchedule';
import { NOTIFICATION_SMALL_ICON } from '../../notifications/notificationIcon';

async function scheduleReminderNotification(kind: ReminderKind, preview: string): Promise<void> {
  const channelId = await notifee.createChannel({ id: 'reminders', name: 'Напоминания', importance: 4 });
  await notifee.createTriggerNotification(
    { title: 'AirChat — напоминание', body: preview, android: { channelId, smallIcon: NOTIFICATION_SMALL_ICON } },
    { type: TriggerType.TIMESTAMP, timestamp: reminderTimestamp(kind, Date.now()) }
  );
}

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
        void scheduleReminderNotification(choice.kind, preview)
          .then(() => onSuccess(choice.success))
          .catch(() => onError('Не удалось создать напоминание'));
      },
    })),
    { text: 'Отмена', style: 'cancel' as const },
  ]);
}
