/**
 * Node-замена `@react-native-firebase/messaging` (и `…/app`).
 *
 * Push здесь невозможен по существу, а не по недостатку кода: токен FCM
 * выдаёт сервис Google Play или APNs конкретному установленному приложению, и
 * серверный процесс такого токена не получает ни при каких условиях. Показать
 * уведомление тоже нечем — шторка принадлежит телефону (`@notifee/react-native`
 * отсутствует по той же причине).
 *
 * Отказ громкий, как у `unavailable-native-module`: вызывающие в
 * `src/notifications/pushNotifications.ts` берут модуль через `require(...)`
 * внутри try/catch и переходят на свою ветку «push недоступен». Отдать им
 * пустышку, которая молча отвечает «токена нет», значило бы выдать за работу
 * тишину: экземпляр считался бы подписанным на уведомления, которые ему
 * никогда не придут.
 *
 * Настоящий пакет заодно не собирается: он импортирует
 * `react-native/Libraries/...` — исходники на Flow, esbuild их не разбирает.
 */
function refuse(api: string): never {
  throw new Error(`firebase_messaging_unavailable_on_node: ${api}`);
}

const messaging = new Proxy(() => refuse('messaging()'), {
  get(_target, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return messaging;
    if (typeof prop === 'symbol') return undefined;
    return () => refuse(String(prop));
  },
  apply() {
    return refuse('messaging()');
  },
});

export default messaging;
export const firebase = messaging;
