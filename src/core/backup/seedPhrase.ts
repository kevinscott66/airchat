/**
 * BIP39-мнемоника: PBKDF2 + XChaCha20-Poly1305 в SecureStore (`MNEMONIC_ENC_PAYLOAD_KEY`), плюс защита ОС (Keychain / Keystore).
 * SecureStore переживает обновление приложения (install -r); данные теряются при удалении приложения или `pm clear`.
 * Сообщения и outbox — в SQLite, см. `localEncryption` + `local.ts`.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import * as SecureStore from '../storage/secureStoreQueued';
import { BACKUP_TEXT_MAX } from './backupFormat';
import { generateMnemonic, validateMnemonic } from 'bip39';
import type { KeyPairBytes } from '../crypto/keyManager';
import { persistKeyPair } from '../crypto/keyManager';
import { encryptSymmetric, decryptSymmetric, SYMMETRIC_KEY_BYTES } from '../crypto/encrypt';
import { mnemonicSeedCached, clearMnemonicSeedCache } from '../crypto/mnemonicSeed';
import { kvGet, kvSet } from '../storage/local';
import { log } from '../logger';
import { hasAccountVaultSnapshot, restoreAccountVault } from '../storage/accountVault';
import { PROFILE_STATE_KEY } from '../identity/profileStateKey';

/** Plaintext mnemonic (legacy). Migrated into {@link MNEMONIC_ENC_PAYLOAD_KEY}. */
const MNEMONIC_KEY = 'airchat_seed_mnemonic_v1';
/** Even older key name — migrate if present. */
const LEGACY_SEED_KEY = 'airchat_seed';
/** PBKDF2 + XChaCha20-Poly1305 blob (JSON) — additional layer on top of SecureStore. */
const MNEMONIC_ENC_PAYLOAD_KEY = 'airchat_seed_mnemonic_enc_v2';
/**
 * v4.32.132 (AUDIT P1): random device-local 32-byte key mixed into PBKDF2 in
 * addition to the constant info. Without it the v2 payload could be decrypted
 * offline by anyone who exfiltrated SecureStore, because the "password" was a
 * compile-time constant (`LOCAL_WRAP_INFO`). v3 payloads bind to this key,
 * which itself sits under SecureStore's `WHEN_UNLOCKED_THIS_DEVICE_ONLY` tier.
 */
const LOCAL_WRAP_KEY_KEY = 'airchat_mnemonic_local_wrap_key_v3';

/**
 * Ключи SecureStore, в которых лежит сама seed-фраза или то, чем она обёрнута.
 *
 * v4.32.353: список экспортируется, чтобы сброс кошелька мог не просто вызвать
 * удаление, а ПРОВЕРИТЬ, что после него не осталось ни одного из них. Раньше
 * такой проверки не было нигде, а все удаления здесь — best-effort с молчаливым
 * catch: сбой SecureStore означал «seed на устройстве остался», и об этом никто
 * не узнавал. Единый список ещё и не даёт спискам разойтись: wipe ниже строится
 * из него же.
 */
export const SEED_SECURE_KEYS = [
  MNEMONIC_ENC_PAYLOAD_KEY,
  MNEMONIC_KEY,
  LEGACY_SEED_KEY,
  LOCAL_WRAP_KEY_KEY,
] as const;

const LOCAL_WRAP_ITERS = 100_000;
const LOCAL_WRAP_INFO = new TextEncoder().encode('airchat-mnemonic-local-wrap-v1');
let mnemonicGeneration = 0;

/** Monotonic guard for background work that must not cross wallet changes. */
export function getMnemonicGeneration(): number {
  return mnemonicGeneration;
}

export function invalidateMnemonicGeneration(): void {
  mnemonicGeneration += 1;
  clearMnemonicSeedCache();
  cachedMnemonic = null;
  inflightMnemonic = null;
}

