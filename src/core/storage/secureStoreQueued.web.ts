/**
 * Веб-реализация secureStoreQueued.
 *
 * `expo-secure-store` на web — пустышка (`ExpoSecureStore.web.js` экспортирует
 * `{}`), поэтому Keychain/Keystore здесь заменяются на связку WebCrypto +
 * IndexedDB:
 *
 *   - мастер-ключ AES-GCM создаётся один раз через `crypto.subtle.generateKey`
 *     с `extractable: false` и кладётся в IndexedDB как объект `CryptoKey`;
 *   - браузер хранит его материал вне JS-кучи, `exportKey` на нём кидает —
 *     то есть XSS может ключом *пользоваться*, но не может его выкачать;
 *   - значения лежат в том же IndexedDB зашифрованными (12-байтовый nonce
 *     на каждую запись, случайный).
 *
 * Это слабее аппаратного Keystore (нет привязки к разблокировке устройства и
 * к железу), и обещать здесь эквивалент нативного нельзя. Поэтому
 * `isAvailableAsync()` отвечает `true` только там, где есть и IndexedDB, и
 * `crypto.subtle` (последний — лишь в secure context: https или localhost).
 *
 * Сериализация вызовов сохранена: web-код ходит сюда из тех же мест (boot,
 * SQLite, profileManager), а IndexedDB-транзакции на одном сторе так же плохо
 * переносят чересполосицу read/write.
 */
import type { SecureStoreOptions } from 'expo-secure-store';

const DB_NAME = 'airchat-secure-store';
const DB_VERSION = 1;
const STORE = 'entries';
const KEY_STORE = 'master';
const MASTER_KEY_ID = 'aes-gcm-v1';
const IV_BYTES = 12;

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(() => fn());
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function hasBackend(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined'
  );
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb_open_failed'));
  });
  // Провалившийся open не должен залипнуть навсегда: следующий вызов пробует заново.
  opening.catch(() => {
    dbPromise = null;
  });
  dbPromise = opening;
  return opening;
}

function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error ?? new Error('indexeddb_get_failed'));
      })
  );
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexeddb_put_failed'));
      })
  );
}

function idbDelete(store: string, key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexeddb_delete_failed'));
      })
  );
}

let masterKeyPromise: Promise<CryptoKey> | null = null;

async function masterKey(): Promise<CryptoKey> {
  if (masterKeyPromise) return masterKeyPromise;
  const loading = (async () => {
    const existing = await idbGet<CryptoKey>(KEY_STORE, MASTER_KEY_ID);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await idbPut(KEY_STORE, MASTER_KEY_ID, key);
    return key;
  })();
  loading.catch(() => {
    masterKeyPromise = null;
  });
  masterKeyPromise = loading;
  return loading;
}

type StoredEntry = { iv: ArrayBuffer; data: ArrayBuffer };

function isStoredEntry(v: unknown): v is StoredEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<StoredEntry>;
  return e.iv instanceof ArrayBuffer && e.data instanceof ArrayBuffer;
}

/**
 * `keychainService` из опций — единственная часть `SecureStoreOptions`, которая
 * на web имеет смысл: она разводит пространства имён так же, как на iOS. Всё
 * остальное (`keychainAccessible`, `requireAuthentication`) в браузере нечем
 * обеспечить и молча игнорируется — обещать здесь нативные гарантии нельзя.
 */
function namespaced(key: string, options?: SecureStoreOptions): string {
  const service = options?.keychainService;
  return service ? `${service} ${key}` : key;
}

export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null> {
  return enqueue(async () => {
    if (!hasBackend()) return null;
    const stored = await idbGet<unknown>(STORE, namespaced(key, options));
    if (!isStoredEntry(stored)) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(stored.iv) },
        await masterKey(),
        stored.data
      );
      return new TextDecoder().decode(plain);
    } catch {
      // Ключ пересоздан (данные сайта чистили частично) — запись нечитаема.
      // Это не «нет значения по ошибке», а именно отсутствие: тот же контракт,
      // что у нативного SecureStore после сброса Keystore.
      return null;
    }
  });
}

export function setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void> {
  return enqueue(async () => {
    if (!hasBackend()) throw new Error('secure_store_unavailable_on_this_browser');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await masterKey(),
      new TextEncoder().encode(value)
    );
    const entry: StoredEntry = { iv: iv.buffer.slice(0) as ArrayBuffer, data };
    await idbPut(STORE, namespaced(key, options), entry);
  });
}

export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void> {
  return enqueue(async () => {
    if (!hasBackend()) return;
    await idbDelete(STORE, namespaced(key, options));
  });
}

export function isAvailableAsync(): Promise<boolean> {
  return enqueue(async () => hasBackend());
}

// Значения совпадают с числовыми константами expo-secure-store, чтобы код,
// который их прокидывает в опции, типизировался и вёл себя одинаково.
export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
