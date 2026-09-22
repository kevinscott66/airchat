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
 *     на каждую запись, случайный);
 *   - мастер-ключ заводится атомарно между вкладками и никогда не
 *     перезаписывается (см. `idbAddIfAbsent`), а нечитаемая запись — это
 *     `SecureStoreUnreadableError`, а не `null` (см. `secureStoreErrors`).
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
import { SecureStoreUnreadableError } from './secureStoreErrors';

export { SecureStoreUnreadableError, isSecureStoreUnreadable } from './secureStoreErrors';

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

/**
 * Межконтекстная блокировка создания мастер-ключа (AC-02).
 *
 * `chain` и кэш ключа ниже живут в одном экземпляре модуля, а экземпляров
 * бывает несколько: вкладки, окна, воркер. Аренда SQLite в `dbLease.ts` этот
 * API не прикрывает. Раньше `idbGet → generateKey → idbPut` шли отдельными
 * шагами, и две вкладки на пустом IndexedDB обе видели «ключа нет», обе
 * заводили свой и обе записывали: последний `put` вытеснял первый ключ, и всё,
 * что успели зашифровать первым, больше не открывалось ничем.
 *
 * Блокировка — только ускоритель: без неё проигравшая вкладка сгенерирует
 * лишний ключ и выбросит его. Правильность держит `idbAddIfAbsent` — одна
 * readwrite-транзакция с `add`, а не `put`. Где `navigator.locks` нет (старый
 * Safari, часть встраиваемых WebView) или он отказал ещё до вызова, работаем
 * без неё.
 */
const MASTER_LOCK_NAME = 'airchat-secure-store-master-v1';

async function withMasterLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') return fn();
  let entered = false;
  try {
    return await locks.request(MASTER_LOCK_NAME, { mode: 'exclusive' }, () => {
      entered = true;
      return fn();
    });
  } catch (e) {
    // Упало внутри — это ошибка самой работы, повторять её без блокировки
    // незачем. Упало до входа (SecurityError в песочнице) — идём без неё.
    if (entered) throw e;
    return fn();
  }
}

/**
 * Положить `candidate` под `key`, только если там пусто, — и вернуть то, что
 * лежит там в итоге.
 *
 * `get` и `add` — в ОДНОЙ readwrite-транзакции: IndexedDB не пускает две такие
 * транзакции на один стор одновременно, так что между «пусто» и «записал»
 * вклиниться некому. `add`, а не `put`: даже если вклинились (другая
 * реализация движка, ошибка в рассуждении выше), существующая запись не
 * перезаписывается — `add` на занятом ключе падает с ConstraintError. Её
 * гасим, чтобы транзакция не откатилась, и перечитываем победителя уже после.
 *
 * `undefined` — транзакция прошла, но победителя в ней не видно (был
 * ConstraintError): вызывающий перечитывает отдельно.
 */
function idbAddIfAbsent(store: string, key: string, candidate: unknown): Promise<unknown> {
  return openDb().then(
    (db) =>
      new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        let winner: unknown = undefined;
        const getReq = os.get(key);
        getReq.onsuccess = () => {
          if (getReq.result !== undefined) {
            winner = getReq.result;
            return;
          }
          const addReq = os.add(candidate, key);
          addReq.onsuccess = () => {
            winner = candidate;
          };
          addReq.onerror = (ev) => {
            if (addReq.error?.name === 'ConstraintError') {
              // Ключ уже есть — значит, его и надо брать. Не даём ошибке
              // оборвать транзакцию: откатывать тут нечего.
              ev.preventDefault();
              ev.stopPropagation();
            }
          };
        };
        tx.oncomplete = () => resolve(winner);
        tx.onabort = () => reject(tx.error ?? new Error('indexeddb_add_aborted'));
      })
  );
}

/**
 * Годится ли прочитанное из IndexedDB в мастер-ключи. Проверка по полям, а не
 * `instanceof CryptoKey`: объект приходит из structured clone и в тестовом
 * окружении может принадлежать другому realm.
 */
function isAesGcmKey(v: unknown): v is CryptoKey {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Partial<CryptoKey>;
  return k.type === 'secret' && k.algorithm?.name === 'AES-GCM';
}

/** Мастер-ключ есть, но негоден. Перезаписывать его нельзя: под ним данные. */
const MASTER_KEY_MALFORMED = 'secure_store_master_key_malformed';

async function readMasterKey(): Promise<CryptoKey | null> {
  const stored = await idbGet<unknown>(KEY_STORE, MASTER_KEY_ID);
  if (stored === undefined) return null;
  if (!isAesGcmKey(stored)) throw new Error(MASTER_KEY_MALFORMED);
  return stored;
}