/**
 * v4.32.542 (perf): распакованная фраза живёт до смены кошелька.
 *
 * `getStoredMnemonic()` — это чтение SecureStore (очередь `secureStoreQueued`,
 * на этих устройствах десятки секунд при холодном старте) ПЛЮС
 * PBKDF2-HMAC-SHA256 × {@link LOCAL_WRAP_ITERS} на чистом JS. Звали его на
 * каждое вложение (`mediaBlob`), на каждую резервную копию диалогов (через 4 с
 * после каждой записи в чат) и из четырёх мест экрана настроек — то есть в
 * самом горячем месте приложения. Кэш v4.32.226 в `dialogBackup` убрал оттуда
 * только bip39, а эта, более дорогая половина осталась.
 *
 * Секрета в памяти это не добавляет: расшифрованная фраза и так живёт в
 * замыканиях `App.tsx` и уходит в `syncApi` на каждый запрос. Поэтому важно
 * только одно — забывать её ровно там, где меняется кошелёк, то есть в
 * {@link invalidateMnemonicGeneration} (выход, генерация, восстановление) и в
 * конце {@link wipeMnemonicAndSessionFlags}.
 */
let cachedMnemonic: { gen: number; value: string | null } | null = null;
let inflightMnemonic: { gen: number; p: Promise<string | null> } | null = null;

type LocalMnemonicPayloadV2 = {
  v: 2;
  saltB64: string;
  blobB64: string;
  iters: number;
};

type LocalMnemonicPayloadV3 = {
  v: 3;
  saltB64: string;
  blobB64: string;
  iters: number;
};

const FIRST_LAUNCH_KEY = 'airchat_first_launch_done_v1';
const SEED_SHOWN_KEY = 'airchat_seed_shown_v1';
const BACKUP_WARN_ACK_KEY = 'airchat_backup_warn_ack_v1';
/** Session markers removed together with the wallet, and verified by the wipe. */
export const SESSION_SECURE_KEYS = [
  FIRST_LAUNCH_KEY,
  SEED_SHOWN_KEY,
  BACKUP_WARN_ACK_KEY,
] as const;
const BACKUP_KDF_ITERS = 120_000;
/** HKDF info для первого (основного) профиля — не менять, иначе сломаются существующие ключи. */
export const HKDF_INFO_PRIMARY = new TextEncoder().encode('airchat-ed25519-v1');

export async function isFirstLaunchDone(): Promise<boolean> {
  return (await SecureStore.getItemAsync(FIRST_LAUNCH_KEY)) === 'true';
}

export async function setFirstLaunchDone(): Promise<void> {
  await SecureStore.setItemAsync(FIRST_LAUNCH_KEY, 'true');
}

export async function setSeedShown(): Promise<void> {
  await SecureStore.setItemAsync(SEED_SHOWN_KEY, 'true');
}

export async function hasSeedShown(): Promise<boolean> {
  return (await SecureStore.getItemAsync(SEED_SHOWN_KEY)) === 'true';
}

export async function setBackupWarnAck(): Promise<void> {
  await SecureStore.setItemAsync(BACKUP_WARN_ACK_KEY, 'true');
}

export async function hasBackupWarnAck(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BACKUP_WARN_ACK_KEY)) === 'true';
}

/**
 * Деривация Ed25519 из BIP39 seed. Индекс 0 — совпадает с историческим `deriveKeyPairFromMnemonic`.
 * Индекс >= 1 — отдельные профили (другой HKDF info, индексы не переиспользуются после удаления профиля).
 */
