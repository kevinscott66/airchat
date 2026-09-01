import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import * as SecureStore from '../storage/secureStoreQueued';
import { log } from '../logger';
import { encryptSymmetric, decryptSymmetric } from './encrypt';
import { getOrCreateDataEncryptionKey } from '../storage/localEncryption';
import { bytesEqualConstTime } from '../storage/dekDerivation';
import { isEd25519PublicKey } from './pubKeyFormat';
import {
  classifyKeyRecord,
  mayMintNewIdentity,
  KEY_STORE_UNREADABLE_TEXT,
  type KeyRecordState,
} from './keyRecordState';

/**
 * Ed25519: секретный ключ (seed) — тоже 32 байта.
 *
 * v4.32.427. Число совпадает с длиной открытого ключа и с длиной
 * симметричного, и раньше все три стояли в коде голым литералом `32`. Имя
 * здесь нужно не ради числа, а ради вопроса «какой ключ»: `pt.length !== 32`
 * не отличает расшифрованный секрет от чужого открытого ключа, а
 * `ED25519_SECRET_KEY_BYTES` отличает.
 */
export const ED25519_SECRET_KEY_BYTES = 32;

const SK_KEY = 'airchat_ed25519_secret';
const PK_KEY = 'airchat_ed25519_public';
/** Секретный ключ в SecureStore: ciphertext (тот же DEK, что и для SQLite). */
const SK_ENC_PREFIX = 'encsk1:';

/**
 * Ключи SecureStore, в которых лежит подписывающая пара устройства.
 *
 * v4.32.353: экспортируется ради проверки после сброса кошелька —
 * deleteKeyPairFromStore глотает ошибки удаления, поэтому «вызвали» и «удалено»
 * здесь не одно и то же.
 */
export const KEYPAIR_SECURE_KEYS = [SK_KEY, PK_KEY] as const;

export type KeyPairBytes = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

/** Прочитанная запись ключей: что там лежит и годится ли это к работе. */
export type KeyRecordRead =
  | { state: 'ok' | 'repairable'; pair: KeyPairBytes }
  | { state: 'absent' | 'orphan-public' | 'unreadable'; pair: null };

/**
 * Ключ на устройстве есть, но прочитать его не вышло.
 *
 * Отдельный тип нужен, чтобы загрузка приложения могла отличить это от
 * любого другого сбоя и НЕ завести новую личность поверх старой.
 */
export class KeyStoreUnreadableError extends Error {
  readonly state: KeyRecordState;
  constructor(state: KeyRecordState) {
    super(KEY_STORE_UNREADABLE_TEXT);
    this.name = 'KeyStoreUnreadableError';
    this.state = state;
  }
}

