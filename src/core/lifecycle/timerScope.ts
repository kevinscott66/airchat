/**
 * Область жизни таймеров — v4.32.505.
 *
 * Дефект, ради которого модуль появился: экран снимает свои таймеры в cleanup
 * эффекта, но таймер заводится из `.then()` асинхронного чтения. Если чтение
 * завершилось после размонтирования, `setInterval` создаётся уже ПОСЛЕ уборки —
 * снимать его больше некому, и он тикает до конца жизни процесса, дёргая
 * setState на снятом экране. Ровно это происходило с обратным отсчётом
 * медленного режима в группах: cleanup v4.32.182 чистил `slowTickRef`, а
 * восстановление отметки из kv заводило интервал секундой позже.
 *
 * Флаг `cancelled` в каждом эффекте лечит один случай из многих: его надо не
 * забыть завести, протянуть в каждый обработчик и проверить в каждой ветке.
 * Область делает то же самое структурно — после `dispose()` она просто
 * перестаёт заводить таймеры, и хост о них даже не узнаёт. Забыть проверку
 * невозможно: проверять нечего.
 *
 * Модуль без импортов: хост таймеров либо внедряется (тесты), либо берётся из
 * глобальных функций. Одноразовые таймеры снимаются с учёта ДО вызова тела —
 * иначе бросок изнутри оставил бы мёртвую запись, а `activeCount` навсегда
 * остался бы ненулевым (для App.tsx это означало бы намертво залипшую панель
 * вкладок: там непустой счётчик значит «кадр уже заказан»).
 */

export type TimerScopeHost = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Необязательны: без них `frame()` вырождается в нулевой таймаут. */
  requestAnimationFrame?: (fn: () => void) => unknown;
  cancelAnimationFrame?: (handle: unknown) => void;
};

export type TimerScope = {
  /** Область разобрана — новые таймеры больше не заводятся. */
  readonly disposed: boolean;
  /** Сколько таймеров сейчас живо. Одноразовые уходят из счёта при срабатывании. */
  readonly activeCount: number;
  timeout: (fn: () => void, ms: number) => void;
  interval: (fn: () => void, ms: number) => void;
  frame: (fn: () => void) => void;
  /** Снять все живые таймеры, область остаётся рабочей. */
  clearAll: () => void;
  /** Снять все живые таймеры и запретить заводить новые. Необратимо. */
  dispose: () => void;
};

const globalHost: TimerScopeHost = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  requestAnimationFrame:
    typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : undefined,
  cancelAnimationFrame:
    typeof cancelAnimationFrame === 'function'
      ? (handle) => cancelAnimationFrame(handle as number)
      : undefined,
};

type Entry = { handle: unknown; cancel: (handle: unknown) => void };

export function createTimerScope(host: TimerScopeHost = globalHost): TimerScope {
  const live = new Map<number, Entry>();
  let seq = 0;
  let disposed = false;

  function add(
    oneShot: boolean,
    fn: () => void,
    spawn: (fire: () => void) => unknown,
    cancel: (handle: unknown) => void,
  ): void {
    if (disposed) return;
    const key = ++seq;
    let fired = false;
    const handle = spawn(() => {
      if (oneShot) {
        fired = true;
        live.delete(key);
      }
      fn();
    });
    // `fired` покрывает хост, который выполняет колбэк синхронно (поддельные
    // таймеры в тестах): регистрировать уже отработавший таймер нельзя — он
    // остался бы в счёте навсегда.
    if (!fired) live.set(key, { handle, cancel });
  }

  function clearAll(): void {
    // Снимок до очистки: колбэк вправе позвать clearAll() или dispose() из
    // собственного тела, и повторный проход по той же карте снял бы таймеры
    // дважды.
    const entries = Array.from(live.values());
    live.clear();
    for (const entry of entries) {
      try {
        entry.cancel(entry.handle);
      } catch {
        /* хост мог забыть таймер раньше нас — это не ошибка области */
      }
    }
  }

  return {
    get disposed(): boolean {
      return disposed;
    },
    get activeCount(): number {
      return live.size;
    },
    timeout(fn: () => void, ms: number): void {
      add(true, fn, (fire) => host.setTimeout(fire, ms), host.clearTimeout);
    },
    interval(fn: () => void, ms: number): void {
      add(false, fn, (fire) => host.setInterval(fire, ms), host.clearInterval);
    },
    frame(fn: () => void): void {
      const raf = host.requestAnimationFrame;
      const caf = host.cancelAnimationFrame;
      if (raf && caf) {
        add(true, fn, (fire) => raf(fire), caf);
        return;
      }
      // Кадры на фоне не идут — там, где кадрового хоста нет вовсе, нулевой
      // таймаут это ближайшее честное приближение, и он выполняется всегда.
      add(true, fn, (fire) => host.setTimeout(fire, 0), host.clearTimeout);
    },
    clearAll,
    dispose(): void {
      disposed = true;
      clearAll();
    },
  };
}
