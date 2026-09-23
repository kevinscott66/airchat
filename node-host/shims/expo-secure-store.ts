/**
 * Node-замена `expo-secure-store`: файл + AES-256-GCM на `crypto.subtle`.
 *
 * Здесь лежит не «настройка», а самое ценное, что есть у установки: секретные
 * слова кошелька (`airchat_seed_mnemonic_enc_v2`), ключ обёртки к ним,
 * приватный ключ устройства и реестр профилей. Тот, кто прочитает этот файл,
 * получит аккаунт целиком — со всей перепиской, потому что ключ базы выводится
 * из той же фразы. Поэтому ниже подробно о том, чего эта защита стоит.
 *
 * ─── Почему нельзя было взять готовое ──────────────────────────────────────
 *
 * `secureStoreQueued.web.ts` не подходит: он на IndexedDB, которого в Node
 * нет. Нативного Keychain/Keystore тут тоже нет — их заменять нечем, и
 * притворяться, что замена равноценна, было бы враньём.
 *
 * ─── Откуда берётся ключ шифрования ────────────────────────────────────────
 *
 * Два режима, и разница между ними — не в стойкости шифра, а в том, где лежит
 * ключ относительно шифротекста.
 *
 *   1. `AIRCHAT_SECURE_STORE_KEY` — 32 байта в base64 в переменной окружения.
 *      Ключ не попадает на диск вовсе: снимок рабочего каталога, резервная
 *      копия, случайно расшаренный том — всё это уносит шифротекст без ключа.
 *      Это единственный режим, в котором шифрование здесь что-то значит, и
 *      единственный, который стоит использовать всерьёз.
 *
 *   2. Ключ в файле `secure-store.key` рядом (0600) — если переменной нет.
 *      Тогда шифрование НЕ защищает от того, кто читает каталог: ключ лежит
 *      в шаге от шифротекста. Оно даёт ровно две вещи — секретов нет в
 *      открытом виде (их не выхватит `grep -r` по диску и не покажет
 *      случайный просмотр), и копия, взявшая только `.json`, бесполезна.
 *      Настоящая граница в этом режиме — права на каталог, а не шифр. Об
 *      этом режиме процесс говорит вслух, один раз за запуск.
 *
 * Чего не умеет ни один из режимов — пережить чтение чужим процессом,
 * запущенным от того же пользователя. У Keychain и Keystore для этого есть
 * ядро ОС, у файла — нет. Это граница платформы, а не недоделка.
 *
 * ─── Как устроен файл ──────────────────────────────────────────────────────
 *
 * `{ v: 1, entries: { <имя>: { iv, ct } } }`, iv — свои 12 байт на каждую
 * запись (повтор iv при одном ключе ломает GCM целиком), ct — base64.
 * Имя записи идёт в AAD: без этого две записи можно было бы поменять
 * местами, не трогая шифротекст, — и приватный ключ устройства оказался бы
 * там, где ядро ждёт реестр профилей.
 *
 * Запись идёт через временный файл и `rename`: `rename` в пределах одной
 * файловой системы атомарен, а прямая перезапись оставила бы при обрыве
 * обрезанный файл — то есть потерю секретных слов без возможности возврата.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { makeSerialQueue } from '../runtime/serialQueue';
import { onWorkdir, workdir } from '../runtime/workdir';

export type SecureStoreOptions = {
  keychainService?: string;
  keychainAccessible?: number;
  requireAuthentication?: boolean;
};

/**
 * Уровни доступности Keychain. В Node им соответствовать нечему, но ядро
 * передаёт их в каждый вызов (см. `withSafeDefaults` в `secureStoreQueued`),
 * и имена должны существовать. Значения взяты те же, что у expo, — чтобы
 * сравнение с константой, если оно где-то появится, отвечало осмысленно.
 */
export const WHEN_UNLOCKED = 0;
export const AFTER_FIRST_UNLOCK = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 4;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 5;
export const ALWAYS_THIS_DEVICE_ONLY = 6;

type Entry = { iv: string; ct: string };
type StoreFile = { v: 1; entries: Record<string, Entry> };

let storePath: string | null = null;
let keyPath: string | null = null;

onWorkdir((root) => {
  storePath = path.join(root, 'secure-store.json');
  keyPath = path.join(root, 'secure-store.key');
});

function requirePaths(): { store: string; keyfile: string } {
  if (!storePath || !keyPath) throw new Error('secure_store_workdir_not_set');
  return { store: storePath, keyfile: keyPath };
}

let cachedKey: Promise<CryptoKey> | null = null;

/**
 * Запрет на второй режим — ключ рядом с данными.
 *
 * Включается тем, кто поднимает долгоживущий сервер (см. `mcp/main.ts`).
 * Разница с предупреждением, которое печатает `warnKeyfileMode`, не в
 * громкости: предупреждение можно не заметить в потоке вывода systemd, а
 * каталог с фразой кошелька и ключом к ней рядом уедет в первую же резервную
 * копию. Для запуска «проверить руками» файл приемлем, для сервера — нет,
 * и решает это вызывающий, а не шим: шим не знает, ради чего его завели.
 */
let envKeyRequired = false;

export function requireEnvSecureStoreKey(): void {
  envKeyRequired = true;
}

