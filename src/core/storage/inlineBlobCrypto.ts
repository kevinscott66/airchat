/**
 * inlineBlobCrypto — шифрование байтов вложения ленты в kv.
 *
 * v4.32.341: текст поста лежит под enc2 с самого начала, а байты его картинок и
 * документов — открытым base64 в таблице kv. То есть само сообщение защищено, а
 * фотография из него достаётся из файла базы как есть, без единого ключа: и при
 * снятом бэкапе, и при доступе к файловой системе. Для ленты, где вложение чаще
 * всего и есть содержание записи, защищённой оказалась подпись под картинкой.
 *
 * Почему не enc2 и не kvSetSecret, которыми зашифрованы остальные секреты kv:
 * там строка кодируется в UTF-8 и результат снова кладётся в base64. Для
 * обычного текста это ничего не стоит, а здесь хранится уже base64 — то есть на
 * диск легло бы 1.78 байта на байт картинки вместо нынешних 1.33, и на
 * документе в 10 МБ это лишние четыре мегабайта и ещё одна копия того же
 * размера в памяти при каждом чтении. Здесь base64 сначала разбирается в байты,
 * шифруются они, и в base64 попадает уже шифртекст: размер на диске остаётся
 * прежним.
 *
 * Префикс намеренно содержит двоеточие: его нет в алфавите base64, поэтому
 * запись, сделанная до этой версии, никогда не будет принята за шифртекст, а
 * шифртекст — за неё.
 */
import { decryptSymmetric, encryptSymmetric } from '../crypto/encrypt';

export const INLINE_BLOB_PREFIX = 'encb1:';

export function isInlineBlobEncrypted(stored: string): boolean {
  return stored.startsWith(INLINE_BLOB_PREFIX);
}

/** base64 вложения → строка для kv. */
export function encodeInlineBlob(base64Plain: string, dek: Uint8Array): string {
  const raw = new Uint8Array(Buffer.from(base64Plain, 'base64'));
  const ct = encryptSymmetric(dek, raw);
  return INLINE_BLOB_PREFIX + Buffer.from(ct).toString('base64');
}

/**
 * Строка из kv → base64 вложения.
 *
 * Запись без префикса — сделанная до этой версии; отдаётся как есть, ровно как
 * это делает decryptAtRestString для enc2. Отдельная миграция не нужна: чтение
 * дошифровывает такие записи по месту (см. readInlineAttachment).
 *
 * null — «не расшифровалось». Вернуть вместо этого пустую строку значило бы
 * показать вместо фотографии пустоту и, если вызывающий на этом строит
 * перезапись, стереть её насовсем.
 */
export function decodeInlineBlob(stored: string, dek: Uint8Array): string | null {
  if (!isInlineBlobEncrypted(stored)) return stored;
  const blob = new Uint8Array(Buffer.from(stored.slice(INLINE_BLOB_PREFIX.length), 'base64'));
  const pt = decryptSymmetric(dek, blob);
  return pt ? Buffer.from(pt).toString('base64') : null;
}

/**
 * Перешифровать запись с ключа `from` на ключ `to` — для смены DEK.
 *
 * Возвращает null, если запись не расшифровалась старым ключом: тогда её надо
 * оставить нетронутой. Записать на её место что угодно другое означало бы
 * потерять вложение необратимо — после смены старого ключа уже не будет.
 */
export function reencryptInlineBlob(
  stored: string,
  from: Uint8Array,
  to: Uint8Array
): string | null {
  if (!isInlineBlobEncrypted(stored)) return null;
  const plain = decodeInlineBlob(stored, from);
  if (plain == null) return null;
  return encodeInlineBlob(plain, to);
}
