/**
 * Проверки значений, приходящих из файла резервной копии.
 *
 * Файл лежит в песочнице приложения, но подменить его через adb/restore можно,
 * а дальше эти значения идут прямо в SQLite. Проверок таких к v4.32.297
 * набралось три набора — у сообщений переписки (importRawChatMessageRows), у
 * её настроек (conversationMeta) и у групп (groupBackup), — и написаны они
 * были каждый раз заново. Длина открытого ключа, например, в одном месте
 * 43..48, а в другом «просто строка»: разъехавшись, такие копии дают дыру
 * ровно там, где её не искали.
 *
 * Модуль намеренно без зависимостей: применяет эти проверки SQLite-код,
 * который в тестах не поднять, а проверять надо именно границы.
 */

/** 2100 год — верхняя граница для меток времени из файла. */
export const TIME_MAX = 4_102_444_800_000;

/** Счётчик непрочитанных, упоминаний, просмотров: выше — признак подмены. */
export const COUNT_MAX = 1_000_000;

/**
 * Ed25519-ключ в base64. Форма одна на всё приложение — см. crypto/pubKeyFormat:
 * до v4.32.368 здесь проверялась только длина, и под неё подходила любая строка
 * из 43 символов, включая управляющие.
 */
export { isPubKeyB64 } from '../crypto/pubKeyFormat';

/** 0/1 из файла. `null` — значение не булево, строку принимать нельзя. */
export function flag(value: unknown): number | null {
  if (value === 0 || value === 1) return value;
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

/** Метка времени или её отсутствие. `undefined` — строку отбросить. */
export function optionalTime(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'number' || !isFinite(value) || value < 0 || value > TIME_MAX) return undefined;
  return Math.floor(value);
}

/** Необязательный текст в пределах длины. `undefined` — строку отбросить. */
export function optionalText(value: unknown, max: number): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value;
}

/**
 * Обязательный непустой текст. `undefined` — строку отбросить.
 *
 * Пустая строка не проходит: у группы без названия в списке чатов пустая
 * строка вместо имени, и открыть её можно только вслепую.
 */
export function requiredText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
  return value;
}

/**
 * Счётчик: отрицательного не бывает, слишком большой — обрезается.
 * `null` — строку отбросить (пришло не число).
 */
export function count(value: unknown, max: number = COUNT_MAX): number | null {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), max);
}