/**
 * Прочитать ключ из окружения или завести его в файле.
 *
 * Файл создаётся с `wx`: если между проверкой и записью его успел создать
 * кто-то ещё, мы не затрём чужой ключ своим — иначе все уже зашифрованные
 * записи стали бы нечитаемыми навсегда.
 */
/**
 * Ключ возвращается как `Uint8Array<ArrayBuffer>`, а не просто `Uint8Array`:
 * `crypto.subtle.importKey` принимает только буфер, который точно не
 * разделяемый, и без уточнения типа не принял бы его.
 */
async function loadRawKey(): Promise<Uint8Array<ArrayBuffer>> {
  const { keyfile } = requirePaths();
  const fromEnv = process.env.AIRCHAT_SECURE_STORE_KEY;
  if (fromEnv) {
    const bytes = new Uint8Array(Buffer.from(fromEnv, 'base64'));
    if (bytes.length !== 32) {
      throw new Error(`secure_store_env_key_bad_length: ${bytes.length}, ожидалось 32`);
    }
    return bytes;
  }
  if (envKeyRequired) {
    throw new Error(
      'secure_store_env_key_required: AIRCHAT_SECURE_STORE_KEY не задан, ' +
        'а запасной ключ в файле для этого режима запрещён'
    );
  }
  try {
    const existing = await fsp.readFile(keyfile);
    if (existing.length !== 32) throw new Error('secure_store_keyfile_bad_length');
    warnKeyfileMode();
    return new Uint8Array(existing);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  const fresh = new Uint8Array(32);
  crypto.getRandomValues(fresh);
  try {
    await fsp.writeFile(keyfile, fresh, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e;
    const raced = await fsp.readFile(keyfile);
    warnKeyfileMode();
    return new Uint8Array(raced);
  }
  warnKeyfileMode();
  return fresh;
}

let warned = false;
function warnKeyfileMode(): void {
  if (warned) return;
  warned = true;
  process.stderr.write(
    '[secure-store] ключ шифрования лежит в рабочем каталоге рядом с данными: ' +
      'защищают только права 0600 на файлы. Задайте AIRCHAT_SECURE_STORE_KEY ' +
      '(32 байта в base64), чтобы ключ не попадал на диск.\n'
  );
}

function key(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = loadRawKey().then((raw) =>
      crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    );
    // Отказ не должен застрять в кеше: следующая попытка обязана пробовать
    // заново, а не получать то же исключение из памяти.
    cachedKey.catch(() => {
      cachedKey = null;
    });
  }
  return cachedKey;
}

async function readStore(): Promise<StoreFile> {
  const { store } = requirePaths();
  try {
    const raw = await fsp.readFile(store, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as StoreFile).v !== 1 ||
      typeof (parsed as StoreFile).entries !== 'object'
    ) {
      throw new Error('secure_store_malformed');
    }
    return parsed as StoreFile;
  } catch (e) {
    // Нет файла — это «записей нет», законное состояние чистой установки.
    // Всё остальное — испорченный файл, и молчать про него нельзя: тихо
    // начав с пустого, мы перезаписали бы поверх чужие секретные слова.
    if ((e as { code?: string }).code === 'ENOENT') return { v: 1, entries: {} };
    throw e;
  }
}

async function writeStore(data: StoreFile): Promise<void> {
  const { store } = requirePaths();
  const tmp = `${store}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await fsp.rename(tmp, store);
}

/**
 * Очередь на запись. `secureStoreQueued` выстраивает вызовы ядра в цепочку,
 * но этот файл читается-меняется-пишется целиком, и любой обход очереди
 * (прямой импорт, второй потребитель) потерял бы одну из двух записей.
 */
const serial = makeSerialQueue();

export async function getItemAsync(
  itemKey: string,
  _options?: SecureStoreOptions
): Promise<string | null> {
  return serial(async () => {
    const store = await readStore();
    const entry = store.entries[itemKey];
    if (!entry) return null;
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(Buffer.from(entry.iv, 'base64')),
        additionalData: new TextEncoder().encode(itemKey),
      },
      await key(),
      new Uint8Array(Buffer.from(entry.ct, 'base64'))
    );
    return new TextDecoder().decode(plain);
  });
}

export async function setItemAsync(
  itemKey: string,
  value: string,
  _options?: SecureStoreOptions
): Promise<void> {
  return serial(async () => {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(itemKey) },
      await key(),
      new TextEncoder().encode(value)
    );
    const store = await readStore();
    store.entries[itemKey] = {
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(new Uint8Array(ct)).toString('base64'),
    };
    await writeStore(store);
  });
}

export async function deleteItemAsync(
  itemKey: string,
  _options?: SecureStoreOptions
): Promise<void> {
  return serial(async () => {
    const store = await readStore();
    if (!(itemKey in store.entries)) return;
    delete store.entries[itemKey];
    await writeStore(store);
  });
}

export async function isAvailableAsync(): Promise<boolean> {
  // Доступно, пока известен рабочий каталог: всё остальное — обычный файл.
  try {
    workdir();
    return true;
  } catch {
    return false;
  }
}

/** Синхронные варианты expo. Ядро ими не пользуется, но API их объявляет. */
export function getItem(): string | null {
  throw new Error('secure_store_sync_unsupported_on_node');
}

export function setItem(): void {
  throw new Error('secure_store_sync_unsupported_on_node');
}

export function canUseBiometricAuthentication(): boolean {
  // Ни датчика, ни человека рядом — «нет» здесь единственный честный ответ.
  return false;
}
