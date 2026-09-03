/**
 * Register before App. Optional: @react-native-firebase/messaging background handler.
 * Safe no-op when native Firebase module is missing (Expo Go / tests).
 */
import './bootstrap-fusebox-global';
import { NOTIFICATION_SMALL_ICON } from './notifications/notificationIcon';
import {
  deliverOpenIntent,
  parseCallOpenIntent,
  parseChatOpenIntent,
  parseOpenIntent,
} from './notifications/openIntent';
import { vibrationFor } from './notifications/vibrationPattern';
import { parsePushKind } from './notifications/pushKind';
import {
  CALL_BANNER_BODY,
  CALL_BANNER_TIMEOUT_MS,
  CALL_BANNER_TITLE,
  callBannerId,
} from './notifications/callPush';
import { log } from './core/logger';

/**
 * Окно входящего звонка при свёрнутом или закрытом приложении.
 *
 * v4.32.573. До этой версии звонок жил только в живом сокете сигналинга:
 * закрытому приложению он не доезжал вовсе, а звонящий получал «Недоступен»
 * на первой секунде (см. notifications/callPush). Здесь — тот самый баннер,
 * ради которого push и посылается: полноэкранное намерение на канале звонков,
 * которое Android поднимает поверх экрана блокировки.
 *
 * Имя звонящего сервером не присылается и здесь не показывается — то же
 * правило, что и у сообщений: сервер не должен уметь написать чужим именем на
 * экране блокировки. Кто звонит, приложение покажет само, когда поднимется.
 */
