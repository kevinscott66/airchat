/**
 * permissionStatus — разбор ответов систем разрешений в одно состояние карточки.
 *
 * v4.32.339: до сих пор разбор был неверен в обе стороны и обе ошибки
 * заканчивались тупиком для человека.
 *
 * expo (камера, галерея, геолокация) на любой отказ отдаёт status='denied' и
 * отдельным полем canAskAgain говорит, можно ли спросить ещё раз. Поле
 * игнорировалось, и ЛЮБОЙ отказ считался «заблокировано»: одно случайное
 * «Запретить» — и разрешение больше нельзя выдать из приложения, только через
 * настройки системы.
 *
 * PermissionsAndroid (микрофон, уведомления) наоборот: у него есть отдельный
 * ответ never_ask_again, и он сваливался в обычное «отказано». Повторное
 * нажатие вызывало запрос, который система гасит молча, — карточка не менялась,
 * и человек мог нажимать бесконечно без единого признака происходящего.
 */

export type PermissionStatus = 'unknown' | 'granted' | 'denied' | 'blocked';

/** Ответ expo-модулей: expo-image-picker, expo-location и т.п. */
export interface ExpoPermissionResponse {
  status: string;
  canAskAgain?: boolean;
}

export function mapExpoPermission(res: ExpoPermissionResponse | null | undefined): PermissionStatus {
  if (!res || typeof res.status !== 'string') return 'unknown';
  if (res.status === 'granted') return 'granted';
  if (res.status === 'undetermined') return 'unknown';
  // canAskAgain отсутствует у старых версий модулей — трактуем как «спросить
  // ещё можно»: показать лишний системный диалог не страшно, а отправить
  // человека в настройки на ровном месте — тупик.
  return res.canAskAgain === false ? 'blocked' : 'denied';
}

/** Ответ PermissionsAndroid.request: granted | denied | never_ask_again. */
export function mapAndroidPermission(result: string | null | undefined): PermissionStatus {
  if (result === 'granted') return 'granted';
  if (result === 'never_ask_again') return 'blocked';
  if (result === 'denied') return 'denied';
  return 'unknown';
}

/** Нажатие по карточке: что делать дальше. */
export function permissionTapAction(status: PermissionStatus): 'none' | 'request' | 'open_settings' {
  if (status === 'granted') return 'none';
  if (status === 'blocked') return 'open_settings';
  return 'request';
}