export async function generateKeyPair(): Promise<KeyPairBytes> {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

/**
 * Записать пару в SecureStore.
 *
 * Секрет пишется первым намеренно: записи две, а операция одна, и между ними
 * помещается и падение процесса, и отказ хранилища. При таком порядке недописанная
 * пара — это НОВЫЙ секрет со СТАРЫМ открытым ключом, а секрет самодостаточен:
 * открытый ключ из него выводится. Обратный порядок оставил бы старый секрет с
 * новым ключом — и восстановить по такой паре было бы нечего. Разбирает этот
 * случай loadKeyPair.
 */
export async function persistKeyPair(pair: KeyPairBytes): Promise<void> {
  const dek = await getOrCreateDataEncryptionKey();
  const ct = encryptSymmetric(dek, pair.secretKey);
  const wrapped = SK_ENC_PREFIX + Buffer.from(ct).toString('base64');
  const encPk = Buffer.from(pair.publicKey).toString('base64');
  await SecureStore.setItemAsync(SK_KEY, wrapped);
  await SecureStore.setItemAsync(PK_KEY, encPk);
}

/** Перешифровать секретный ключ при смене DEK (миграция random → deterministic). */
export async function rewrapSecretKeyWithDek(oldDek: Uint8Array, newDek: Uint8Array): Promise<void> {
  const encSk = await SecureStore.getItemAsync(SK_KEY);
  if (!encSk?.startsWith(SK_ENC_PREFIX)) return;
  const blob = new Uint8Array(Buffer.from(encSk.slice(SK_ENC_PREFIX.length), 'base64'));
  const rawSk = decryptSymmetric(oldDek, blob);
  if (!rawSk || rawSk.length !== ED25519_SECRET_KEY_BYTES) return;
  const ct = encryptSymmetric(newDek, rawSk);
  await SecureStore.setItemAsync(SK_KEY, SK_ENC_PREFIX + Buffer.from(ct).toString('base64'));
}

/** Удалить ключи из SecureStore (выход из аккаунта / сброс кошелька). */
export async function deleteKeyPairFromStore(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SK_KEY);
  } catch {
    /* ignore */
  }
  try {
    await SecureStore.deleteItemAsync(PK_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Прочитать запись ключей и СКАЗАТЬ, что именно там лежит.
 *
 * v4.32.547. Прежде здесь был один `loadKeyPair`, отвечавший `null` и на
 * «ключей нет», и на «ключи есть, но не читаются». Вызывающий их не различал,
 * а `ensureKeyPair` на `null` заводил новую личность и записывал её поверх
 * старой — то есть отказ ЧТЕНИЯ превращался в необратимую ЗАПИСЬ. Разбор
 * состояний вынесен в keyRecordState, здесь остаётся только сбор фактов.
 */
export async function readKeyRecord(): Promise<KeyRecordRead> {
  let hasSecret = false;
  let hasPublic = false;
  let secretKey: Uint8Array | null = null;
  let publicKey: Uint8Array | null = null;
  let plaintextLegacy = false;
  try {
    const encSk = await SecureStore.getItemAsync(SK_KEY);
    const encPk = await SecureStore.getItemAsync(PK_KEY);
    hasSecret = !!encSk;
    hasPublic = !!encPk;
    if (encPk) {
      // v4.32.427: открытый ключ проверяется наравне с секретным. Раньше
      // проверка стояла только на секретном, а открытый брался из хранилища
      // как есть — и порченая запись доезжала до кривой, где падала с
      // английским «"point" expected Uint8Array of length 32».
      const parsed = new Uint8Array(Buffer.from(encPk, 'base64'));
      if (isEd25519PublicKey(parsed)) publicKey = parsed;
      else log.warn('key_load_bad_public_key', { bytes: parsed.length });
    }
    if (encSk) {
      if (encSk.startsWith(SK_ENC_PREFIX)) {
        const dek = await getOrCreateDataEncryptionKey();
        const blob = new Uint8Array(Buffer.from(encSk.slice(SK_ENC_PREFIX.length), 'base64'));
        const pt = decryptSymmetric(dek, blob);
        if (pt && pt.length === ED25519_SECRET_KEY_BYTES) secretKey = pt;
        else log.warn('key_load_bad_wrapped_secret', { bytes: pt ? pt.length : -1 });
      } else {
        // v4.32.489: запись, сделанная до шифрования секрета, проверяется на
        // длину наравне с расшифрованной. Раньше не проверялась — и порченая
        // запись не просто доезжала до кривой, а тут же ПЕРЕШИФРОВЫВАЛАСЬ:
        // поправимый мусор становился непоправимым.
        const raw = new Uint8Array(Buffer.from(encSk, 'base64'));
        if (raw.length === ED25519_SECRET_KEY_BYTES) {
          secretKey = raw;
          plaintextLegacy = true;
        } else {
          log.warn('key_load_bad_legacy_secret', { bytes: raw.length });
        }
      }
    }
  } catch (e) {
    // Хранилище ключей отказало — это не «ключей нет». На Android Keystore
    // так отвечает, пока устройство не разблокировали после перезагрузки.
    log.warn('key_load_failed', { err: e instanceof Error ? e.message : String(e) });
    return { state: 'unreadable', pair: null };
  }

  let derived: Uint8Array | null = null;
  if (secretKey) {
    try {
      derived = ed25519.getPublicKey(secretKey);
    } catch (e) {
      log.warn('key_load_derive_failed', { err: e instanceof Error ? e.message : String(e) });
      derived = null;
    }
  }
  if (!secretKey || !derived) {
    const bad = classifyKeyRecord({ hasSecret, hasPublic, secretUsable: false, publicMatches: false });
    return { state: bad === 'absent' || bad === 'orphan-public' ? bad : 'unreadable', pair: null };
  }

  // v4.32.489: секрет и открытый ключ — две записи SecureStore, которые
  // переключение аккаунта переписывает по очереди. Падение между ними
  // оставляет секрет одного профиля рядом с открытым ключом другого — и тогда
  // приложение ПОДПИСЫВАЕТ одним, а представляется другим. Собеседники молча
  // отбрасывают такие подписи как поддельные: отправка «уходит» и не доходит
  // никогда. Секрет главнее: открытый ключ выводится из него, а не наоборот.
  const publicMatches = !!publicKey && bytesEqualConstTime(derived, publicKey);
  const state = classifyKeyRecord({ hasSecret: true, hasPublic, secretUsable: true, publicMatches });
  if (state === 'repairable') {
    log.warn('key_load_public_key_repaired', {
      stored: publicKey ? Buffer.from(publicKey).toString('base64').slice(0, 8) : 'none',
      derived: Buffer.from(derived).toString('base64').slice(0, 8),
    });
  }
  const pair: KeyPairBytes = { secretKey, publicKey: publicMatches && publicKey ? publicKey : derived };
  if (plaintextLegacy || state === 'repairable') {
    try {
      await persistKeyPair(pair);
    } catch (e) {
      // Починку не удалось записать — но прочитанная пара рабочая, и отдать
      // её честнее, чем вернуть «ключей нет» и остаться без личности.
      log.warn('key_repair_persist_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
  return { state: state === 'repairable' ? 'repairable' : 'ok', pair };
}

/**
 * Пара ключей устройства или `null`, если её не удалось получить.
 *
 * Тонкая обёртка над readKeyRecord: девять мест зовут её ради самой пары и
 * одинаково обходятся с `null`. Тем, кто ПИШЕТ поверх (ensureKeyPair), нужен
 * readKeyRecord — им разница между «нет» и «не читается» стоит личности.
 */
export async function loadKeyPair(): Promise<KeyPairBytes | null> {
  const read = await readKeyRecord();
  return read.pair;
}

export async function ensureKeyPair(): Promise<KeyPairBytes> {
  const read = await readKeyRecord();
  if (read.pair) return read.pair;
  if (!mayMintNewIdentity(read.state)) {
    // v4.32.547: здесь стоял `generateKeyPair()` + `persistKeyPair()`. На
    // нечитаемой записи это молча стирало Ed25519-личность устройства: адрес
    // терялся навсегда, а собеседники видели вместо человека незнакомца.
    log.error('key_store_unreadable_refusing_mint', { state: read.state });
    throw new KeyStoreUnreadableError(read.state);
  }
  const pair = await generateKeyPair();
  await persistKeyPair(pair);
  return pair;
}

/** ECDH (X25519) using Ed25519 keys: Montgomery form per Curve25519. */
export function ecdhSharedSecret(
  ourSecretEd25519: Uint8Array,
  theirPublicEd25519: Uint8Array
): Uint8Array {
  const sk = ed25519.utils.toMontgomerySecret(ourSecretEd25519);
  const pk = ed25519.utils.toMontgomery(theirPublicEd25519);
  return x25519.getSharedSecret(sk, pk);
}

// v4.32.377: publicKeyFingerprint (первые 8 байт ключа в hex) убран — короткая
// форма ключа для человека берётся из did/шестнадцатеричного отпечатка в
// профиле, а эту функцию не вызывал никто.

/** 4-байтовый хэш открытого ключа (FNV-1a) для идентификации отправителя. */
export function publicKeyHash4(pub: Uint8Array): Uint8Array {
  let h = 2166136261;
  for (const b of pub) {
    h ^= b;
    h = (Math.imul(h, 16777619) >>> 0);
  }
  return new Uint8Array([h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]);
}
