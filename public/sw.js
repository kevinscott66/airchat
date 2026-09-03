/**
 * Service Worker веб-версии AirChat (v4.32.560).
 *
 * Его единственная работа — показать баннер, когда вкладка закрыта. Push
 * приходит пустым: содержимое сообщения через чужой push-сервис (Google,
 * Mozilla, Apple) не проходит принципиально, и текст здесь безличный ровно
 * потому же, почему он безличный на iPhone, — сочинить его может только тот,
 * кто не умеет расшифровать сообщение.
 *
 * Что именно пришло, человек узнаёт, открыв приложение: клик по баннеру
 * поднимает уже открытую вкладку, а если её нет — открывает новую.
 *
 * Кэширования здесь нет намеренно. Оффлайн-оболочка живёт своей жизнью и
 * своими версиями; смешивать её с доставкой уведомлений — верный способ
 * однажды показать человеку страницу от прошлой сборки.
 */

'use strict';

const BANNER_TITLE = 'AirChat';
const BANNER_BODY = 'Новое сообщение — откройте приложение';
/** Один тег на все: пять баннеров подряд об одном и том же никому не нужны. */
const BANNER_TAG = 'airchat-push';

self.addEventListener('install', () => {
  // Ждать нечего — новый worker забирает страницы сразу.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Браузер отзывает разрешение у того, кто получил push и ничего не показал.
  event.waitUntil(self.registration.showNotification(BANNER_TITLE, {
    body: BANNER_BODY,
    tag: BANNER_TAG,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      // Своя же вкладка — поднимаем её, а не открываем вторую копию.
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        return client.focus();
      }
    }
    return self.clients.openWindow('/');
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Браузер сменил подписку сам. Заново подписаться отсюда нечем — ключ VAPID
  // спрашивает страница, — но старая подписка уже не работает, и сервер узнает
  // об этом с первой же попытки отправки (404/410) и забудет её.
  event.waitUntil(self.registration.showNotification(BANNER_TITLE, {
    body: 'Откройте приложение, чтобы снова получать уведомления',
    tag: BANNER_TAG,
  }));
});
