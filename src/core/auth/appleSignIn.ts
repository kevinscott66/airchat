/**
 * Вход через Apple ID (v4.32.595).
 *
 * Нужен ровно для одного: получить подписанный Apple id_token, по которому
 * сервер узнаёт человека и отдаёт ему его же конверт со словами. Ни имени,
 * ни почты мы не просим — они нам не нужны, а лишнее спрашивать нечестно.
 *
 * Модуль подгружается лениво: на вебе и на Android его в сборке нет, и
 * статический импорт уронил бы экран настроек ещё до первого нажатия.
 */
import { Platform } from 'react-native';
import { log } from '../logger';

export type AppleIdentity = {
  /** Подписанный Apple JWT. Сервер проверяет его сам, мы не разбираем. */
  idToken: string;
  /** Стабильный идентификатор человека внутри нашего приложения. */
  user: string;
};

type AppleAuthModule = {
  isAvailableAsync: () => Promise<boolean>;
  signInAsync: (options: { requestedScopes: unknown[] }) => Promise<{
    identityToken: string | null;
    user: string;
  }>;
};

let cached: AppleAuthModule | null = null;

async function loadModule(): Promise<AppleAuthModule | null> {
  if (Platform.OS !== 'ios') return null;
  if (cached) return cached;
  try {
    cached = (await import('expo-apple-authentication')) as unknown as AppleAuthModule;
    return cached;
  } catch (e) {
    log.warn('apple_signin_module_missing', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function isAppleSignInAvailable(): Promise<boolean> {
  const module = await loadModule();
  if (!module) return false;
  try {
    return await module.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Показать системное окно входа. `null` — человек передумал: это не ошибка и
 * ругаться на неё нельзя.
 */
export async function signInWithApple(): Promise<AppleIdentity | null> {
  const module = await loadModule();
  if (!module) throw new Error('Вход через Apple ID здесь недоступен.');
  let credential: { identityToken: string | null; user: string };
  try {
    credential = await module.signInAsync({ requestedScopes: [] });
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED') return null;
    log.warn('apple_signin_failed', { err: e instanceof Error ? e.message : String(e) });
    throw new Error('Apple не подтвердила вход.');
  }
  if (!credential.identityToken) throw new Error('Apple не вернула подтверждение входа.');
  return { idToken: credential.identityToken, user: credential.user };
}
