/**
 * Режим разработчика: скрытый переключатель «показывать инженерную часть».
 *
 * Включается жестом в настройках (семь нажатий по номеру версии, см.
 * SettingsScreen) и отвечает сразу за две вещи: пишется файл airchat-app.log,
 * и в интерфейсе появляются разделы, которые обычному человеку не нужны и
 * местами опасны — адрес сервера доставки, ссылка vless://, мост для внешнего
 * агента, счётчик соединений туннеля, диагностика связи.
 *
 * Почему один флаг, а не два. Оба списка отвечают на один и тот же вопрос —
 * «этот человек разбирается в устройстве приложения и готов видеть его
 * внутренности». Два независимых переключателя для одного вопроса разошлись бы
 * при первой же правке: файл лога включён, а экран, на котором его читают,
 * скрыт.
 *
 * Ключ хранения остался прежним (`airchat_internal_diag_v1`) нарочно: модуль
 * раньше назывался internalDiagnostics, и у тех, кто уже включил режим, он
 * должен остаться включённым после обновления. Имя ключа в хранилище — это
 * совместимость, а не название модуля.
 */
import * as SecureStore from './storage/secureStoreQueued';

const KEY = 'airchat_internal_diag_v1';

let cache: boolean | null = null;

export async function isDeveloperModeEnabled(): Promise<boolean> {
  if (cache !== null) return cache;
  try {
    cache = (await SecureStore.getItemAsync(KEY)) === 'true';
  } catch {
    cache = false;
  }
  return cache;
}

/** Переключить и вернуть новое состояние: вызывающему нужно сказать о нём человеку. */
export async function toggleDeveloperMode(): Promise<boolean> {
  const next = !(await isDeveloperModeEnabled());
  await SecureStore.setItemAsync(KEY, next ? 'true' : 'false');
  cache = next;
  const { reinitFileLogging } = await import('./fileLogSink');
  await reinitFileLogging();
  return next;
}
