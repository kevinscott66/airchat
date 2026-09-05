/**
 * Вход по Face ID / отпечатку (v4.32.595).
 *
 * Без нового нативного модуля: `expo-secure-store` умеет запирать запись
 * биометрией — чтение такой записи само поднимает системный запрос, и без
 * успешной проверки значение не отдаётся. Отдельная библиотека
 * (`expo-local-authentication`) дала бы ровно тот же системный запрос, но
 * пришлось бы решать, что делать при `success: true` и пустом хранилище: сам
 * по себе «да, это владелец» ничего не открывает. Здесь открывать нечего —
 * значение либо пришло, либо нет.
 *
 * В хранилище лежит пароль приложения, и это осознанный размен. Он лежит там
 * под замком Secure Enclave / Keystore, с доступом только на этом устройстве
 * и только после разблокировки экрана, — то есть ровно на тех же условиях, на
 * которых системные менеджеры паролей хранят всё остальное. Взамен человек
 * перестаёт набирать шесть цифр по двадцать раз в день, а значит перестаёт
 * выбирать пароль, который быстро набирается.
 *
 * Признак «включено» лежит отдельной незапертой записью. Спрашивать про это у
 * самой запертой записи нельзя: любой такой вопрос — это системный запрос
 * Face ID, и экран блокировки поднимал бы его при каждом открытии, ещё до
 * того, как человек попросил.
 */
import * as ExpoSecureStore from 'expo-secure-store';
import * as SecureStore from '../storage/secureStoreQueued';
import { log } from '../logger';

const BIOMETRIC_SECRET_KEY = 'airchat_biometric_secret_v1';
const BIOMETRIC_FLAG_KEY = 'airchat_biometric_enabled_v1';

/** Ключи, которые надо стереть вместе с паролем приложения. */
export const BIOMETRIC_SECURE_KEYS = [BIOMETRIC_SECRET_KEY, BIOMETRIC_FLAG_KEY] as const;

const SECRET_OPTIONS: ExpoSecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  keychainAccessible: ExpoSecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  authenticationPrompt: 'Разблокировать AirChat',
};

/** Есть ли на устройстве настроенная биометрия. */
export function isBiometricAvailable(): boolean {
  try {
    return typeof ExpoSecureStore.canUseBiometricAuthentication === 'function'
      && ExpoSecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(BIOMETRIC_FLAG_KEY)) === '1';
  } catch {
    return false;
  }
}

/**
 * Запомнить пароль под биометрией. Вызывать только после того, как пароль уже
 * проверен: здесь он принимается на веру и потом отдаётся как верный.
 */
export async function enableBiometricUnlock(password: string): Promise<boolean> {
  if (!password || !isBiometricAvailable()) return false;
  try {
    await SecureStore.setItemAsync(BIOMETRIC_SECRET_KEY, password, SECRET_OPTIONS);
    // Признак ставится ПОСЛЕ записи: иначе при отказе на системном запросе
    // приложение считало бы биометрию включённой, а открывать было бы нечего.
    await SecureStore.setItemAsync(BIOMETRIC_FLAG_KEY, '1');
    return true;
  } catch (e) {
    log.warn('biometric_enable_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function disableBiometricUnlock(): Promise<void> {
  // Признак снимается ПЕРВЫМ: удаление запертой записи на части устройств
  // тоже поднимает системный запрос, и отказ на нём не должен оставлять
  // приложение с включённой биометрией, которая ничего не открывает.
  try { await SecureStore.deleteItemAsync(BIOMETRIC_FLAG_KEY); } catch { /* всё равно стираем секрет */ }
  try {
    await SecureStore.deleteItemAsync(BIOMETRIC_SECRET_KEY, SECRET_OPTIONS);
  } catch (e) {
    log.warn('biometric_disable_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Поднять системный запрос и вернуть пароль. `null` — отказ, отмена или
 * биометрия не настроена; отличать эти случаи вызывающему незачем, ответ на
 * все три один: набрать пароль руками.
 */
export async function readBiometricPassword(): Promise<string | null> {
  if (!(await isBiometricUnlockEnabled())) return null;
  try {
    const value = await SecureStore.getItemAsync(BIOMETRIC_SECRET_KEY, SECRET_OPTIONS);
    return value || null;
  } catch (e) {
    log.info('biometric_read_declined', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
