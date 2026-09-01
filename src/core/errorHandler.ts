import { Alert } from 'react-native';
import { log } from './logger';

export enum ErrorSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  FATAL = 'fatal',
}

export interface AppError {
  code: string;
  message: string;
  severity: ErrorSeverity;
  context?: Record<string, unknown>;
  retryable: boolean;
}

let sentryInit = false;

/** Call once at startup (after loadConfig). DSN: override → EXPO_PUBLIC_SENTRY_DSN → config.sentry.dsn */
export function initSentryFromEnv(overrideDsn?: string): void {
  if (sentryInit || (typeof __DEV__ !== 'undefined' && __DEV__)) return;
  const fromEnv =
    typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SENTRY_DSN
      ? process.env.EXPO_PUBLIC_SENTRY_DSN
      : '';
  const dsn = (overrideDsn && overrideDsn.trim()) || fromEnv || '';
  if (!dsn) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/react-native') as typeof import('@sentry/react-native');
    Sentry.init({
      dsn,
      enabled: true,
      enableAutoSessionTracking: true,
    });
    sentryInit = true;
  } catch (e) {
    log.warn('sentry_init_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export class ErrorHandler {
  private static instance: ErrorHandler | undefined;
  private readonly retryQueue = new Map<
    string,
    { fn: () => Promise<unknown>; retries: number; maxRetries: number }
  >();

  /**
   * Показ ошибок — модальное окно Alert, и оно ставится в очередь системой:
   * сколько раз позвали, столько окон человек и закроет, по одному.
   *
   * v4.32.336: до сих пор ничего этому не мешало. Массовая рассылка на два
   * десятка контактов, из которых половина заблокировала отправителя, выдавала
   * десять одинаковых окон подряд — их надо было закрыть все, чтобы вернуться к
   * приложению. То же в пересылке в несколько чатов и в любой рассылке ленты.
   * Одного окна достаточно: в лог и Sentry уходит по-прежнему каждый случай.
   */
  private readonly alertVisibleCodes = new Set<string>();
  private readonly alertClosedAt = new Map<string, number>();
  private static readonly ALERT_REPEAT_WINDOW_MS = 5_000;
  private static readonly ALERT_CODES_TRACKED = 32;

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  private shouldRetry(code: string): boolean {
    return !['REACT_ERROR', 'VALIDATION', 'AUTH'].includes(code);
  }

  async handle(error: AppError, originalFn?: () => Promise<unknown>): Promise<void> {
    log.error('app_error', {
      code: error.code,
      severity: error.severity,
      message: error.message,
      context: error.context,
    });

    if (typeof __DEV__ === 'undefined' || !__DEV__) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Sentry = require('@sentry/react-native') as typeof import('@sentry/react-native');
        if (sentryInit) {
          Sentry.captureException(new Error(`${error.code}: ${error.message}`), {
            tags: { code: error.code, severity: error.severity },
            extra: error.context as Record<string, unknown> | undefined,
          });
        }
      } catch {
        /* optional */
      }
    }

    if (error.retryable && originalFn && this.shouldRetry(error.code)) {
      this.scheduleRetry(error.code, originalFn);
    }

    if (error.severity === ErrorSeverity.ERROR || error.severity === ErrorSeverity.FATAL) {
      await this.showUserAlert(error);
    }
  }

  private scheduleRetry(code: string, fn: () => Promise<unknown>): void {
    const existing = this.retryQueue.get(code);
    const retries = existing ? existing.retries + 1 : 1;
    const maxRetries = 3;
    if (retries > maxRetries) return;
    const delay = Math.pow(2, retries) * 1000;
    this.retryQueue.set(code, { fn, retries, maxRetries });
    setTimeout(() => {
      void fn().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        void this.handle(
          {
            code: `${code}_RETRY`,
            message: msg,
            severity: ErrorSeverity.WARNING,
            retryable: false,
            context: { parentCode: code },
          },
          undefined
        );
      });
    }, delay);
  }

  /**
   * Гасим только повтор той же самой ошибки: пока её окно на экране и ещё
   * несколько секунд после закрытия. Ошибка с другим кодом показывается как
   * раньше — иначе за одним отказом спрячется другой, и человек не узнает, что
   * причин было две.
   */
  private shouldCoalesceAlert(code: string, now: number): boolean {
    if (this.alertVisibleCodes.has(code)) return true;
    const closedAt = this.alertClosedAt.get(code);
    return closedAt !== undefined && now - closedAt < ErrorHandler.ALERT_REPEAT_WINDOW_MS;
  }

  /** Карта отметок не должна расти без предела: приложение живёт неделями. */
  private rememberAlertClosed(code: string, at: number): void {
    this.alertClosedAt.set(code, at);
    if (this.alertClosedAt.size <= ErrorHandler.ALERT_CODES_TRACKED) return;
    for (const [k, t] of this.alertClosedAt) {
      if (at - t >= ErrorHandler.ALERT_REPEAT_WINDOW_MS) this.alertClosedAt.delete(k);
    }
  }

  private showUserAlert(error: AppError): Promise<void> {
    const now = Date.now();
    if (this.shouldCoalesceAlert(error.code, now)) {
      log.info('app_error_alert_coalesced', { code: error.code });
      return Promise.resolve();
    }
    this.alertVisibleCodes.add(error.code);
    return new Promise((resolve) => {
      let settled = false;
      const close = (): void => {
        if (settled) return;
        settled = true;
        this.alertVisibleCodes.delete(error.code);
        // Окно тишины отсчитываем от закрытия, а не от показа: пока окно висит,
        // цикл рассылки успевает провалиться ещё двадцать раз.
        this.rememberAlertClosed(error.code, Date.now());
        resolve();
      };
      Alert.alert(
        'AirChat',
        error.message || 'Something went wrong.',
        [{ text: 'OK', onPress: close }],
        { cancelable: true, onDismiss: close }
      );
    });
  }
}
