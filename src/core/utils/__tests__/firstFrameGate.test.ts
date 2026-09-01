/**
 * v4.32.557. Запуск, случившийся не на переднем плане, не начинался никогда.
 *
 * Вся сетевая часть входа отложена до первого кадра: LAN и интернет-транспорт,
 * push, звонки, presence, планировщик, приём сторис, очередь комментариев.
 * Ждали через `requestAnimationFrame` — а он приходит от Choreographer и
 * CADisplayLink, то есть только когда есть что рисовать. В фоне кадров нет:
 * приложение оставалось живым, но глухим, и само это не проходило.
 *
 * Здесь проверяется, что кадр перестал быть единственным условием: в фоне
 * работа начинается сразу, на переднем плане у ожидания есть срок, а
 * выполняется она ровно один раз, кто бы ни сработал первым.
 */
import fs from 'fs';
import path from 'path';
import {
  FIRST_FRAME_DEADLINE_MS,
  FIRST_FRAME_SETTLE_MS,
  deferStart,
  scheduleAfterFirstFrame,
  settleDelayMs,
  type FrameScheduler,
  type FrameTrigger,
} from '../firstFrameGate';

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const MODULE = (): string => read('../firstFrameGate.ts');
const APP = (): string => read('../../../App.tsx');

/** Ручной планировщик: кадр и таймеры срабатывают только тогда, когда велят. */
function harness(appState: string | null | undefined) {
  const frames: Array<() => void> = [];
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const cancelledFrames: unknown[] = [];
  const clearedTimers: unknown[] = [];
  const scheduler: FrameScheduler = {
    appState,
    requestFrame: (cb) => {
      frames.push(cb);
      return `frame-${frames.length}`;
    },
    cancelFrame: (h) => {
      cancelledFrames.push(h);
    },
    setTimer: (cb, ms) => {
      const id = next++;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimer: (h) => {
      clearedTimers.push(h);
      timers.delete(h as number);
    },
  };
  return {
    scheduler,
    frames,
    cancelledFrames,
    clearedTimers,
    /** Сработать всеми таймерами с указанной задержкой. */
    fireTimers(ms: number): void {
      for (const [id, t] of [...timers]) {
        if (t.ms === ms) {
          timers.delete(id);
          t.cb();
        }
      }
    },
    pendingDelays(): number[] {
      return [...timers.values()].map((t) => t.ms).sort((a, b) => a - b);
    },
  };
}

describe('ждать ли кадра', () => {
  it('на переднем плане — да, кадр там будет и его видно', () => {
    expect(deferStart('active')).toBe('after-frame');
    expect(settleDelayMs('after-frame')).toBe(FIRST_FRAME_SETTLE_MS);
  });

  it('в фоне и в переходном состоянии — нет: кадра не будет', () => {
    expect(deferStart('background')).toBe('now');
    expect(deferStart('inactive')).toBe('now');
    expect(deferStart('unknown')).toBe('now');
    expect(settleDelayMs('now')).toBe(0);
  });

  it('состояние неизвестно — тоже нет: ждать наугад значит не начать вовсе', () => {
    expect(deferStart(null)).toBe('now');
    expect(deferStart(undefined)).toBe('now');
    expect(deferStart('')).toBe('now');
  });
});

describe('запуск в фоне', () => {
  it('начинается без кадра — кадра никто и не просит', () => {
    const h = harness('background');
    const seen: FrameTrigger[] = [];
    scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    expect(h.frames).toHaveLength(0);
    h.fireTimers(0);
    expect(seen).toEqual(['no-frame']);
  });

  it('срок, поставленный рядом, второй раз работу не запускает', () => {
    const h = harness('background');
    const seen: FrameTrigger[] = [];
    scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    h.fireTimers(0);
    h.fireTimers(FIRST_FRAME_DEADLINE_MS);
    expect(seen).toEqual(['no-frame']);
  });
});

describe('запуск на переднем плане', () => {
  it('обычный ход: кадр, пауза, работа', () => {
    const h = harness('active');
    const seen: FrameTrigger[] = [];
    scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    expect(h.frames).toHaveLength(1);
    expect(seen).toEqual([]);
    h.frames[0]();
    expect(seen).toEqual([]);
    h.fireTimers(FIRST_FRAME_SETTLE_MS);
    expect(seen).toEqual(['frame']);
  });

  it('кадр не пришёл — работа всё равно начинается по сроку', () => {
    const h = harness('active');
    const seen: FrameTrigger[] = [];
    scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    // Кадр не вызывается вовсе — ровно то, что происходило в фоне.
    h.fireTimers(FIRST_FRAME_DEADLINE_MS);
    expect(seen).toEqual(['deadline']);
  });

  it('срок стоит рядом с кадром с самого начала, а не появляется потом', () => {
    const h = harness('active');
    scheduleAfterFirstFrame(h.scheduler, () => {});
    expect(h.pendingDelays()).toEqual([FIRST_FRAME_DEADLINE_MS]);
  });

  it('опоздавший кадр после срока работу не повторяет', () => {
    const h = harness('active');
    const seen: FrameTrigger[] = [];
    scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    h.fireTimers(FIRST_FRAME_DEADLINE_MS);
    h.frames[0]();
    h.fireTimers(FIRST_FRAME_SETTLE_MS);
    expect(seen).toEqual(['deadline']);
  });
});

describe('отмена', () => {
  it('снимает и кадр, и все таймеры', () => {
    const h = harness('active');
    const seen: FrameTrigger[] = [];
    const cancel = scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    cancel();
    expect(h.cancelledFrames).toHaveLength(1);
    expect(h.pendingDelays()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('после отмены не запускает работу ни кадр, ни срок', () => {
    const h = harness('active');
    const seen: FrameTrigger[] = [];
    const cancel = scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    cancel();
    h.frames[0]();
    h.fireTimers(FIRST_FRAME_SETTLE_MS);
    h.fireTimers(FIRST_FRAME_DEADLINE_MS);
    expect(seen).toEqual([]);
  });

  it('в фоне отмена тоже снимает поставленный таймер', () => {
    const h = harness('background');
    const seen: FrameTrigger[] = [];
    const cancel = scheduleAfterFirstFrame(h.scheduler, (t) => seen.push(t));
    cancel();
    h.fireTimers(0);
    expect(seen).toEqual([]);
  });
});

describe('форма исходников', () => {
  it('правило живёт в модуле без зависимостей', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });

  it('запуск больше не висит на одном requestAnimationFrame', () => {
    const src = APP();
    expect(src).toContain('scheduleAfterFirstFrame(');
    // Строка, из-за которой в фоне не запускалось ничего.
    expect(src).not.toContain('frame = requestAnimationFrame(() => {');
    expect(src).not.toContain('timer = setTimeout(run, 250);');
    // Состояние приложения теперь спрашивают до планирования.
    expect(src).toContain('appState: AppState.currentState,');
  });

  it('обход кадра оставляет след в журнале', () => {
    const src = APP();
    expect(src).toContain("log.info('deferred_setup_without_frame'");
    expect(src).toContain("if (trigger !== 'frame') {");
  });

  it('отмена по-прежнему попадает в общий список уборки эффекта', () => {
    const src = APP();
    expect(src).toContain('deferredCleanups.push(cancel);');
  });
});
