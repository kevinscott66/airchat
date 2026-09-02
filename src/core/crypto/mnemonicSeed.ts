/**
 * BIP39-seed с памятью на один кошелёк (v4.32.542).
 *
 * `mnemonicToSeedSync` — это PBKDF2-HMAC-SHA512 × 2048 на чистом JS: на Hermes
 * (без JIT) один вызов держит JS-поток ~2 с. Вызывался он на каждый запрос
 * синхронизации, на каждое вложение и на каждую операцию с облаком, то есть
 * ровно там, где приложение и «висло». Seed зависит только от самой фразы,
 * поэтому его достаточно посчитать один раз на кошелёк.
 *
 * Модуль-лист: ничего из проекта не импортирует, поэтому его одинаково видно и
 * из `backup/seedPhrase`, и из `storage/accountVault`, и из
 * `storage/dekDerivation` без циклов (та же причина, что у `bytesEqual`).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { mnemonicToSeedSync } from 'bip39';

/**
 * Ключ кэша — sha256 самой фразы, а не её длина и края: разные фразы одной
 * длины не должны выдавать чужой seed (та же осторожность, что в
 * `dialogBackup.getPrimaryWalletPubKeyB64` после v4.32.227).
 */
let cached: { fp: string; seed: Uint8Array } | null = null;

function fingerprint(normalized: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(normalized))).toString('hex').slice(0, 32);
}

/**
 * Seed для уже нормализованной (одиночные пробелы, без краевых) и проверенной
 * фразы. Возвращает общий буфер — его нельзя изменять на месте.
 */
export function mnemonicSeedCached(normalizedMnemonic: string): Uint8Array {
  const fp = fingerprint(normalizedMnemonic);
  if (cached && cached.fp === fp) return cached.seed;
  const seed = new Uint8Array(mnemonicToSeedSync(normalizedMnemonic));
  cached = { fp, seed };
  return seed;
}

/** Забыть seed: смена/сброс кошелька. Вызывается из `invalidateMnemonicGeneration`. */
export function clearMnemonicSeedCache(): void {
  cached = null;
}
