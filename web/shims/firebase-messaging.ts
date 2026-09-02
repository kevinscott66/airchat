/**
 * Веб-замена `@react-native-firebase/messaging`.
 *
 * FCM в браузере существует (Web Push через VAPID), но требует того, чего в
 * этой сборке нет: зарегистрированного Service Worker'а
 * (`firebase-messaging-sw.js`), VAPID-ключа пары и веб-конфига проекта. Пока
 * их нет, честный ответ — «токена не будет», а не пустая строка, которую
 * отправят на сервер как рабочую.
 *
 * `getToken()` поэтому кидает, а не возвращает `null`: вызывающий
 * (`pushNotifications`) обрабатывает исключение и просто не регистрирует
 * устройство для push. Уведомления при этом на web не пропадают — их
 * показывает `web/shims/notifee.ts`, пока вкладка открыта.
 */

type MessageHandler = (message: unknown) => void | Promise<void>;

export const AuthorizationStatus = {
  NOT_DETERMINED: -1,
  DENIED: 0,
  AUTHORIZED: 1,
  PROVISIONAL: 2,
} as const;

const instance = {
  async getToken(): Promise<string> {
    throw new Error('fcm_web_push_not_configured');
  },
  async deleteToken(): Promise<void> {
    /* токена не было — удалять нечего */
  },
  async requestPermission(): Promise<number> {
    return AuthorizationStatus.DENIED;
  },
  async hasPermission(): Promise<number> {
    return AuthorizationStatus.DENIED;
  },
  onMessage(_handler: MessageHandler): () => void {
    return () => undefined;
  },
  onTokenRefresh(_handler: (token: string) => void): () => void {
    return () => undefined;
  },
  setBackgroundMessageHandler(_handler: MessageHandler): void {
    /* нужен Service Worker; см. шапку модуля */
  },
  async getInitialNotification(): Promise<null> {
    return null;
  },
  onNotificationOpenedApp(_handler: MessageHandler): () => void {
    return () => undefined;
  },
};

function messaging(): typeof instance {
  return instance;
}

messaging.AuthorizationStatus = AuthorizationStatus;

export default messaging;
