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

/**
 * Ответ iOS на разрешение уведомлений (v4.32.1060).
 *
 * Числа — те же, что у `messaging.AuthorizationStatus` в
 * `@react-native-firebase/messaging`; держатся здесь своими, чтобы разбор
 * ответов оставался модулем без зависимостей: его читают и тесты, и веб.
 *
 * `DENIED` — это `blocked`, а не `denied`: на iOS системный диалог показывают
 * ровно один раз за установку, и повторный запрос вернёт тот же отказ без
 * единого признака происходящего. Выдать можно только в настройках системы, и
 * карточка должна вести туда.
 *
 * `PROVISIONAL` — тихая выдача: уведомления приходят, но без баннера и звука,
 * в одну «Историю». Это не отказ и не полная выдача, то есть ровно `limited`.
 */
const PUSH_NOT_DETERMINED = -1;
const PUSH_DENIED = 0;
const PUSH_AUTHORIZED = 1;
const PUSH_PROVISIONAL = 2;
const PUSH_EPHEMERAL = 3;

export function mapPushAuthorization(status: number | null | undefined): PermissionStatus {
  if (typeof status !== 'number' || !Number.isFinite(status)) return 'unknown';
  if (status === PUSH_AUTHORIZED || status === PUSH_EPHEMERAL) return 'granted';
  if (status === PUSH_PROVISIONAL) return 'limited';
  if (status === PUSH_DENIED) return 'blocked';
  // NOT_DETERMINED — ещё не спрашивали; незнакомое число — тоже незнание.
  if (status === PUSH_NOT_DETERMINED) return 'unknown';
  return 'unknown';
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
