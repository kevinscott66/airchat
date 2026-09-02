/**
 * Веб-замена `@notifee/react-native`.
 *
 * Notifee — обёртка над Android NotificationManager и UNUserNotificationCenter;
 * в браузере ни того, ни другого нет. Зато есть Notification API, и он
 * покрывает ровно ту часть, которой пользуется приложение: показать баннер и
 * узнать, что по нему нажали. Поэтому здесь не заглушка, а перенос:
 *
 *   - `displayNotification` — настоящий баннер через `new Notification(...)`;
 *   - `onForegroundEvent` — клик по баннеру приходит тем же `EventType.PRESS`
 *     с тем же `detail.notification.data`, что и на нативе;
 *   - `createChannel` — no-op: каналы существуют только на Android;
 *   - `createTriggerNotification` — таймер в этой вкладке.
 *
 * Честные ограничения (менять их нечем, это устройство браузера):
 *   - отложенное уведомление живёт, пока жива вкладка: закрыли — не придёт.
 *     Для настоящих фоновых нужен Service Worker с Push API и серверный push,
 *     чего в этой сборке нет;
 *   - `onBackgroundEvent` не вызывается никогда по той же причине;
 *   - вибрация, звук и важность канала браузером не настраиваются и молча
 *     игнорируются.
 */

export const AndroidImportance = {
  NONE: 0,
  MIN: 1,
  LOW: 2,
  DEFAULT: 3,
  HIGH: 4,
} as const;

export const EventType = {
  UNKNOWN: -1,
  DISMISSED: 0,
  PRESS: 1,
  ACTION_PRESS: 2,
  DELIVERED: 3,
  APP_BLOCKED: 4,
  CHANNEL_BLOCKED: 5,
  CHANNEL_GROUP_BLOCKED: 6,
  TRIGGER_NOTIFICATION_CREATED: 7,
} as const;

export const TriggerType = {
  TIMESTAMP: 0,
  INTERVAL: 1,
} as const;

export const AuthorizationStatus = {
  NOT_DETERMINED: -1,
  DENIED: 0,
  AUTHORIZED: 1,
  PROVISIONAL: 2,
} as const;

type NotificationData = Record<string, string>;

type NotifeeNotification = {
  id?: string;
  title?: string;
  body?: string;
  data?: NotificationData;
  android?: Record<string, unknown>;
  ios?: Record<string, unknown>;
};

type NotifeeEvent = {
  type: number;
  detail: { notification?: NotifeeNotification };
};

type EventHandler = (event: NotifeeEvent) => void;

const foregroundHandlers = new Set<EventHandler>();

function emit(event: NotifeeEvent): void {
  for (const handler of foregroundHandlers) {
    try {
      handler(event);
    } catch {
      // Один упавший подписчик не должен глушить остальных — тот же контракт,
      // что у нативного notifee.
    }
  }
}

function canNotify(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
}

/**
 * Разрешение спрашивается лениво, при первом показе, а не на старте.
 *
 * Chrome и Safari требуют, чтобы `requestPermission` шёл из жеста
 * пользователя, и отказ запоминают навсегда. Спросить на загрузке — почти
 * гарантированно получить `denied` на весь домен.
 */
async function ensurePermission(): Promise<boolean> {
  if (!canNotify()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

async function displayNotification(notification: NotifeeNotification): Promise<string> {
  const id = notification.id ?? `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await ensurePermission())) return id;
  try {
    const banner = new Notification(notification.title ?? '', {
      body: notification.body ?? '',
      tag: id,
      data: notification.data,
    });
    banner.onclick = () => {
      window.focus();
      banner.close();
      emit({ type: EventType.PRESS, detail: { notification: { ...notification, id } } });
    };
    banner.onclose = () => {
      emit({ type: EventType.DISMISSED, detail: { notification: { ...notification, id } } });
    };
  } catch {
    // Баннер — не критичный путь: сообщение уже доставлено и лежит в чате.
  }
  return id;
}

const pendingTriggers = new Map<string, ReturnType<typeof setTimeout>>();

type Trigger = { type: number; timestamp?: number; interval?: number };

async function createTriggerNotification(
  notification: NotifeeNotification,
  trigger: Trigger
): Promise<string> {
  const id = notification.id ?? `web-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const delay = Math.max(0, (trigger.timestamp ?? Date.now()) - Date.now());
  const timer = setTimeout(() => {
    pendingTriggers.delete(id);
    void displayNotification({ ...notification, id });
  }, delay);
  pendingTriggers.set(id, timer);
  return id;
}

async function cancelNotification(id: string): Promise<void> {
  const timer = pendingTriggers.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingTriggers.delete(id);
  }
}

const notifee = {
  async createChannel(channel: { id: string }): Promise<string> {
    // Каналы — понятие Android O+. В браузере настройками баннеров владеет
    // сам браузер, приложению их не задать.
    return channel.id;
  },
  async createChannelGroup(group: { id: string }): Promise<string> {
    return group.id;
  },
  displayNotification,
  createTriggerNotification,
  cancelNotification,
  async cancelAllNotifications(): Promise<void> {
    for (const timer of pendingTriggers.values()) clearTimeout(timer);
    pendingTriggers.clear();
  },
  async getInitialNotification(): Promise<null> {
    // Холодный старт по нажатию на баннер существует только там, где баннер
    // может пережить закрытие приложения. Здесь — не может.
    return null;
  },
  async requestPermission(): Promise<{ authorizationStatus: number }> {
    const granted = await ensurePermission();
    return {
      authorizationStatus: granted ? AuthorizationStatus.AUTHORIZED : AuthorizationStatus.DENIED,
    };
  },
  onForegroundEvent(handler: EventHandler): () => void {
    foregroundHandlers.add(handler);
    return () => {
      foregroundHandlers.delete(handler);
    };
  },
  onBackgroundEvent(_handler: EventHandler): void {
    // Требует Service Worker; в этой сборке его нет. Молча ничего не делаем —
    // вызов стоит на пути загрузки и не должен ронять старт.
  },
};

export default notifee;
