/**
 * deviceLocation — единственное место, где спрашивают координаты у устройства.
 *
 * v4.32.524. Раньше запрос лежал прямо в liveLocationService: `await
 * import('expo-location')` посреди отправки, а весь блок был обёрнут в
 * try/catch с записью в журнал. Из-за этого путь отправки живой геолокации
 * нельзя было проверить ни одной проверкой: в тестовой среде динамический
 * импорт бросает (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG), исключение
 * молча уходило в тот же catch — и «сессия работает» было неотличимо от
 * «сессия не отправила ни одной посылки». Отдельный модуль даёт стык, который
 * можно подменить, не трогая ни uuid, ни профили, ни таймеры.
 *
 * Импорт остаётся отложенным намеренно: expo-location поднимает нативный
 * модуль, а до первой отправки места приложение к нему не обращается вовсе.
 */

import {
  LOCATION_FIX_TIMEOUT_MS,
  classifyLocationFailure,
  withDeadline,
  type LocationFailureKind,
} from './locationFailure';

export type DeviceCoords = { lat: number; lon: number };

/**
 * Чем кончился однократный запрос места.
 *
 * v4.32.543. Раньше этой записи не было, и каждый из трёх экранов сам решал,
 * что считать отказом: переписка не считала ничем (catch отсутствовал),
 * группа и лента сводили все причины к одной строке. Здесь причина названа
 * один раз и одинаково для всех — показывать её человеку экраны продолжают
 * сами, потому что у ленты и у переписки разные слова для одного и того же.
 */
export type LocationRead =
  | { ok: true; coords: DeviceCoords }
  | { ok: false; kind: LocationFailureKind };

/** Текущее положение с точностью «баланс» — та же, что была у прежнего вызова. */
export async function readCurrentPosition(): Promise<DeviceCoords> {
  const Location = await import('expo-location');
  // v4.32.543: срок ожидания. Без него зависший поиск спутников не сообщал о
  // себе ничем: такт живой геолокации просто не отправлял посылку и не
  // оставлял записи в журнале — «сессия идёт» было неотличимо от «сессия
  // молчит уже полчаса».
  const pos = await withDeadline(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    LOCATION_FIX_TIMEOUT_MS,
  );
  return { lat: pos.coords.latitude, lon: pos.coords.longitude };
}

/**
 * Спросить разрешение и место разом — то, что три экрана делали руками.
 *
 * Отказ здесь не бросают: у всех трёх вызывающих одна и та же развилка
 * («нет разрешения» — своё окно с объяснением, всё остальное — подсказка по
 * причине), и записанная в тип развилка не даёт её забыть так, как её забыли
 * в переписке.
 */
export async function readPlaceOnce(): Promise<LocationRead> {
  try {
    const Location = await import('expo-location');
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return { ok: false, kind: 'denied' };
    const pos = await withDeadline(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      LOCATION_FIX_TIMEOUT_MS,
    );
    return { ok: true, coords: { lat: pos.coords.latitude, lon: pos.coords.longitude } };
  } catch (e) {
    return { ok: false, kind: classifyLocationFailure(e) };
  }
}
