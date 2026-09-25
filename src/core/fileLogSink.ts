import * as FileSystem from 'expo-file-system/legacy';
import { setFileSink } from './logger';

const FLUSH_MS = 400;
/** Имя файла задано только здесь; в UI оно не показывается. */
const LOG_FILE_NAME = 'airchat-app.log';
const MAX_FILE_BYTES = 1_500_000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pending = '';
let logPath: string | null = null;

async function flushToDisk(): Promise<void> {
  if (!logPath || !pending) return;
  const chunk = pending;
  pending = '';
  try {
    const info = await FileSystem.getInfoAsync(logPath);
    let prev = '';
    if (info.exists && info.size) {
      if (info.size > MAX_FILE_BYTES) {
        await FileSystem.writeAsStringAsync(logPath, chunk);
        return;
      }
      prev = await FileSystem.readAsStringAsync(logPath);
    }
    await FileSystem.writeAsStringAsync(logPath, prev + chunk);
  } catch {
    /* ignore */
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushToDisk();
  }, FLUSH_MS);
}

/**
 * Пишет JSON-строки логов в файл в documentDirectory (без показа в LogBox).
 * В release включается только при __DEV__ или скрытом режиме разработчика.
 */
export async function initFileLogging(): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (!base) return;
  const { isDeveloperModeEnabled } = await import('./developerMode');
  const enable =
    typeof __DEV__ !== 'undefined' && __DEV__ ? true : await isDeveloperModeEnabled();
  if (!enable) {
    setFileSink(null);
    logPath = null;
    return;
  }
  logPath = `${base}${LOG_FILE_NAME}`;
  setFileSink((line) => {
    pending += `${line}\n`;
    scheduleFlush();
  });
}

/**
 * Убрать журнал приложения с диска совсем (v4.32.924).
 *
 * Зовут это со сброса кошелька. Файл переживал «удалить данные на устройстве»
 * целиком: в нём лежат DID собеседников, номера сообщений, состояние молчания
 * и времена сетевых путей — то есть кто с кем и когда переписывался. Строку
 * переписки сброс уносил, а эту опись — нет.
 *
 * Путь берётся из каталога, а не из `logPath`: тот заполнен, только пока
 * диагностика включена в ЭТОМ запуске. Файл же остаётся от прошлого — включали
 * диагностику когда-то, потом приложение перезапустили, и `initFileLogging`
 * никто больше не звал. Смотреть на `logPath` значило бы чаще всего не найти
 * ничего и уйти с чистой совестью.
 */
export async function deleteAppLogFile(): Promise<void> {
  pending = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  setFileSink(null);
  logPath = null;
  const base = FileSystem.documentDirectory;
  if (!base) return;
  await FileSystem.deleteAsync(`${base}${LOG_FILE_NAME}`, { idempotent: true });
}

/** После переключения скрытой диагностики — пересоздать sink. */
export async function reinitFileLogging(): Promise<void> {
  pending = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  setFileSink(null);
  // v4.32.223 (Paranoid): when diagnostics get disabled, the in-memory
  // sink is detached but the airchat-app.log file remained on disk with
  // all accumulated events (DIDs, message ids, mute state, network path
  // timings). Delete it so the "disable diagnostics" toggle actually
  // removes the forensic artefact.
  if (logPath) {
    try {
      const info = await FileSystem.getInfoAsync(logPath);
      if (info.exists) {
        await FileSystem.deleteAsync(logPath, { idempotent: true });
      }
    } catch {
      /* best-effort */
    }
  }
  logPath = null;
  await initFileLogging();
}
