/**
 * base64url без опоры на имя кодировки Buffer.
 *
 * v4.32.594. `Buffer` в приложении — не тот, что в node: это пакет `buffer`
 * (6.0.3), полифилл. Кодировки `base64url` он не знает и на любое её
 * упоминание бросает `TypeError: Unknown encoding: base64url`. В node,
 * начиная с 15.7, она есть, поэтому под jest всё проходило, а на устройстве и
 * в браузере падало — и падало не там, где написано: nonce считается в начале
 * каждого подписанного запроса, так что «Активные сессии» показывали «Не
 * удалось загрузить список сессий», хотя до сервера дело не доходило вовсе.
 * Тем же способом молча терялись входящие сущности синхронизации: их
 * `entityId` разбирался в try/catch, и `Unknown encoding` читался как
 * «испорченный идентификатор».
 *
 * Алфавит тот же, что у node: обычный base64, где '+' и '/' заменены на '-' и
 * '_', а выравнивающие '=' отброшены. Сервер получает и разбирает ровно то же
 * самое, поэтому формат на проводе не меняется.
 *
 * Разбор терпим к обоим алфавитам: чужой строке (ссылка, ответ сервера) взяться
 * в обычном base64 неоткуда, но и отвергать её не за что.
 */
import { Buffer } from 'buffer';

/** Байты → base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return base64ToUrl(Buffer.from(bytes).toString('base64'));
}

/** Строка UTF-8 → base64url. */
export function utf8ToBase64Url(value: string): string {
  return base64ToUrl(Buffer.from(value, 'utf8').toString('base64'));
}

/** base64url (или обычный base64) → строка UTF-8. */
export function base64UrlToUtf8(value: string): string {
  return base64UrlToBuffer(value).toString('utf8');
}

/** base64url (или обычный base64) → байты. */
export function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(base64UrlToBuffer(value));
}

function base64ToUrl(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuffer(value: string): Buffer {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  // Полифилл, в отличие от node, не восстанавливает выравнивание сам.
  const padding = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + '='.repeat(padding), 'base64');
}
