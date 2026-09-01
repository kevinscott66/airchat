/**
 * asyncGuard — состояние защиты асинхронных кнопок, отделённое от React.
 *
 * v4.32.356. Логика «можно ли запускать» и «что считать завершением» жила
 * внутри хуков, в замыканиях над useRef, и поэтому не проверялась ничем: в
 * проекте нет рендерера для тестов, а значит, хук нельзя вызвать. Здесь та же
 * логика без React — её видно целиком и можно проверить по шагам.
 *
 * Ни таймеров, ни часов: время приходит аргументом. Гейт, который сам зовёт
 * Date.now(), тестируется только ожиданием реального времени.
 */

// ─── Гейт одиночной кнопки ────────────────────────────────────────────────────

/** Почему нажатие не пошло в работу. */
export type PressVerdict = 'run' | 'busy' | 'throttled';

export type PressGate = {
  /** Заявка на запуск. 'run' — гейт занят вызывающим, он обязан вызвать finish. */
  tryStart: (now: number, throttleMs: number) => PressVerdict;
  /** Работа завершена (успехом или ошибкой — гейту всё равно). */
  finish: () => void;
  /** Идёт ли работа прямо сейчас. */
  isBusy: () => boolean;
};

/**
 * Гейт различает два отказа, потому что причины у них разные: 'busy' — работа
 * ещё идёт (её результат придёт), 'throttled' — тремор или двойной тап
 * (пользователь хотел одно нажатие). Вызывающему это нужно раздельно: во
 * втором случае он уже мог что-то показать в UI и должен это отменить.
 *
 * Отсчёт throttle идёт от НАЧАЛА нажатия, а не от конца работы: долгая
 * операция и так закрыта флагом busy, добавлять к ней паузу сверху незачем.
 */
export function createPressGate(): PressGate {
  let busy = false;
  // Не 0: с нулём «первое нажатие в момент времени 0» отсеклось бы как
  // повторное. Реальные часы до нуля не доходят, тестовые — начинают с него.
  let startedAt = Number.NEGATIVE_INFINITY;

  return {
    tryStart(now: number, throttleMs: number): PressVerdict {
      if (busy) return 'busy';
      if (now - startedAt < throttleMs) return 'throttled';
      busy = true;
      startedAt = now;
      return 'run';
    },
    finish() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}

// ─── Гейт по ключу ────────────────────────────────────────────────────────────

export type KeyGate = {
  /** true — ключ занят вызывающим, он обязан вызвать finish(key). */
  tryStart: (key: string) => boolean;
  finish: (key: string) => void;
  isActive: (key: string) => boolean;
  /** Сколько ключей в работе — для проверок, что гейт не течёт. */
  activeCount: () => number;
};

/** Per-item защита: разные ключи работают параллельно, один и тот же — нет. */
export function createKeyGate(): KeyGate {
  const active = new Set<string>();

  return {
    tryStart(key: string): boolean {
      if (active.has(key)) return false;
      active.add(key);
      return true;
    },
    finish(key: string) {
      active.delete(key);
    },
    isActive(key: string) {
      return active.has(key);
    },
    activeCount() {
      return active.size;
    },
  };
}

// ─── Завершение ровно один раз ────────────────────────────────────────────────

/**
 * Запускает действие и обещает ровно один вызов `onSettled` — что бы действие
 * ни сделало.
 *
 * Зачем. Раньше было `void action().catch(...).finally(...)`, и это держалось
 * на том, что action ВСЕГДА возвращает промис. Стоит ему бросить синхронно или
 * вернуть undefined (обычная функция вместо async, ошибка в самой первой
 * строке до первого await) — и `.catch` зовётся у undefined, ошибка летит
 * наружу из обработчика нажатия, а finally не выполняется никогда. Флаг
 * занятости остаётся поднятым: кнопка мертва до конца жизни экрана, и на ней
 * навсегда крутится индикатор. Здесь оба случая — обычное завершение с ошибкой.
 */
export function runAndSettle(
  action: () => Promise<void> | void,
  onSettled: () => void,
  onError: (e: unknown) => void,
): void {
  // Сообщение об ошибке — это лог; если он сам упадёт, завершение всё равно
  // должно случиться, иначе гейт останется закрытым из-за строчки в логгере.
  const report = (e: unknown) => {
    try {
      onError(e);
    } catch {
      /* пусто намеренно */
    }
  };

  let result: Promise<void> | void;
  try {
    result = action();
  } catch (e) {
    report(e);
    onSettled();
    return;
  }
  void Promise.resolve(result).catch(report).finally(onSettled);
}
