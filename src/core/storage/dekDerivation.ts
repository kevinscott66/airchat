import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';

const DEK_INFO = new TextEncoder().encode('airchat-local-dek-v1');

/** Детерминированный DEK из BIP39: тот же seed → тот же ключ (можно восстановить без отдельной записи в SecureStore). */
export function deriveLocalDekFromMnemonic(mnemonic: string): Uint8Array {
  const normalized = mnemonic.trim().split(/\s+/).join(' ');
  if (!validateMnemonic(normalized)) {
    throw new Error('Invalid mnemonic for DEK derivation');
  }
  const bipSeed = mnemonicToSeedSync(normalized);
  return hkdf(sha256, bipSeed, new Uint8Array(0), DEK_INFO, 32);
}

// v4.32.542: сравнение переехало в crypto/bytesEqual — модуль без импортов.
// Здесь оно тянуло за собой bip39 и noble всем, кому нужно было лишь сверить
// два массива байт. Реэкспорт оставлен: имя разошлось по вызывающим местам,
// а лишний слой тут дешевле разом переписанных импортов.
export { bytesEqualConstTime } from '../crypto/bytesEqual';
