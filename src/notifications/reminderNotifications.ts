/**
 * Отложенные напоминания о сообщении: постановка и снятие (v4.32.857).
 *
 * До этой версии всё это жило одной функцией внутри диалога `messageReminder`
 * в слое экранов и умело ровно одно — поставить. Отсюда два изъяна, каждый из
 * которых виден только снаружи диалога:
 *
 * 1. В шторку уходил текст сообщения. Ни «Показывать текст сообщений», ни
 *    пароль на вход не проверялись, хотя ради них написан `previewAllowed` в
 *    pushNotifications. Напоминание — единственное уведомление, которое
 *    приходит без интернета и без запущенного приложения: оно доживёт до
 *    чужих рук вернее всякого push.
 * 2. Снять напоминание не мог никто. Во всём проекте не было ни одного вызова
 *    `cancelTriggerNotifications`, и поставленное «через неделю» срабатывало
 *    после «выйти и удалить данные на устройстве» — на телефоне, где от этой
 *    личности не осталось ничего, кроме этой самой строки с текстом чужого
 *    сообщения.
 *
 * Модуль тянет notifee по требованию, как `callBanner`: его зовут из сброса
 * кошелька и из удаления личности — путей, которым слой уведомлений на старте
 * не нужен, а в тестовой среде и в Expo Go его нет вовсе.
 */
import {
  reminderBody,
  reminderNotificationId,
  reminderIdsOfProfile,
  reminderTimestamp,
  type ReminderKind,
} from '../core/notifications/reminderSchedule';
import { NOTIFICATION_SMALL_ICON } from './notificationIcon';
import { kvTryGet } from '../core/storage/local';
import { authGuard } from '../core/security/authGuard';
import { profileManager } from '../core/identity/profileManager';
import { log } from '../core/logger';

type NotifeeModule = {
  createChannel(channel: { id: string; name: string; importance: number }): Promise<string>;
  createTriggerNotification(notification: unknown, trigger: unknown): Promise<string>;
  getTriggerNotificationIds(): Promise<string[]>;
  cancelTriggerNotifications(ids?: string[]): Promise<void>;
  cancelDisplayedNotifications(ids?: string[]): Promise<void>;
};

/**
 * notifee и его перечисление видов срабатывания — или null, если его на этой
 * платформе нет (тесты, Expo Go, web).
 *
 * `TriggerType` берётся из того же require, а не импортом сверху: это
 * обыкновенное перечисление, и импорт ради одного числа поднимал бы весь
 * модуль уведомлений на старте — ровно то, чего этот файл избегает.
 */
function notifeeOrNull(): { notifee: NotifeeModule; timestampTrigger: number } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@notifee/react-native') as {
      default?: NotifeeModule;
      TriggerType?: { TIMESTAMP: number };
    };
    const notifee = mod.default;
    const timestampTrigger = mod.TriggerType?.TIMESTAMP;
    if (!notifee || typeof timestampTrigger !== 'number') return null;
    return { notifee, timestampTrigger };
  } catch {
    return null;
  }
}

/**
 * Можно ли вынести текст сообщения на заблокированный экран.
 *
 * Оба запрета читаются здесь и сейчас, потому что в момент срабатывания
 * спрашивать будет некого. Нечитаемая ячейка настроек — это не «настройки
 * нет»: в спорном случае текст прячем. Так же поступает сверка аватаров,
 * и по той же причине — цена ошибки несимметрична.
 */
async function reminderPreviewAllowed(): Promise<boolean> {
  try {
    const cell = await kvTryGet('notify_preview');
    if (!cell) return false;
    if (cell.value === 'false') return false;
    return !(await authGuard.hasPassword());
  } catch {
    return false;
  }
}

/**
 * Поставить напоминание. Бросает наружу: подтверждение человеку показывается
 * только после того, как notifee действительно принял уведомление.
 */
export async function scheduleMessageReminder(kind: ReminderKind, preview: string): Promise<void> {
  const mod = notifeeOrNull();
  if (!mod) throw new Error('notifications_unavailable');
  const { notifee, timestampTrigger } = mod;
  const body = reminderBody(preview, await reminderPreviewAllowed());
  const profileId = profileManager.getActiveProfile()?.id ?? 1;
  const uniq = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const channelId = await notifee.createChannel({ id: 'reminders', name: 'Напоминания', importance: 4 });
  await notifee.createTriggerNotification(
    {
      id: reminderNotificationId(profileId, uniq),
      title: 'AirChat — напоминание',
      body,
      android: { channelId, smallIcon: NOTIFICATION_SMALL_ICON },
    },
    { type: timestampTrigger, timestamp: reminderTimestamp(kind, Date.now()) }
  );
}

/**
 * Снять напоминания удалённой личности — и только её.
 *
 * Напоминания остальных остаются: человек их себе ставил, и удаление соседней
 * личности не повод молча отменить то, о чём он просил напомнить.
 */
export async function cancelRemindersForProfile(profileId: number): Promise<void> {
  const notifee = notifeeOrNull()?.notifee;
  if (!notifee) return;
  const ids = reminderIdsOfProfile(await notifee.getTriggerNotificationIds(), profileId);
  if (ids.length === 0) return;
  await notifee.cancelTriggerNotifications(ids);
  log.info('reminders_cancelled_for_profile', { profileId, count: ids.length });
}

/**
 * Снять всё при полном сбросе устройства.
 *
 * Здесь список не фильтруется: личностей после сброса не остаётся ни одной,
 * а напоминания, поставленные до v4.32.857, своего имени не имеют — отобрать
 * их было бы нечем, и ровно они самые старые и самые опасные.
 *
 * Показанные уведомления снимаются тем же заходом. Сработавшее напоминание —
 * это строка в шторке с текстом сообщения, и после «удалить данные» она
 * остаётся единственным местом, где этот текст ещё можно прочитать.
 */
export async function cancelAllReminders(): Promise<void> {
  const notifee = notifeeOrNull()?.notifee;
  if (!notifee) return;
  await notifee.cancelTriggerNotifications();
  await notifee.cancelDisplayedNotifications();
}