async function showIncomingCallBanner(callId: string, contactDid?: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readBackgroundCallPrefs } = require('./notifications/backgroundNotifyPrefs') as typeof import('./notifications/backgroundNotifyPrefs');
  const prefs = await readBackgroundCallPrefs();
  if (!prefs.show) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const notifee = require('@notifee/react-native').default;
  const { AndroidCategory, AndroidImportance } = require('@notifee/react-native');
  const CHANNEL = 'airchat_calls_v2';
  await notifee.createChannel({
    id: CHANNEL,
    name: 'Звонки',
    description: 'Входящие голосовые и видеозвонки',
    importance: AndroidImportance.HIGH,
    vibration: true,
  });
  await notifee.displayNotification({
    id: callBannerId(callId),
    title: CALL_BANNER_TITLE,
    body: CALL_BANNER_BODY,
    data: { kind: 'call', cid: callId, contactDid: contactDid ?? '' },
    android: {
      channelId: CHANNEL,
      smallIcon: NOTIFICATION_SMALL_ICON,
      category: AndroidCategory.CALL,
      importance: AndroidImportance.HIGH,
      pressAction: { id: 'default' },
      // Полноэкранное намерение — то, чем Android поднимает окно звонка поверх
      // заблокированного экрана. На Android 14+ ему нужно разрешение
      // USE_FULL_SCREEN_INTENT (объявлено в app.json); без разрешения система
      // сама опускает уведомление до обычного баннера, а не отвергает его.
      fullScreenAction: { id: 'default' },
      // Звонок не смахивается сам: он либо принят, либо кончился по времени.
      ongoing: true,
      autoCancel: false,
      timeoutAfter: CALL_BANNER_TIMEOUT_MS,
      vibrationPattern: vibrationFor(prefs.vibrate, 'message'),
      sound: prefs.sound ? 'default' : undefined,
    },
  });
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const messaging = require('@react-native-firebase/messaging').default;
  messaging().setBackgroundMessageHandler(async (remoteMessage: { data?: Record<string, string> }) => {
    // v4.32.573: звонок разбирается раньше сообщения. Его конверт неотличим от
    // личного, и без этой ветки push о звонке уехал бы в ветку сообщений — а
    // там его номер ушёл бы в сеть как ключ несуществующего сообщения.
    const call = parseCallOpenIntent(remoteMessage.data);
    if (call) {
      try {
        await showIncomingCallBanner(call.callId, call.contactDid);
      } catch (e) {
        log.warn('bg_call_notify_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    // v4.32.180 (Round-10): validate cid/contactDid shape same as foreground handler.
    // v4.32.558: одна проверка на все три пути — см. notifications/openIntent.
    const intent = parseChatOpenIntent(remoteMessage.data);
    if (!intent) return;
    const { cid, contactDid } = intent;
    try {
      // v4.32.248: фоновый обработчик не спрашивал настройки вообще —
      // выключенные уведомления, «Не беспокоить», отключённые звук и вибрация
      // не действовали ни на один баннер, пришедший при закрытом приложении.
      // То есть настройки работали только когда приложение открыто.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { isBackgroundMuted, readBackgroundNotifyPrefs } = require('./notifications/backgroundNotifyPrefs') as typeof import('./notifications/backgroundNotifyPrefs');
      // v4.32.572: сообщение в группе едет тем же конвертом, что и личное, и
      // до этой версии фоновый путь считал его личным: выключатель «Группы»
      // не спрашивался никогда, а «без звука» для человека глушило его
      // сообщения в общей группе. Один бит вида приезжает вместе с push.
      const kind = parsePushKind(remoteMessage.data?.kind);
      const prefs = await readBackgroundNotifyPrefs(kind);
      if (!prefs.show) return;
      // v4.32.502: «без звука» для собеседника действовало только при открытом
      // приложении — то есть не действовало вовсе там, ради чего его включают.
      // v4.32.572: к группе личное «без звука» не применяется — заглушён
      // человек, а не общая группа. Глушение самой группы при закрытом
      // приложении невозможно: её идентификатора в push нет и быть не должно.
      if (kind === 'dm' && (await isBackgroundMuted(contactDid))) return;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { bannerIdForCid } = require('./notifications/bannerId') as typeof import('./notifications/bannerId');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const notifee = require('@notifee/react-native').default;
      const { AndroidImportance } = require('@notifee/react-native');
      // v4.32.180 (Round-10 #1): use same HIGH-importance channel as foreground
      // (airchat_messages_v2 from v4.32.165). Previously the background handler
      // posted to MIN-importance `airchat_messages`, so backgrounded/killed pushes
      // arrived silent — no heads-up, no sound — which defeats the notification UX.
      const CHANNEL = 'airchat_messages_v2';
      await notifee.createChannel({
        id: CHANNEL,
        name: 'Сообщения',
        importance: AndroidImportance.HIGH,
      });
      // v4.32.220 (Paranoid HIGH-4): ignore server-supplied senderName. The
      // FCM relay sees cid/contactDid only, but a rogue relay could still
      // inject an arbitrary title into the push payload and we'd render it
      // verbatim on the user's lockscreen. Keep the banner generic at the
      // background path — the foreground handler resolves the real contact
      // name locally from the contacts DB before showing the banner.
      await notifee.displayNotification({
        // v4.32.502: одно имя на оба пути показа — именной баннер из
        // приложения заменяет этот безличный, а не встаёт рядом с ним.
        id: bannerIdForCid(cid),
        title: 'AirChat',
        body: 'Новое сообщение — откройте приложение',
        data: { cid, contactDid: contactDid ?? '' },
        android: {
          channelId: CHANNEL,
          smallIcon: NOTIFICATION_SMALL_ICON,
          pressAction: { id: 'default' },
          importance: AndroidImportance.HIGH,
          vibrationPattern: vibrationFor(prefs.vibrate, 'message'),
          sound: prefs.sound ? 'default' : undefined,
        },
      });
    } catch (e) {
      // v4.32.567: этот пустой catch и скрывал, что notifee отвергает рисунок
      // вибрации с ведущим нулём, — фоновых баннеров не было вовсе, и об этом
      // не оставалось ни строки. Показ уведомления необязателен, молчание о
      // его отказе — нет.
      log.warn('bg_notify_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  });
} catch {
  /* Firebase not linked */
}

/**
 * v4.32.558: нажатие на уведомление при свёрнутом или закрытом приложении.
 *
 * Обработчик не был зарегистрирован вовсе — ни здесь, ни где-либо ещё, — и
 * notifee на каждый запуск писал в лог, что фонового обработчика нет. Нажатие
 * в шторке разворачивало окно на той вкладке, где его оставили, и на этом всё:
 * переписка, из-за которой уведомление показали, не открывалась.
 *
 * Регистрация обязана быть здесь, вне дерева компонентов: при убитом процессе
 * событие приходит раньше, чем появляется первый компонент. Само открытие
 * переписки делает не этот обработчик — он только записывает намерение,
 * которое дождётся экрана вкладок (см. notifications/openIntent).
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const notifee = require('@notifee/react-native').default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventType } = require('@notifee/react-native');
  notifee.onBackgroundEvent(
    async ({ type, detail }: { type: number; detail: { notification?: { data?: Record<string, string> } } }) => {
      if (type !== EventType.PRESS) return;
      const intent = parseOpenIntent(detail?.notification?.data);
      if (!intent) return;
      deliverOpenIntent(intent, 'background-press');
    }
  );
} catch {
  /* notifee not linked */
}
