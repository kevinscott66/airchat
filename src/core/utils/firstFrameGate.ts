/**
 * Отложить работу до первого кадра — но не навсегда (v4.32.557).
 *
 * Вся сетевая часть запуска отложена до первого отрисованного кадра: LAN и
 * интернет-транспорт, push, звонки, presence, планировщик, приём сторис,
 * очередь комментариев, уборка кэша. Смысл верный — не отнимать поток у
 * экрана, пока человек ждёт первого касания.
 *
 * Измеренный дефект. Ждали кадра через `requestAnimationFrame`, а он в React
 * Native приходит от Choreographer (Android) и CADisplayLink (iOS) — то есть
 * ровно тогда, когда есть что рисовать. У приложения в фоне кадров нет, и
 * callback не приходит вовсе. Значит запуск, случившийся не на переднем плане
 * — приложение подняли и сразу свернули, система восстановила процесс за
 * foreground-сервисом, экран погас на разблокировке, — оставлял приложение
 * живым, но глухим: транспорт не поднят, push не зарегистрирован, звонок не
 * придёт. И это не кончалось само: единственным условием была отрисовка.
 *
 * Отсюда два правила. Первое: если приложение не на переднем плане, беречь
 * нечего — кадра не будет и защищать нечего, начинать сразу. Второе: даже на
 * переднем плане у ожидания есть предел. Кадр может не прийти и там — экран
 * гаснет между монтированием и первым кадром, — поэтому рядом с кадром всегда
 * стоит срок, и первый из двух побеждает.
 *
 * Модуль без единого импорта: и кадр, и таймеры передаются снаружи, поэтому
 * правило проверяется без RN, без экрана и без ожидания в реальном времени.
 */

/** Пауза после кадра: дать экрану принять первое касание. */
export const FIRST_FRAME_SETTLE_MS = 250;

/**
 * Предел ожидания кадра. Две секунды — заметно больше любого честного первого
 * кадра и заметно меньше, чем «никогда».
 */
export const FIRST_FRAME_DEADLINE_MS = 2_000;

/** Что в итоге запустило работу. */
export type FrameTrigger =
  /** Кадр пришёл, как и задумано. */
  | 'frame'
  /** Кадра ждать было незачем: приложение не на переднем плане. */
  | 'no-frame'
  /** Кадр не пришёл в срок — работа начата всё равно. */
  | 'deadline';

/** Ждать ли кадра вообще. */
export type DeferStart = 'now' | 'after-frame';

/**
 * Стоит ли откладывать до кадра при таком состоянии приложения.
 *
 * Единственное состояние, ради которого стоит ждать, — «на переднем плане».
 * Во всех остальных (фон, переходное, неизвестное) кадра либо не будет вовсе,
 * либо его никто не увидит.
 */
export function deferStart(appState: string | null | undefined): DeferStart {
  return appState === 'active' ? 'after-frame' : 'now';
}

/** Как долго ждать после решения — до запуска работы. */
export function settleDelayMs(start: DeferStart): number {
  return start === 'after-frame' ? FIRST_FRAME_SETTLE_MS : 0;
}

/** Кадр и таймеры — снаружи: модуль не знает ни про RN, ни про глобальные функции. */
export interface FrameScheduler {
  /** Состояние приложения на момент планирования. */
  appState: string | null | undefined;
  requestFrame: (cb: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * Запланировать работу и вернуть отмену.
 *
 * Работа выполняется РОВНО один раз: что бы ни сработало первым — кадр,
 * срок или решение «кадра не будет», — остальные пути становятся пустыми.
 * Отмена тоже окончательна: после неё не запустится ничто.
 */
export function scheduleAfterFirstFrame(
  scheduler: FrameScheduler,
  run: (trigger: FrameTrigger) => void
): () => void {
  let settled = false;
  let frame: unknown = null;
  const timers: unknown[] = [];

  const fire = (trigger: FrameTrigger): void => {
    if (settled) return;
    settled = true;
    run(trigger);
  };

  const start = deferStart(scheduler.appState);
  if (start === 'now') {
    timers.push(scheduler.setTimer(() => fire('no-frame'), settleDelayMs(start)));
  } else {
    frame = scheduler.requestFrame(() => {
      if (settled) return;
      timers.push(scheduler.setTimer(() => fire('frame'), settleDelayMs(start)));
    });
  }
  // Срок стоит всегда: кадр может не прийти и на переднем плане.
  timers.push(scheduler.setTimer(() => fire('deadline'), FIRST_FRAME_DEADLINE_MS));

  return () => {
    settled = true;
    if (frame !== null) scheduler.cancelFrame(frame);
    for (const t of timers) scheduler.clearTimer(t);
    timers.length = 0;
  };
}
