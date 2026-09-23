/**
 * Общая заглушка для нативных модулей, которых в Node нет и быть не может:
 * `react-native-webrtc` (кодеки и ICE живут в нативном процессе),
 * `@notifee/react-native` (шторка уведомлений принадлежит ОС телефона),
 * `react-native-tcp-socket` и `react-native-zeroconf` (их роль — дать RN то,
 * что у Node и так есть, только через нативный мост), `react-native-wifi-p2p`
 * (радиомодуль).
 *
 * Сестра `web/shims/unavailable-native-module.ts` и работает так же, по той же
 * причине: если сюда всё-таки дошли, это ошибка маршрутизации, и она должна
 * быть громкой. Вызывающие в ядре устроены правильно — `lanTransport` и
 * `wifiMesh` выходят по `Platform.OS` раньше, чем дотянутся до модуля, — так
 * что файл существует лишь затем, чтобы esbuild было что положить в бандл.
 *
 * Отдельно про TCP и mDNS: Node умеет и то и другое, и соблазн написать здесь
 * настоящую реализацию велик. Она не нужна — LAN-транспорт на этом этапе не
 * поднимается вовсе, — а написанная «на будущее» и непроверенная, она была бы
 * ровно той заглушкой, выдающей себя за работу, которой здесь быть не должно.
 */

function refuse(api: string): never {
  throw new Error(`native_module_unavailable_on_node: ${api}`);
}

const handler: ProxyHandler<Record<string, unknown>> = {
  get(_target, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return unavailable;
    if (typeof prop === 'symbol') return undefined;
    return () => refuse(String(prop));
  },
};

const unavailable = new Proxy({}, handler);

export default unavailable;
export const createConnection = (): never => refuse('createConnection');
export const createServer = (): never => refuse('createServer');
