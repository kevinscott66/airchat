/**
 * Детектор блокировок JS-потока (v4.32.362).
 *
 * Модуль без React и без платформенных модулей: время двигаем поддельными
 * таймерами. Проверять его стоит именно так — сам он ничего не чинит, но
 * работает у всех и постоянно, и цена его ошибки — расход батареи там, где
 * пользы никакой.
 */

import { startJsThreadWatcher, type BlockEvent, type FlushEvent } from '../jsThreadWatcher';

const PING = 100;

/**
 * Часы отдельно от таймеров — в этом весь смысл проверки.
 *
 * Поддельный таймер срабатывает ровно в назначенный миг, поэтому «занятый
 * поток» так не изобразить: сколько ни прокручивай, тик отработает вовремя.
 * Детектор же сравнивает назначенное время с показаниями Date.now, и занятость
 * — это когда стрелки ушли дальше, чем прошло тиков.
 */
let clock = 0;

/** Прокрутить n тиков без задержки: поток свободен. */
function idle(ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    clock += PING;
    jest.advanceTimersByTime(PING);
  }
}

/** Сымитировать занятый поток: часы ушли на PING + blockMs, тик один. */
function block(blockMs: number): void {
  clock += PING + blockMs;
  jest.advanceTimersByTime(PING);
}

beforeEach(() => {
  jest.useFakeTimers();
  clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('startJsThreadWatcher', () => {
  it('свободный поток не даёт ни одного события', () => {
    const blocks: BlockEvent[] = [];
    const stop = startJsThreadWatcher({ thresholdMs: 150, onBlock: (e) => blocks.push(e) });
    idle(20);
    expect(blocks).toEqual([]);
    stop();
  });

  it('задержка выше порога фиксируется, ниже — нет', () => {
    const blocks: BlockEvent[] = [];
    const stop = startJsThreadWatcher({ thresholdMs: 150, onBlock: (e) => blocks.push(e) });
    block(100); // 100 мс — ниже порога
    expect(blocks).toHaveLength(0);
    block(400);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].delayMs).toBe(400);
    stop();
  });

  it('тяжёлый блок эскалируется сразу, не дожидаясь сводки', () => {
    const severe: BlockEvent[] = [];
    const flushes: FlushEvent[] = [];
    const stop = startJsThreadWatcher({
      thresholdMs: 150,
      severeThresholdMs: 1_000,
      flushIntervalMs: 5_000,
      onBlock: () => { /* тишина */ },
      onSevereBlock: (e) => severe.push(e),
      onFlush: (e) => flushes.push(e),
    });
    block(2_000);
    expect(severe).toHaveLength(1);
    expect(flushes).toHaveLength(0); // сводка ещё не подошла
    stop();
  });

  it('блок между порогом и тяжёлым в эскалацию не попадает', () => {
    const severe: BlockEvent[] = [];
    const stop = startJsThreadWatcher({
      thresholdMs: 150,
      severeThresholdMs: 1_000,
      onBlock: () => { /* тишина */ },
      onSevereBlock: (e) => severe.push(e),
    });
    block(600);
    expect(severe).toHaveLength(0);
    stop();
  });

  it('сводка складывает период и отдаёт максимум', () => {
    const flushes: FlushEvent[] = [];
    const stop = startJsThreadWatcher({
      thresholdMs: 150,
      flushIntervalMs: 1_000,
      onBlock: () => { /* тишина */ },
      onFlush: (e) => flushes.push(e),
    });
    block(200);
    block(500);
    jest.advanceTimersByTime(1_000);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].blocks).toHaveLength(2);
    expect(flushes[0].totalBlockedMs).toBe(700);
    expect(flushes[0].maxDelayMs).toBe(500);
    stop();
  });

  it('пустой период сводкой не тревожит', () => {
    const flushes: FlushEvent[] = [];
    const stop = startJsThreadWatcher({ thresholdMs: 150, flushIntervalMs: 1_000, onFlush: (e) => flushes.push(e) });
    jest.advanceTimersByTime(5_000);
    expect(flushes).toEqual([]);
    stop();
  });

  it('буфер опустошается каждой сводкой, а не растёт', () => {
    // Иначе за сутки работы приложения там копились бы десятки тысяч записей —
    // утечка памяти у диагностики, которая от утечек и должна оберегать.
    const flushes: FlushEvent[] = [];
    const stop = startJsThreadWatcher({
      thresholdMs: 150,
      flushIntervalMs: 1_000,
      onBlock: () => { /* тишина */ },
      onFlush: (e) => flushes.push(e),
    });
    block(200);
    jest.advanceTimersByTime(1_000);
    block(300);
    jest.advanceTimersByTime(1_000);
    expect(flushes).toHaveLength(2);
    expect(flushes[1].blocks).toHaveLength(1);
    expect(flushes[1].totalBlockedMs).toBe(300);
    stop();
  });

  it('после остановки не остаётся ни одного таймера', () => {
    // v4.32.362: остановка снимала только флаг, и запланированный тик доживал
    // свои сто миллисекунд уже после размонтирования.
    const stop = startJsThreadWatcher({ thresholdMs: 150, flushIntervalMs: 1_000, onFlush: () => { /* тишина */ } });
    idle(3);
    stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('после остановки события не приходят', () => {
    const blocks: BlockEvent[] = [];
    const flushes: FlushEvent[] = [];
    const stop = startJsThreadWatcher({
      thresholdMs: 150,
      flushIntervalMs: 1_000,
      onBlock: (e) => blocks.push(e),
      onFlush: (e) => flushes.push(e),
    });
    block(400);
    stop();
    block(5_000);
    jest.advanceTimersByTime(10_000);
    expect(blocks).toHaveLength(1);
    expect(flushes).toEqual([]);
  });

  it('повторная остановка ничего не ломает', () => {
    const stop = startJsThreadWatcher({ thresholdMs: 150 });
    stop();
    expect(() => stop()).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
