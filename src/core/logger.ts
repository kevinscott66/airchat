export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel: LogLevel = __DEV__ ? 'debug' : 'info';
let fileSink: ((line: string) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function setFileSink(sink: ((line: string) => void) | null): void {
  fileSink = sink;
}

function shouldLog(level: LogLevel): boolean {
  return ORDER[level] >= ORDER[minLevel];
}

/** В release без fileSink иначе нет строк в adb (ReactNativeJS) — нужны grep для e2e / двух устройств. */
function mirrorJsonToConsoleInRelease(msg: string, level: LogLevel): boolean {
  if (level !== 'info' && level !== 'warn') return false;
  if (
    msg === 'auto_test_identity' ||
    msg === 'dm_incoming_saved' ||
    msg === 'transport_success' ||
    msg === 'perf_slow' ||
    msg === 'message_sent_via_fallback'
  ) {
    return true;
  }
  if (msg.startsWith('dm_')) return true;
  if (msg.startsWith('transport_')) return true;
  if (msg.startsWith('chat_')) return true;
  if (msg.startsWith('feed_')) return true;
  // InternetTransport (ntfy.sh pub-sub) diagnostics — parallel to LAN for cross-network delivery.
  if (msg.startsWith('internet_')) return true;
  // LAN mDNS + TCP transport diagnostics (peer discovery, frame dispatch).
  if (msg.startsWith('lan_')) return true;
  // IPFS / Helia diagnostics are critical for cross-device e2e; release builds otherwise silence logger output.
  if (msg.startsWith('ipfs_')) return true;
  if (msg.startsWith('helia_')) return true;
  // JS thread lag monitoring — critical for diagnosing UI freezes in release builds
  if (msg.startsWith('js_thread_')) return true;
  // UI instrumentation (tab presses, heavy async) — v4.32.12 diagnostic
  if (msg.startsWith('ui_')) return true;
  return false;
}

function serialize(
  level: LogLevel,
  msg: string,
  meta?: Record<string, unknown>
): string {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta } : {}),
  };
  return JSON.stringify(payload);
}

function write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  // В release без файлового sink — по умолчанию тишина; маркеры автотестов дублируем в console → adb logcat.
  //
  // v4.32.362: строка собиралась ДО этой проверки, то есть у обычного
  // пользователя каждый вызов log.* платил JSON.stringify и Date().toISOString()
  // ради результата, который тут же выбрасывался. Дороже всего это выходило
  // там, где логов много и как раз в плохую минуту: детектор блокировок JS
  // сообщает о каждой задержке — то есть добавлял работы ровно тогда, когда
  // поток и без него не справлялся.
  if (!__DEV__ && !fileSink) {
    if (!mirrorJsonToConsoleInRelease(msg, level)) return;
    const g = globalThis as unknown as {
      __airchatOrigConsoleLog?: (s: string) => void;
    };
    const emit = g.__airchatOrigConsoleLog;
    if (typeof emit === 'function') emit(serialize(level, msg, meta));
    return;
  }
  const line = serialize(level, msg, meta);
  // В production не выводим в console — иначе LogBox / красная полоса; adb: file + native log.
  if (__DEV__) {
    /* eslint-disable no-console */
    switch (level) {
      case 'debug':
        console.log(line);
        break;
      case 'info':
        console.info(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'error':
        console.error(line);
        break;
      default:
        console.log(line);
    }
    /* eslint-enable no-console */
  }
  try {
    fileSink?.(line);
  } catch {
    /* never throw from logging */
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) =>
    write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) =>
    write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    write('error', msg, meta),
};

/** Логирует `perf_slow`, если асинхронная операция дольше 300 ms (цель отклика UI). */
export async function measurePerformance<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const duration = Date.now() - start;
    if (duration > 300) {
      log.warn('perf_slow', { operation: name, duration });
    }
  }
}
