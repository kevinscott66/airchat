/**
 * Node-замена `expo-location`.
 *
 * Граница платформы: приёмника GPS у серверного процесса нет, а определять
 * место по IP-адресу — это не то же самое и близко. Ядро спрашивает отсюда
 * `requestForegroundPermissionsAsync`, `getCurrentPositionAsync` и
 * `reverseGeocodeAsync` (см. `src/core/social/deviceLocation.ts`).
 *
 * Отказ выдаётся там, где вызывающий его ждёт: разрешение отвечает
 * `denied` — ровно так же, как если бы человек нажал «Запретить», и
 * `deviceLocation` уходит в написанную для этого ветку «координат нет».
 * Выдумывать координаты нельзя ни в каком виде: отправленная точка попадает
 * собеседнику в переписку как настоящее место отправителя.
 *
 * Сам запрос координат при этом бросает, а не возвращает нули: до него
 * доходит только тот, кто разрешение проигнорировал, и такой вызов — ошибка в
 * коде, а не обычное «нет данных».
 */
export const Accuracy = {
  Lowest: 1,
  Low: 2,
  Balanced: 3,
  High: 4,
  Highest: 5,
  BestForNavigation: 6,
} as const;

export const PermissionStatus = {
  GRANTED: 'granted',
  UNDETERMINED: 'undetermined',
  DENIED: 'denied',
} as const;

export async function requestForegroundPermissionsAsync(): Promise<{
  status: string;
  granted: boolean;
  canAskAgain: boolean;
}> {
  return { status: PermissionStatus.DENIED, granted: false, canAskAgain: false };
}

export const getForegroundPermissionsAsync = requestForegroundPermissionsAsync;
export const requestBackgroundPermissionsAsync = requestForegroundPermissionsAsync;

export async function getCurrentPositionAsync(): Promise<never> {
  throw new Error('location_unavailable_on_node: getCurrentPositionAsync');
}

export async function reverseGeocodeAsync(): Promise<never> {
  throw new Error('location_unavailable_on_node: reverseGeocodeAsync');
}

export async function watchPositionAsync(): Promise<never> {
  throw new Error('location_unavailable_on_node: watchPositionAsync');
}

export async function hasServicesEnabledAsync(): Promise<boolean> {
  return false;
}
