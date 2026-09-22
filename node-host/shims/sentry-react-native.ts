/**
 * Node-замена `@sentry/react-native`.
 *
 * Настоящий пакет тянет за собой половину React Native (обработчик native
 * crash, перехват касаний, виджет обратной связи) — в Node это не собирается
 * и не нужно. Ядро берёт из него ровно два имени: `init` и
 * `captureException`, см. `src/core/errorHandler.ts`.
 *
 * Отправлять отчёты отсюда было бы неправильно, даже если бы удалось.
 * Headless-экземпляр поднимается для проверок; его исключения в общем проекте
 * Sentry смешались бы с отчётами с настоящих телефонов, и разобрать, где чей
 * сбой, стало бы невозможно. Поэтому отчёты остаются на машине — но не
 * пропадают: `captureException` печатает исключение в stderr целиком, вместе
 * со стеком. Тихо проглоченное исключение было бы хуже отсутствующей
 * телеметрии.
 *
 * `init` при этом честно говорит, что DSN проигнорирован: если кто-то задал
 * `EXPO_PUBLIC_SENTRY_DSN` и ждёт отчётов на сервере, он должен узнать, что их
 * не будет, а не выяснять это по пустому проекту.
 */
export function init(options?: { dsn?: string }): void {
  const dsn = options?.dsn ?? '';
  process.stderr.write(
    `[sentry] отчёты в Node не отправляются, DSN проигнорирован${dsn ? ` (${dsn.slice(0, 24)}…)` : ''}\n`
  );
}

export function captureException(error: unknown, hint?: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[sentry:exception] ${text}\n`);
  if (hint !== undefined) {
    process.stderr.write(`[sentry:hint] ${JSON.stringify(hint)}\n`);
  }
}

export function captureMessage(message: string): void {
  process.stderr.write(`[sentry:message] ${message}\n`);
}

export function setUser(): void {
  /* Личность отчёта не с чем связывать: отчёты никуда не уходят. */
}

export default { init, captureException, captureMessage, setUser };
