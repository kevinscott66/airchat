/**
 * Веб-замена `@react-native-firebase/messaging`.
 *
 * v4.32.560: это больше не заглушка, а перенос. У браузера фоновая доставка
 * есть и не требует ничьих сертификатов: Service Worker + Push API + подпись
 * VAPID. Установленная как PWA страница получает уведомление, даже когда
 * вкладка закрыта, — то есть ровно то, чего нет в сборке IPA без платного
 * Apple Developer Program.
 *
 * Никакого Firebase здесь нет и не нужно: push принимает наш собственный
 * сигналинг, а «токен» — это JSON подписки, как его отдаёт браузер. Он уходит
 * на сервер тем же подписанным `/register-token`, что и токен устройства, с
 * platform: 'web' (см. notifications/pushNotifications).
 *
 * Уведомление приходит ПУСТЫМ. Содержимое push проходит через чужой сервис
 * (Google, Mozilla, Apple), и единственный способ ничего ему не сообщить — не
 * посылать ничего. Баннер показывает Service Worker (public/sw.js) общими
 * словами, а что именно пришло, страница выясняет сама, когда её откроют.
 *
 * Что по-прежнему невозможно и потому осталось пустым:
 *   - `onMessage`: в push нет ни одного байта, который стоило бы передать
 *     открытой странице. Открытая страница и так держит сокет сигналинга —
 *     сообщение приезжает по нему, а не через push;
 *   - `setBackgroundMessageHandler`: фоновый показ живёт в Service Worker'е;
 *   - `getInitialNotification` / `onNotificationOpenedApp`: клик по баннеру
 *     Service Worker обрабатывает сам — открывает или поднимает вкладку, и
 *     передать вместе с ней ему нечего.
 */

import { loadConfig } from '../../src/core/config';

type MessageHandler = (message: unknown) => void | Promise<void>;

export const AuthorizationStatus = {
  NOT_DETERMINED: -1,
  DENIED: 0,
  AUTHORIZED: 1,
  PROVISIONAL: 2,
} as const;

/** Адрес Service Worker'а. Лежит в public/ и попадает в корень экспорта. */
const SERVICE_WORKER_URL = '/sw.js';
/** Сколько ждать сервер за ключом VAPID: без ключа подписаться всё равно нечем. */
const KEY_FETCH_TIMEOUT_MS = 10_000;

function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window;
}

/**
 * Ключ VAPID приходит с сервера в base64url, а `subscribe` ждёт байты.
 * Ключ открытый по определению — он и нужен браузеру, чтобы отличить наши
 * push от чужих.
 */
function applicationServerKey(base64url: string): ArrayBuffer {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (base64url.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function fetchVapidKey(): Promise<string> {
  const cfg = await loadConfig();
  const base = cfg.webrtc?.signalingUrl;
  if (!base) throw new Error('webpush_no_signaling_url');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KEY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/webpush-key`, { signal: ctrl.signal });
    // 404 — у сервера не заданы ключи VAPID: web-push там просто выключен.
    if (!res.ok) throw new Error(`webpush_key_unavailable_${res.status}`);
    const body: unknown = await res.json();
    const key = (body as { key?: unknown })?.key;
    if (typeof key !== 'string' || key.length === 0) throw new Error('webpush_key_malformed');
    return key;
  } finally {
    clearTimeout(timer);
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

const instance = {
  /**
   * Подписка браузера в том виде, как её отдаёт `PushSubscription.toJSON()`.
   * Кидает, а не возвращает пустую строку: вызывающий ловит исключение и
   * просто не регистрирует устройство для push, а пустую строку он отправил бы
   * на сервер как рабочий токен.
   */
  async getToken(): Promise<string> {
    if (!pushSupported()) throw new Error('webpush_unsupported');
    // Подписаться без разрешения нельзя, и просить его повторно здесь незачем:
    // разрешение спрашивает requestPermission ниже, до первого getToken.
    if (Notification.permission !== 'granted') throw new Error('webpush_permission_denied');
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      // Обязательно true: браузер не даёт подписки тому, кто обещает молчать.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(await fetchVapidKey()),
    });
    return JSON.stringify(subscription.toJSON());
  },
  async deleteToken(): Promise<void> {
    if (!pushSupported()) return;
    const subscription = await currentSubscription();
    await subscription?.unsubscribe();
  },
  async requestPermission(): Promise<number> {
    if (!pushSupported()) return AuthorizationStatus.DENIED;
    const outcome = await Notification.requestPermission();
    return outcome === 'granted' ? AuthorizationStatus.AUTHORIZED : AuthorizationStatus.DENIED;
  },
  async hasPermission(): Promise<number> {
    if (!pushSupported()) return AuthorizationStatus.DENIED;
    if (Notification.permission === 'granted') return AuthorizationStatus.AUTHORIZED;
    if (Notification.permission === 'denied') return AuthorizationStatus.DENIED;
    return AuthorizationStatus.NOT_DETERMINED;
  },
  onMessage(_handler: MessageHandler): () => void {
    // В push нет содержимого; см. шапку модуля.
    return () => undefined;
  },
  onTokenRefresh(_handler: (token: string) => void): () => void {
    // Браузер не обновляет подписку сам: она меняется только вместе с
    // разрешением или при `pushsubscriptionchange`, и тогда страницу открывают
    // заново — а при открытии токен регистрируется в любом случае.
    return () => undefined;
  },
  setBackgroundMessageHandler(_handler: MessageHandler): void {
    /* фоновый показ — в public/sw.js */
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
