import * as FileSystem from 'expo-file-system/legacy';
import { setFileSink } from './logger';

const FLUSH_MS = 400;
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
 * В release включается только при __DEV__ или скрытом internal diagnostics.
 */
export async function initFileLogging(): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (!base) return;
  const { isInternalDiagnosticsEnabled } = await import('./internalDiagnostics');
  const enable =
    typeof __DEV__ !== 'undefined' && __DEV__ ? true : await isInternalDiagnosticsEnabled();
  if (!enable) {
    setFileSink(null);
    logPath = null;
    return;
  }
  /** Имя файла задано только в коде; в UI не показывается. */
  logPath = `${base}airchat-app.log`;
  setFileSink((line) => {
    pending += `${line}\n`;
    scheduleFlush();
  });
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
