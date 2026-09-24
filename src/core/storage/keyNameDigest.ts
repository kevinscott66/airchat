/**
 * Имя ключа, не называющее того, о ком запись (v4.32.813).
 *
 * Столбцы `k` и `v` таблицы `kv` лежат открытыми — шифруется содержимое
 * переписки, а не структура базы (см. localEncryption). Пока в имени ключа
 * стоял открытый ключ собеседника, файл базы сам по себе выдавал граф связей:
 * с кем человек переписывается и когда каждый из них последний раз был в
 * сети. Именно от чтения этого файла без доступа к Keychain и защищает всё
 * остальное шифрование — то есть имя ключа отменяло работу значения.
 *
 * Дайджест берётся HMAC-ом на ключе, выведенном из DEK. Простого sha256 мало:
 * открытых ключей в сети конечное число, и по списку кандидатов дайджест
 * подбирается перебором. HMAC на секрете, лежащем в Keychain, такой перебор
 * закрывает — у того, кто унёс один лишь файл базы, ключа нет.
 *
 * Дайджест односторонний, и перечислить по нему собеседников нельзя. Это не
 * потеря: presence и так читается по заранее известному списку, а не сканом.
 *
 * Смена DEK (восстановление из секретных слов) меняет и дайджесты: прежние
 * строки остаются лежать мусором. Это дёшево — в них лежит одно число, время;
 * и это правильнее обратного размена, при котором имя ключа переживало бы
 * смену ключа к данным.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { bytesEqualConstTime } from '../crypto/bytesEqual';
import { getOrCreateDataEncryptionKey } from './localEncryption';

const KEY_NAME_INFO = new TextEncoder().encode('airchat-kv-key-name-v1');

/** Длина шестнадцатеричного дайджеста в имени ключа. */
export const KEY_NAME_DIGEST_HEX = 32;

/** Похоже ли окончание ключа на дайджест, а не на открытый ключ собеседника. */
export function looksLikeKeyNameDigest(suffix: string): boolean {
  return suffix.length === KEY_NAME_DIGEST_HEX && /^[0-9a-f]+$/.test(suffix);
}

let cachedDek: Uint8Array | null = null;
let cachedNameKey: Uint8Array | null = null;

/**
 * Ключ для имён — отдельная ветка от DEK, а не сам DEK.
 *
 * Тем же ключом шифруются данные; пускать его ещё и в дайджесты значит
 * связывать две задачи там, где HKDF разводит их бесплатно.
 */
async function keyNameKey(): Promise<Uint8Array> {
  const dek = await getOrCreateDataEncryptionKey();
  if (cachedNameKey && cachedDek && bytesEqualConstTime(cachedDek, dek)) return cachedNameKey;
  const derived = hkdf(sha256, dek, new Uint8Array(0), KEY_NAME_INFO, 32);
  cachedDek = dek;
  cachedNameKey = derived;
  return derived;
}

/**
 * Дайджест значения для подстановки в имя ключа.
 *
 * Бросает, если ключ к данным недоступен: подставить вместо дайджеста само
 * значение было бы возвратом ровно к той записи, от которой уходим.
 */
export async function keyNameDigest(value: string): Promise<string> {
  const key = await keyNameKey();
  const mac = hmac(sha256, key, new TextEncoder().encode(value));
  return Buffer.from(mac).toString('hex').slice(0, KEY_NAME_DIGEST_HEX);
}

/** Забыть выведенный ключ — после смены DEK. */
export function resetKeyNameDigestCache(): void {
  cachedDek = null;
  cachedNameKey = null;
}
