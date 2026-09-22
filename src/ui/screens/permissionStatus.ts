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

/**
 * `limited` — выдано частично: галерея «только выбранные фото» (iOS 14+,
 * Android 14+). Это не отказ — приложение работает, — но и не «всё выдано»:
 * расширить доступ можно только в настройках системы, повторный запрос
 * вернёт тот же ответ без диалога.
 */
export type PermissionStatus = 'unknown' | 'granted' | 'limited' | 'denied' | 'blocked';

/** Ответ expo-модулей: expo-image-picker, expo-location и т.п. */
export interface ExpoPermissionResponse {
  status: string;
  canAskAgain?: boolean;
  /** Только у галереи: 'all' | 'limited' | 'none'. */
  accessPrivileges?: string;
}

export function mapExpoPermission(res: ExpoPermissionResponse | null | undefined): PermissionStatus {
  if (!res || typeof res.status !== 'string') return 'unknown';
  if (res.status === 'granted') return res.accessPrivileges === 'limited' ? 'limited' : 'granted';
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

/**
 * Ответ PermissionsAndroid.check — только «выдано / не выдано». Отказ от
 * «ещё не спрашивали» он не отличает, поэтому «не выдано» не должно стирать
 * то, что уже известно из прошлого запроса: иначе после «Запретить» и
 * возврата из настроек карточка снова звала бы «Не запрошено».
 */
export function mergeAndroidCheck(granted: boolean, known: PermissionStatus): PermissionStatus {
  if (granted) return 'granted';
  // Было выдано, а теперь нет — отозвали в настройках. Спросить снова можно.
  if (known === 'granted' || known === 'limited') return 'unknown';
  return known;
}

/** Нажатие по карточке: что делать дальше. */
export function permissionTapAction(status: PermissionStatus): 'none' | 'request' | 'open_settings' {
  if (status === 'granted') return 'none';
  // Частичный доступ расширяется только в настройках: повторный запрос
  // молча вернёт тот же «limited», и нажатие ничего бы не сделало.
  if (status === 'blocked' || status === 'limited') return 'open_settings';
  return 'request';
}
