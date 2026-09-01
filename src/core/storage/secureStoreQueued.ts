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

// v4.32.222 (Paranoid): pin every SecureStore write to
// WHEN_UNLOCKED_THIS_DEVICE_ONLY unless the caller already provided a
// keychainAccessible value. On iOS this prevents the entry from being
// restored onto another device via iCloud Keychain backup (default for
// expo-secure-store is AFTER_FIRST_UNLOCK, which IS backed up). On Android
// the flag is a no-op but centralising the default makes the intent
// explicit and blocks future regressions.
function withSafeDefaults(options?: SecureStoreOptions): SecureStoreOptions {
  if (options && options.keychainAccessible !== undefined) return options;
  return {
    ...(options ?? {}),
    keychainAccessible: ExpoSecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
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