export function deriveKeyPairFromMnemonicForProfile(
  mnemonic: string,
  derivationIndex: number
): KeyPairBytes {
  const normalized = mnemonic.trim().split(/\s+/).join(' ');
  if (!validateMnemonic(normalized)) {
    throw new Error('Invalid seed phrase');
  }
  if (derivationIndex < 0 || !Number.isInteger(derivationIndex)) {
    throw new Error('Invalid profile index');
  }
  const bipSeed = mnemonicSeedCached(normalized);
  const info =
    derivationIndex === 0
      ? HKDF_INFO_PRIMARY
      : new TextEncoder().encode(`airchat-ed25519-profile-v1-${derivationIndex}`);
  const secretKey = hkdf(sha256, bipSeed, new Uint8Array(0), info, 32);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

export function deriveKeyPairFromMnemonic(mnemonic: string): KeyPairBytes {
  return deriveKeyPairFromMnemonicForProfile(mnemonic, 0);
}

/**
 * v4.32.132: ensure a device-local wrap key exists in SecureStore. Returns the
 * raw 32-byte key; generates one if missing. Never leaves SecureStore except
 * in memory during encrypt/decrypt.
 */
async function ensureLocalWrapKey(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(LOCAL_WRAP_KEY_KEY);
  if (existing) {
    try {
      const buf = Buffer.from(existing, 'base64');
      if (buf.length === SYMMETRIC_KEY_BYTES) return new Uint8Array(buf);
    } catch { /* fallthrough to regenerate */ }
  }
  const fresh = randomBytes(SYMMETRIC_KEY_BYTES);
  await SecureStore.setItemAsync(LOCAL_WRAP_KEY_KEY, Buffer.from(fresh).toString('base64'));
  return fresh;
}

async function tryDecryptLocalPayload(raw: string): Promise<string | null> {
  try {
    const p = JSON.parse(raw) as LocalMnemonicPayloadV2 | LocalMnemonicPayloadV3;
    if (!p.saltB64 || !p.blobB64) return null;
    // v4.32.177: floor на iters — атакующий мог модифицировать JSON payload
    // чтобы задать iters=1 и тривиально брутфорсить пароль при последующем
    // захвате. Принимаем только iters >= LOCAL_WRAP_ITERS.
    const iters = Math.max(p.iters ?? LOCAL_WRAP_ITERS, LOCAL_WRAP_ITERS);
    const salt = new Uint8Array(Buffer.from(p.saltB64, 'base64'));
    let key: Uint8Array;
    if (p.v === 3) {
      // v3: password = device-local wrap key (binds payload to this device).
      const wrap = await ensureLocalWrapKey();
      key = pbkdf2(sha256, wrap, salt, { c: iters, dkLen: 32 });
    } else if (p.v === 2) {
      // v2 legacy: password = constant info string.
      key = pbkdf2(sha256, LOCAL_WRAP_INFO, salt, { c: iters, dkLen: 32 });
    } else {
      return null;
    }
    const blob = new Uint8Array(Buffer.from(p.blobB64, 'base64'));
    const pt = decryptSymmetric(key, blob);
    if (!pt) return null;
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Persist mnemonic with PBKDF2(device-local-key) + XChaCha20-Poly1305; removes legacy plaintext keys. */
export async function persistEncryptedMnemonic(plain: string): Promise<void> {
  const normalized = plain.trim().split(/\s+/).join(' ');
  if (!validateMnemonic(normalized)) {
    throw new Error('Invalid seed phrase');
  }
  const wrap = await ensureLocalWrapKey();
  const salt = randomBytes(16);
  const key = pbkdf2(sha256, wrap, salt, { c: LOCAL_WRAP_ITERS, dkLen: 32 });
  const ct = encryptSymmetric(key, new TextEncoder().encode(normalized));
  const payload: LocalMnemonicPayloadV3 = {
    v: 3,
    saltB64: Buffer.from(salt).toString('base64'),
    blobB64: Buffer.from(ct).toString('base64'),
    iters: LOCAL_WRAP_ITERS,
  };
  await SecureStore.setItemAsync(MNEMONIC_ENC_PAYLOAD_KEY, JSON.stringify(payload));
  await SecureStore.deleteItemAsync(MNEMONIC_KEY);
  await SecureStore.deleteItemAsync(LEGACY_SEED_KEY);
  // Запись — единственное место, где открытая фраза уже на руках: обновить кэш
  // здесь обязательно, иначе восстановление чужой фразы (invalidate → чтение
  // старой → запись новой) оставило бы в памяти предыдущий кошелёк.
  cachedMnemonic = { gen: mnemonicGeneration, value: normalized };
  inflightMnemonic = null;
  void kvSet(HAS_MNEMONIC_KV, '1').catch(() => { /* best-effort cache sync */ });
  log.info('seed_persisted_encrypted_local', { key: MNEMONIC_ENC_PAYLOAD_KEY, v: 3 });
}

/** Удалить seed и флаги онбординга из SecureStore (выход из аккаунта на этом устройстве). */
export async function wipeMnemonicAndSessionFlags(): Promise<void> {
  invalidateMnemonicGeneration();
  const keys = [
    ...SEED_SECURE_KEYS,
    ...SESSION_SECURE_KEYS,
    // v4.32.181 (Round-11 #10): FCM push token is bound to the signaling
    // identity — must go with session flags so next owner of the device does
    // not inherit the previous account's push routing.
    'airchat_fcm_token_v1',
  ];
  for (const k of keys) {
    try {
      await SecureStore.deleteItemAsync(k);
    } catch {
      /* ignore */
    }
  }
  // Keep this awaited. A detached write could reopen SQLite after the wipe
  // closed/deleted it and leave a fresh database containing only this marker.
  try {
    await kvSet(HAS_MNEMONIC_KV, '0');
  } catch {
    /* The database itself is wiped immediately afterwards. */
  }
  // Ещё раз, уже после удаления: чтение, начатое до вызова, могло положить в
  // кэш фразу, которой на устройстве больше нет.
  clearMnemonicSeedCache();
  cachedMnemonic = null;
  inflightMnemonic = null;
}

/**
 * Reads mnemonic: v2 encrypted blob, or migrates from legacy plaintext keys once.
 */
async function readOrMigrateMnemonic(): Promise<string | null> {
  const encRaw = await SecureStore.getItemAsync(MNEMONIC_ENC_PAYLOAD_KEY);
  if (encRaw) {
    const fromEnc = await tryDecryptLocalPayload(encRaw);
    if (fromEnc?.trim()) {
      const normalized = fromEnc.trim().split(/\s+/).join(' ');
      // v4.32.132: opportunistically upgrade legacy v2 blobs to v3 (device-local key).
      try {
        const p = JSON.parse(encRaw) as { v?: number };
        if (p && p.v === 2) {
          await persistEncryptedMnemonic(normalized);
          log.info('seed_local_payload_upgraded_v2_to_v3');
        }
      } catch { /* ignore, treat as v3-already */ }
      return normalized;
    }
  }

  const plain = await SecureStore.getItemAsync(MNEMONIC_KEY);
  if (plain?.trim()) {
    const normalized = plain.trim().split(/\s+/).join(' ');
    await persistEncryptedMnemonic(normalized);
    return normalized;
  }

  const legacy = await SecureStore.getItemAsync(LEGACY_SEED_KEY);
  if (legacy?.trim()) {
    const normalized = legacy.trim().split(/\s+/).join(' ');
    await persistEncryptedMnemonic(normalized);
    return normalized;
  }

  return null;
}

/** Create a new BIP39 mnemonic (24 words) and persist keys + phrase in SecureStore. */
export async function generateMnemonicAndStore(): Promise<{ mnemonic: string; pair: KeyPairBytes }> {
  invalidateMnemonicGeneration();
  const mnemonic = generateMnemonic(256);
  const pair = deriveKeyPairFromMnemonic(mnemonic);
  await SecureStore.deleteItemAsync(PROFILE_STATE_KEY);
  await persistKeyPair(pair);
  await persistEncryptedMnemonic(mnemonic);
  return { mnemonic, pair };
}

/** Restore identity from a BIP39 phrase (replaces local Ed25519 keys). */
export async function restoreFromMnemonic(mnemonic: string): Promise<KeyPairBytes> {
  invalidateMnemonicGeneration();
  const pair = deriveKeyPairFromMnemonic(mnemonic);
  const normalized = mnemonic.trim().split(/\s+/).join(' ');
  const previous = await getStoredMnemonic();
  if (!previous || previous !== normalized) {
    if (previous && !(await hasAccountVaultSnapshot(normalized))) {
      throw new Error('Сначала выйдите из текущего кошелька, затем восстановите новый.');
    }
    // Do not let the previous wallet's profile registry be reused by a new seed.
    await SecureStore.deleteItemAsync(PROFILE_STATE_KEY);
  }
  await persistKeyPair(pair);
  await persistEncryptedMnemonic(normalized);
  // The vault is local to this app installation and is keyed by the same seed.
  // A missing vault is fine: profileManager will create a fresh default profile.
  const { closeFeedStorage } = await import('../social/feedService');
  const { closeLocalDatabase } = await import('../storage/local');
  await closeFeedStorage();
  await closeLocalDatabase();
  await restoreAccountVault(normalized);
  return pair;
}

// v4.32.228 (PERF #29): cache the boolean "is a mnemonic stored" in plain kv
// (SQLite). On these devices each SecureStore/Keystore read stalls ~30s and the
// native Keystore serializes concurrent reads, so this check alone added ~30s to
// every cold boot. The flag is not a secret (it leaks nothing about the seed),
// and it only drives the backup-warn gate — never key material. Kept in sync at
// the two write sites (persist → '1', wipe → '0'); a kv miss falls back to the
// real SecureStore read and back-fills the cache (self-healing).
const HAS_MNEMONIC_KV = 'kv_has_mnemonic_v1';

async function hasStoredMnemonicUncached(): Promise<boolean> {
  const encRaw = await SecureStore.getItemAsync(MNEMONIC_ENC_PAYLOAD_KEY);
  if (encRaw && (await tryDecryptLocalPayload(encRaw))) return true;
  const m = await SecureStore.getItemAsync(MNEMONIC_KEY);
  if (m?.trim()) return true;
  const leg = await SecureStore.getItemAsync(LEGACY_SEED_KEY);
  return !!leg?.trim();
}

export async function hasStoredMnemonic(): Promise<boolean> {
  try {
    const cached = await kvGet(HAS_MNEMONIC_KV);
    if (cached === '1') return true;
    if (cached === '0') return false;
  } catch { /* kv unavailable → fall through to the slow path */ }
  const real = await hasStoredMnemonicUncached();
  void kvSet(HAS_MNEMONIC_KV, real ? '1' : '0').catch(() => { /* best-effort */ });
  return real;
}

export async function getStoredMnemonic(): Promise<string | null> {
  const gen = mnemonicGeneration;
  if (cachedMnemonic && cachedMnemonic.gen === gen) return cachedMnemonic.value;
  // Склейка параллельных вызовов: `secureStoreQueued` выполняет чтения по
  // одному, поэтому пять одновременных вложений превращались в пять
  // последовательных распаковок, а не в пять ожиданий одной.
  if (inflightMnemonic && inflightMnemonic.gen === gen) return inflightMnemonic.p;
  const p = readOrMigrateMnemonic().then(
    (value) => {
      // Кошелёк мог смениться, пока шло чтение, — тогда результат уже чужой.
      if (mnemonicGeneration === gen) cachedMnemonic = { gen, value };
      return value;
    },
    (err) => {
      if (inflightMnemonic?.p === p) inflightMnemonic = null;
      throw err;
    },
  );
  inflightMnemonic = { gen, p };
  return p;
}

type EncryptedBackupV1 = {
  v: 1;
  saltB64: string;
  blobB64: string;
  iters: number;
};

/**
 * v4.32.376: сообщения об ошибках экран показывает как есть — значит они и есть
 * текст для человека. Здесь они были по-английски посреди русского интерфейса.
 */
const BAD_BACKUP_MESSAGE = 'Это не похоже на резервную копию AirChat.';

/** Export mnemonic encrypted with a user password (PBKDF2 + XChaCha20-Poly1305). */
export async function exportEncryptedBackup(password: string): Promise<string> {
  const mnemonic = await getStoredMnemonic();
  if (!mnemonic) {
    throw new Error('На устройстве нет секретных слов — копировать нечего.');
  }
  // v4.32.134 (AUDIT P1): Unicode-normalize password so backups round-trip
  // across platforms. iOS's keyboard emits NFC for accented chars while some
  // Android IMEs emit NFD — same visible password would previously derive
  // different PBKDF2 keys, making the backup undecryptable.
  const normPwd = password.normalize('NFC');
  const salt = randomBytes(16);
  const key = pbkdf2(sha256, new TextEncoder().encode(normPwd), salt, {
    c: BACKUP_KDF_ITERS,
    dkLen: 32,
  });
  const ct = encryptSymmetric(key, new TextEncoder().encode(mnemonic));
  const payload: EncryptedBackupV1 = {
    v: 1,
    saltB64: Buffer.from(salt).toString('base64'),
    blobB64: Buffer.from(ct).toString('base64'),
    iters: BACKUP_KDF_ITERS,
  };
  return JSON.stringify(payload);
}

export async function importEncryptedBackup(encrypted: string, password: string): Promise<boolean> {
  // v4.32.205 (Round-35 #3): cap pasted backup size before JSON.parse.
  // A multi-MB paste freezes the JS thread during restore; real payloads
  // are ~200 bytes.
  if (typeof encrypted !== 'string' || encrypted.length === 0 || encrypted.length > BACKUP_TEXT_MAX) {
    throw new Error(BAD_BACKUP_MESSAGE);
  }
  // v4.32.376: разбор под защитой. Текст сюда попадает из буфера обмена, и на
  // не-JSON функция роняла наружу SyntaxError движка — «Unexpected token … in
  // JSON at position 5». Экран показывает сообщение ошибки как есть, поэтому
  // человек, вставивший не то, читал именно эту строку.
  let payload: EncryptedBackupV1;
  try {
    payload = JSON.parse(encrypted) as EncryptedBackupV1;
  } catch {
    throw new Error(BAD_BACKUP_MESSAGE);
  }
  if (!payload || typeof payload !== 'object' || payload.v !== 1 || !payload.saltB64 || !payload.blobB64) {
    throw new Error(BAD_BACKUP_MESSAGE);
  }
  const salt = new Uint8Array(Buffer.from(payload.saltB64, 'base64'));
  // v4.32.177: floor — не даём downgrade iters атакующим modified payload.
  const iters = Math.max(payload.iters ?? BACKUP_KDF_ITERS, BACKUP_KDF_ITERS);
  // v4.32.134: match exportEncryptedBackup normalization. See comment there.
  const normPwd = password.normalize('NFC');
  const key = pbkdf2(sha256, new TextEncoder().encode(normPwd), salt, {
    c: iters,
    dkLen: 32,
  });
  const blob = new Uint8Array(Buffer.from(payload.blobB64, 'base64'));
  const pt = decryptSymmetric(key, blob);
  if (!pt) {
    throw new Error('Неверный пароль или повреждённая резервная копия.');
  }
  const mnemonic = new TextDecoder().decode(pt);
  // v4.32.376: содержимое копии — тоже недоверенный ввод. Расшифровка удалась
  // значит пароль верен, но не значит, что внутри лежит фраза: копию мог
  // собрать не наш экспорт. Без этой проверки restoreFromMnemonic бросил бы
  // «Invalid seed phrase» — по-английски и посреди восстановления.
  if (!validateMnemonic(mnemonic.trim().split(/\s+/).join(' '))) {
    throw new Error('Копия расшифрована, но секретных слов в ней нет.');
  }
  await restoreFromMnemonic(mnemonic);
  return true;
}