let masterKeyPromise: Promise<CryptoKey> | null = null;

/**
 * Мастер-ключ этого происхождения.
 *
 * `create: false` — путь чтения: ключа нет — значит, `null`, и заводить его
 * ради чтения незачем (записей под ещё не существующим ключом не бывает, а
 * новый ключ старые записи всё равно не откроет). `create: true` — путь
 * записи: ключ заводится атомарно, см. `idbAddIfAbsent`. Существующий ключ
 * не перезаписывается никогда — ни здесь, ни где-либо ещё в модуле.
 */
async function masterKey(create: false): Promise<CryptoKey | null>;
async function masterKey(create: true): Promise<CryptoKey>;
async function masterKey(create: boolean): Promise<CryptoKey | null> {
  if (masterKeyPromise) return masterKeyPromise;
  if (!create) {
    const existing = await readMasterKey();
    if (existing) masterKeyPromise = Promise.resolve(existing);
    return existing;
  }
  const loading = (async () => {
    const existing = await readMasterKey();
    if (existing) return existing;
    return withMasterLock(async () => {
      // Под блокировкой — ещё раз: пока ждали, ключ мог завести сосед.
      const again = await readMasterKey();
      if (again) return again;
      // generateKey асинхронен и в живой транзакции IndexedDB не выполнить:
      // транзакция закоммитится сама, пока ждём. Поэтому ключ — заранее, а
      // транзакция — только на «проверить и положить».
      const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      const winner = (await idbAddIfAbsent(KEY_STORE, MASTER_KEY_ID, fresh)) ?? (await readMasterKey());
      if (winner === null) throw new Error('secure_store_master_key_race');
      if (!isAesGcmKey(winner)) throw new Error(MASTER_KEY_MALFORMED);
      return winner;
    });
  })();
  loading.catch(() => {
    masterKeyPromise = null;
  });
  masterKeyPromise = loading;
  return loading;
}

type StoredEntry = { iv: ArrayBuffer; data: ArrayBuffer };

/**
 * `instanceof ArrayBuffer` здесь не годится: буфер из structured clone или из
 * WebCrypto может прийти из другого realm (iframe, тестовое окружение), и
 * тогда целая запись сочлась бы порченой.
 */
function isArrayBuffer(v: unknown): v is ArrayBuffer {
  return Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

function isStoredEntry(v: unknown): v is StoredEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<StoredEntry>;
  return isArrayBuffer(e.iv) && e.iv.byteLength === IV_BYTES && isArrayBuffer(e.data);
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

/**
 * `null` — только «записи нет». Запись, которая есть, но не открылась (не тот
 * формат, чужой или пропавший мастер-ключ, порча шифротекста), — это
 * `SecureStoreUnreadableError`, как и у нативного expo-secure-store, который
 * на сбросе Keystore бросает, а не молчит. Шифротекст при этом остаётся
 * лежать как есть: вдруг починится, а решать, стирать ли, — вызывающему.
 */
export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null> {
  return enqueue(async () => {
    if (!hasBackend()) return null;
    const stored = await idbGet<unknown>(STORE, namespaced(key, options));
    // IndexedDB отвечает `undefined` ровно на отсутствие ключа; `null` сюда
    // setItemAsync не пишет, значит, и он — чужая, порченая запись.
    if (stored === undefined) return null;
    if (!isStoredEntry(stored)) throw new SecureStoreUnreadableError(key, 'malformed');
    let mk: CryptoKey | null;
    try {
      mk = await masterKey(false);
    } catch (e) {
      if (e instanceof Error && e.message === MASTER_KEY_MALFORMED) {
        throw new SecureStoreUnreadableError(key, 'master_key_unusable');
      }
      // Отказ самого IndexedDB — не про эту запись; отдаём как есть.
      throw e;
    }
    if (!mk) throw new SecureStoreUnreadableError(key, 'master_key_unusable');
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(stored.iv) }, mk, stored.data);
    } catch {
      // Ключ пересоздан (данные сайта чистили частично) или шифротекст
      // испорчен. Раньше здесь был `null`, то есть «записи нет», — и на него
      // вызывающие заводили новую личность поверх старой.
      throw new SecureStoreUnreadableError(key, 'decrypt_failed');
    }
    return new TextDecoder().decode(plain);
  });
}

export function setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void> {
  return enqueue(async () => {
    if (!hasBackend()) throw new Error('secure_store_unavailable_on_this_browser');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await masterKey(true),
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
