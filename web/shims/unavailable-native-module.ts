/**
 * Общая заглушка для нативных модулей, у которых в браузере нет и не может
 * быть аналога: сырые TCP-сокеты (`react-native-tcp-socket`), mDNS-обзор сети
 * (`react-native-zeroconf`), Wi-Fi Direct (`react-native-wifi-p2p`).
 *
 * Ни один из них не «пока не реализован» — их запрещает сама песочница
 * браузера: страница не открывает слушающий сокет, не рассылает multicast и не
 * управляет радиомодулем. Поэтому здесь не отложенная работа, а граница
 * платформы, и код выше по стеку обязан её видеть, а не получать тишину.
 *
 * Вызывающие уже устроены правильно: `lanTransport` выходит по
 * `Platform.OS === 'web'` раньше, чем дотянется до сокета, а `wifiMesh` — по
 * `Platform.OS !== 'android'`. Модуль существует только чтобы Metro было что
 * положить в веб-бандл вместо нативного кода, который туда не собирается.
 * Если сюда всё-таки дошли — это ошибка маршрутизации, и она должна быть
 * громкой.
 */

function refuse(api: string): never {
  throw new Error(`native_module_unavailable_on_web: ${api}`);
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
