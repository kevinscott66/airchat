/**
 * Node-замена `expo-network`.
 *
 * Ядро спрашивает отсюда ровно одно: есть ли сейчас сеть. По ответу
 * `internetTransport.canReach` решает, считать ли собеседника достижимым, а
 * `cachePolicy` — можно ли вообще писать в облако.
 *
 * Отвечать «да, всегда» было бы удобно и неверно. Вместо этого смотрим на
 * настоящий факт о машине: есть ли хоть один поднятый сетевой интерфейс,
 * кроме петлевого. Это не то же самое, что «интернет работает», — но ровно
 * то же самое обещает и `isConnected` на телефоне: там он говорит о
 * подключении к Wi-Fi или сотовой сети, а не о доступности узла на том конце.
 *
 * `isInternetReachable` — null, «неизвестно». Проверить это можно только
 * запросом наружу, а `canReach` зовут перед каждой отправкой: платить за
 * каждое сообщение лишним round-trip'ом ради уточнения, которое всё равно
 * устареет к следующей строке, не стоит.
 */
import * as os from 'node:os';

export const NetworkStateType = {
  UNKNOWN: 'UNKNOWN',
  NONE: 'NONE',
  WIFI: 'WIFI',
  CELLULAR: 'CELLULAR',
  ETHERNET: 'ETHERNET',
} as const;

export type NetworkState = {
  type: string;
  isConnected: boolean;
  isInternetReachable: boolean | null;
};

function hasExternalInterface(): boolean {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal) return true;
    }
  }
  return false;
}

export async function getNetworkStateAsync(): Promise<NetworkState> {
  const connected = hasExternalInterface();
  return {
    type: connected ? NetworkStateType.UNKNOWN : NetworkStateType.NONE,
    isConnected: connected,
    isInternetReachable: null,
  };
}

/**
 * Подписка на смену состояния сети.
 *
 * Node о таких событиях не сообщает: нативные слушатели у expo сидят на
 * Connectivity-колбэках ОС, а из процесса их не видно. Подписка принимается и
 * не срабатывает — то есть `networkReconnectWatcher` не будет догонять
 * пропущенное по событию «сеть вернулась». Его второй путь — периодическая
 * проверка — работает, и именно он здесь несёт нагрузку.
 */
export function addNetworkStateListener(
  _listener: (state: NetworkState) => void
): { remove: () => void } {
  return { remove: () => undefined };
}

export async function getIpAddressAsync(): Promise<string> {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') return a.address;
    }
  }
  return '0.0.0.0';
}

export async function isAirplaneModeEnabledAsync(): Promise<boolean> {
  return false;
}
