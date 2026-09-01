/**
 * Детектор блокировок JS thread.
 *
 * Принцип: планируем setTimeout каждые PING_INTERVAL_MS.
 * Если он сработал с опозданием > thresholdMs — значит JS thread был занят.
 *
 * Уровни интеграции:
 *  1. Базовый: каждый блок → console.warn (default onBlock)
 *  2. Буферизация: события накапливаются и сбрасываются раз в flushIntervalMs (default 5 000 мс)
 *     для аналитики — вместо спама в лог при каждом frame drop
 *  3. Тяжёлые блоки: блоки длиннее severeThresholdMs (default 1 000 мс) немедленно попадают
 *     в onSevereBlock — подходит для интеграции Sentry / Datadog
 *
 * Использование (только в __DEV__ или staging):
 * ```ts
 * import { startJsThreadWatcher } from '../utils/jsThreadWatcher';
 *
 * const stop = startJsThreadWatcher({
 *   thresholdMs: 150,
 *   severeThresholdMs: 1000,
 *   onSevereBlock: (e) => {
 *     Sentry.captureMessage(`JS thread blocked ${e.delayMs}ms`, {
 *       level: 'warning',
 *       extra: { delayMs: e.delayMs, timestamp: e.timestamp },
 *     });
 *   },
 * });
 *
 * // При unmount / выходе:
 * stop();
 * ```
 */

const PING_INTERVAL_MS = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_SEVERE_THRESHOLD_MS = 1_000;

export type BlockEvent = {
  delayMs: number;
  timestamp: number;
};

export type FlushEvent = {
  /** Все блоки за период, включая severe */
  blocks: BlockEvent[];
  /** Суммарное заблокированное время за период (мс) */
  totalBlockedMs: number;
  /** Максимальная задержка за период */
  maxDelayMs: number;
};

export type JsThreadWatcherOptions = {
  /**
   * Порог (мс) — задержка выше этого значения фиксируется как блок.
   * Default: 200.
   */
  thresholdMs?: number;
  /**
   * Порог (мс) — блоки длиннее этого считаются «тяжёлыми» и немедленно
   * попадают в onSevereBlock. Не зависит от флаша.
   * Default: 1 000.
   */
  severeThresholdMs?: number;
  /**
   * Интервал сброса буфера в onFlush (мс).
   * Default: 5 000.
   */
  flushIntervalMs?: number;
  /**
   * Вызывается при каждом обнаруженном блоке.
   * Default: console.warn.
   */
  onBlock?: (event: BlockEvent) => void;
  /**
   * Вызывается раз в flushIntervalMs со всеми блоками за период.
   * Используйте для аналитики / агрегации метрик.
   * Не вызывается если за период не было блоков.
   */
  onFlush?: (event: FlushEvent) => void;
  /**
   * Вызывается немедленно при блоке длиннее severeThresholdMs.
   * Подключайте сюда Sentry.captureMessage / Datadog.
   */
  onSevereBlock?: (event: BlockEvent) => void;
};

/**
 * Запускает мониторинг JS thread.
 * @returns функция остановки — вызвать при unmount компонента / выходе из приложения.
 */
export function startJsThreadWatcher(options: JsThreadWatcherOptions = {}): () => void {
  const {
    thresholdMs = 200,
    severeThresholdMs = DEFAULT_SEVERE_THRESHOLD_MS,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    onBlock,
    onFlush,
    onSevereBlock,
  } = options;

  let stopped = false;
  let lastPing = Date.now();
  // v4.32.362: остановка снимала только флаг, и запланированный тик доживал
  // свои 100 мс уже после размонтирования. Само по себе это капля, но
  // держать таймер после stop() — обещание, которого функция не выполняет.
  let tickTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Уровень 2: буфер событий ─────────────────────────────────────────────
  const buffer: BlockEvent[] = [];

  const handleBlock = onBlock ?? ((e: BlockEvent) => {
    console.warn(
      `[JsThreadWatcher] Blocked ~${e.delayMs}ms at ${new Date(e.timestamp).toISOString()}`
    );
  });

  // ── Уровень 1: ping-loop ──────────────────────────────────────────────────
  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const actualDelay = now - lastPing - PING_INTERVAL_MS;

    if (actualDelay > thresholdMs) {
      const event: BlockEvent = { delayMs: actualDelay, timestamp: now };

      // Уровень 1: базовый лог
      handleBlock(event);

      // Уровень 2: буферизуем для агрегированного флаша
      if (onFlush) {
        buffer.push(event);
      }

      // Уровень 3: немедленно эскалируем тяжёлые блоки
      if (onSevereBlock && actualDelay >= severeThresholdMs) {
        onSevereBlock(event);
      }
    }

    lastPing = now;
    tickTimer = setTimeout(tick, PING_INTERVAL_MS);
  };

  tickTimer = setTimeout(tick, PING_INTERVAL_MS);

  // ── Уровень 2: периодический сброс буфера ────────────────────────────────
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  if (onFlush) {
    flushTimer = setInterval(() => {
      if (buffer.length === 0) return;

      const blocks = buffer.splice(0); // drain buffer
      const totalBlockedMs = blocks.reduce((sum, e) => sum + e.delayMs, 0);
      const maxDelayMs = blocks.reduce((max, e) => Math.max(max, e.delayMs), 0);

      onFlush({ blocks, totalBlockedMs, maxDelayMs });
    }, flushIntervalMs);
  }

  return () => {
    stopped = true;
    if (tickTimer !== null) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    // Накопленное уже никому не отдать: флаша больше не будет.
    buffer.length = 0;
  };
}
