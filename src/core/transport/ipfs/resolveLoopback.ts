import { Platform } from 'react-native';

/** Эмулятор vs физика: `expo-constants` больше не экспортирует `isDevice` в этой версии SDK. */
function isAndroidEmulator(): boolean {
  if (Platform.OS !== 'android') return false;
  const c = Platform.constants as { Fingerprint?: string; Model?: string };
  const fp = (c.Fingerprint ?? '').toLowerCase();
  const model = (c.Model ?? '').toLowerCase();
  if (fp.includes('generic') || fp.includes('google_sdk') || fp.includes('emulator')) return true;
  if (model.includes('sdk') || model.includes('emulator') || model === 'google_sdk') return true;
  return false;
}

/**
 * На Android-эмуляторе 127.0.0.1 / localhost указывают на сам эмулятор, а не на машину разработчика.
 * Для доступа к Kubo/Gateway на хосте используется 10.0.2.2 (специальный alias эмулятора).
 * На физическом устройстве оставляем 127.0.0.1 — доступ к хосту через `adb reverse tcp:5001 tcp:5001` (и 8080 для gateway).
 */
export function resolveIpfsLoopbackForAndroid(url: string): string {
  if (Platform.OS !== 'android') return url;
  if (!isAndroidEmulator()) {
    return url;
  }
  try {
    const u = new URL(url);
    // v4.32.206 (Round-36 #2): defensive scheme allowlist. If a misconfigured
    // apiUrl/gatewayUrls contains `file://` or similar, leave as-is for the
    // downstream fetch to reject rather than silently rewriting its hostname.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      u.hostname = '10.0.2.2';
      return u.href;
    }
  } catch {
    return url;
  }
  return url;
}
