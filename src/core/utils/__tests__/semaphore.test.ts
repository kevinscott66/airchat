import { createSemaphore } from '../semaphore';

/** Задача, которую можно завершить снаружи. */
function deferred() {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res as (v?: unknown) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Дать движку прокрутить накопившиеся микрозадачи. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createSemaphore', () => {
  it('пропускает задачи в пределах лимита сразу', async () => {
    const sem = createSemaphore(2);
    const a = deferred();
    const b = deferred();
    let started = 0;
    void sem.run(async () => { started++; await a.promise; });
    void sem.run(async () => { started++; await b.promise; });
    await tick();
    expect(started).toBe(2);
    expect(sem.waitingCount()).toBe(0);
    a.resolve(); b.resolve();
    await tick();
  });

  it('третью задачу держит, пока не освободится слот', async () => {
    const sem = createSemaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    gates.forEach((g, i) => { void sem.run(async () => { started.push(i); await g.promise; }); });
    await tick();
    expect(started).toEqual([0, 1]);
    expect(sem.waitingCount()).toBe(1);

    gates[0].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(sem.waitingCount()).toBe(0);
    gates[1].resolve(); gates[2].resolve();
    await tick();
  });

  it('очередь соблюдается по порядку', async () => {
    const sem = createSemaphore(1);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    gates.forEach((g, i) => { void sem.run(async () => { started.push(i); await g.promise; }); });
    await tick();
    expect(started).toEqual([0]);
    gates[0].resolve(); await tick();
    expect(started).toEqual([0, 1]);
    gates[1].resolve(); await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[2].resolve(); await tick();
  });

  it('отказавшая задача освобождает слот', async () => {
    // Ровно эта строчка и есть смысл finally: без неё один неудачный запрос
    // забирал бы слот навсегда, а после четырёх картинки в чате оставались бы
    // серыми квадратами до перезапуска приложения.
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('нет сети'); })).rejects.toThrow('нет сети');
    await expect(sem.run(async () => 'готово')).resolves.toBe('готово');
    expect(sem.activeCount()).toBe(0);
  });

  it('синхронный бросок внутри задачи тоже освобождает слот', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run((() => { throw new Error('сразу'); }) as () => Promise<never>)).rejects.toThrow('сразу');
    expect(sem.activeCount()).toBe(0);
    await expect(sem.run(async () => 1)).resolves.toBe(1);
  });

  it('счётчик возвращается к нулю после полного круга', async () => {
    const sem = createSemaphore(2);
    await Promise.all([1, 2, 3, 4, 5].map((n) => sem.run(async () => n)));
    expect(sem.activeCount()).toBe(0);
    expect(sem.waitingCount()).toBe(0);
  });

  it('отдаёт значение задачи', async () => {
    const sem = createSemaphore(3);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });

  it('не пускает больше лимита при массовом запуске', async () => {
    const sem = createSemaphore(4);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 40 }, () =>
        sem.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await tick();
          running -= 1;
        })
      )
    );
    expect(peak).toBe(4);
    expect(sem.activeCount()).toBe(0);
  });

  it('негодный лимит превращается в один слот, а не в ноль', async () => {
    // Ноль слотов — это не «медленно», это остановка навсегда: ждать
    // освобождения было бы некому.
    for (const bad of [0, -3, NaN, Infinity]) {
      const sem = createSemaphore(bad);
      await expect(sem.run(async () => 'ок')).resolves.toBe('ок');
      expect(sem.activeCount()).toBe(0);
    }
  });

  it('дробный лимит округляется вниз', async () => {
    const sem = createSemaphore(2.9);
    const gates = [deferred(), deferred(), deferred()];
    gates.forEach((g) => { void sem.run(() => g.promise as Promise<unknown>); });
    await tick();
    expect(sem.waitingCount()).toBe(1);
    gates.forEach((g) => g.resolve());
    await tick();
  });
});
