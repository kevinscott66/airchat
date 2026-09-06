/**
 * Серийная очередь для expo-secure-store. На Android Keystore плохо переносит параллельные
 * get/set из boot, SQLite и profileManager — возможны долгие зависания без ошибки.
 */
import * as ExpoSecureStore from 'expo-secure-store';
import type { SecureStoreOptions } from 'expo-secure-store';

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(() => fn());
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// v4.32.222 (Paranoid): каждая запись закрепляется за этим устройством,
// если вызывающий не указал доступность сам. На iOS это не даёт записи
// уехать на чужой телефон через восстановление связки ключей из iCloud
// (умолчание expo-secure-store — AFTER_FIRST_UNLOCK, а оно в копию входит).
// На Android флаг ничего не делает, но общее умолчание в одном месте
// закрывает путь к откату.
//
// v4.32.613: ...THIS_DEVICE_ONLY остаётся — именно он и был причиной правки
// v4.32.222, — а вот WHEN_UNLOCKED заменён на AFTER_FIRST_UNLOCK.
// WHEN_UNLOCKED значит «читать можно только на разблокированном телефоне», и
// iOS поднимает приложение раньше разблокировки чаще, чем кажется: переход по
// ссылке из другого приложения, запуск по уведомлению, прогрев. Первое же
// чтение падало с errSecInteractionNotAllowed, и запуск упирался в красный
// экран на ровном месте. AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY закрыт до первой
// разблокировки после включения телефона и так же не попадает в копию iCloud.
//
// Важно: у уже созданных записей доступность этим не меняется. Нативный
// модуль на существующем ключе идёт в SecItemUpdate и обновляет только
// значение (SecureStoreModule.swift, ветка errSecDuplicateItem), а
// пересоздавать записи с ключами ради атрибута нельзя: между удалением и
// вставкой помещается смерть процесса, и секрет пропадёт навсегда. Поэтому
// новое умолчание работает для новых установок, а тем, у кого записи уже
// лежат, помогает повтор запуска (см. `keychainLocked` и `App.tsx`).
function withSafeDefaults(options?: SecureStoreOptions): SecureStoreOptions {
  if (options && options.keychainAccessible !== undefined) return options;
  return {
    ...(options ?? {}),
    keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  };
}

export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null> {
  return enqueue(() => ExpoSecureStore.getItemAsync(key, options));
}

export function setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void> {
  return enqueue(() => ExpoSecureStore.setItemAsync(key, value, withSafeDefaults(options)));
}

export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void> {
  return enqueue(() => ExpoSecureStore.deleteItemAsync(key, options));
}

export function isAvailableAsync(): Promise<boolean> {
  return enqueue(() => ExpoSecureStore.isAvailableAsync());
}

export {
  AFTER_FIRST_UNLOCK,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  ALWAYS,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  ALWAYS_THIS_DEVICE_ONLY,
  WHEN_UNLOCKED,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} from 'expo-secure-store';
