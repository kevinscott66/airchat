/**
 * Скрытый режим диагностики: не показывается в UI.
 * Включается жестом в настройках (см. SettingsScreen) — только тогда пишется файл airchat-app.log.
 * Ключ хранится в SecureStore; смысл жеста не раскрывается пользователю.
 */
import * as SecureStore from './storage/secureStoreQueued';

const KEY = 'airchat_internal_diag_v1';

let cache: boolean | null = null;

export async function isInternalDiagnosticsEnabled(): Promise<boolean> {
  if (cache !== null) return cache;
  try {
    cache = (await SecureStore.getItemAsync(KEY)) === 'true';
  } catch {
    cache = false;
  }
  return cache;
}

export async function toggleInternalDiagnostics(): Promise<boolean> {
  const next = !(await isInternalDiagnosticsEnabled());
  await SecureStore.setItemAsync(KEY, next ? 'true' : 'false');
  cache = next;
  const { reinitFileLogging } = await import('./fileLogSink');
  await reinitFileLogging();
  return next;
}
