/**
 * v4.32.496 — рэтчет на очередь запуска и разбора push-службы.
 *
 * Поведение проверяется на самом модуле и на модели службы, повторяющей её
 * порядок действий: разбор ходит в сеть за удалением токена и только в конце
 * сбрасывает флаг `initialized`. Форма исходника проверяется отдельно —
 * чтобы публичные `init`/`dispose` не начали снова работать в обход дорожки.
 */

import fs from 'fs';
import path from 'path';
import { createSerialRunner, type SerialRunner } from '../lifecycleQueue';

const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

describe('дорожка: задачи идут строго друг за другом', () => {
  it('вторая задача начинается только после конца первой', async () => {
    const run = createSerialRunner();
    const order: string[] = [];
    const a = run(async () => { order.push('a:start'); await tick(); order.push('a:end'); });
    const b = run(async () => { order.push('b:start'); await tick(); order.push('b:end'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('порядок сохраняется на любом числе задач', async () => {
    const run = createSerialRunner();
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) => run(async () => { await tick(); order.push(i); })),
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('результат задачи возвращается тому, кто её поставил', async () => {
    const run = createSerialRunner();
    await expect(run(async () => { await tick(); return 42; })).resolves.toBe(42);
  });

  it('ошибка задачи доходит до её вызывающего', async () => {
    const run = createSerialRunner();
    await expect(run(async () => { throw new Error('нет сети'); })).rejects.toThrow('нет сети');
  });

  it('падение одной задачи не останавливает очередь', async () => {
    const run = createSerialRunner();
    const order: string[] = [];
    const bad = run(async () => { order.push('bad'); throw new Error('нет сети'); });
    const good = run(async () => { order.push('good'); });
    await expect(bad).rejects.toThrow('нет сети');
    await good;
    expect(order).toEqual(['bad', 'good']);
  });

  it('задача, поставленная изнутри идущей, ждёт её конца', async () => {
    // Ровно поэтому init внутри зовёт disposeLocked напрямую: постановка в ту
    // же дорожку из уже занявшей её задачи ждала бы саму себя.
    const run = createSerialRunner();
    const order: string[] = [];
    let inner: Promise<void> | null = null;
    await run(async () => {
      order.push('внешняя:начало');
      inner = run(async () => { order.push('вложенная'); });
      await tick();
      order.push('внешняя:конец');
    });
    expect(order).toEqual(['внешняя:начало', 'внешняя:конец']);
    await inner;
    expect(order).toEqual(['внешняя:начало', 'внешняя:конец', 'вложенная']);
  });
});

/** Модель службы: тот же порядок шагов, что у PushNotificationService. */
class ServiceModel {
  initialized = false;
  peer: string | null = null;
  listeners: string[] = [];
  readonly trace: string[] = [];

  constructor(private readonly serial: SerialRunner | null) {}

  init(peer: string): Promise<void> {
    return this.serial ? this.serial(() => this.initLocked(peer)) : this.initLocked(peer);
  }

  dispose(): Promise<void> {
    return this.serial ? this.serial(() => this.disposeLocked()) : this.disposeLocked();
  }

  private async initLocked(peer: string): Promise<void> {
    if (this.initialized) {
      if (this.peer === peer) { this.trace.push('init:пропущен'); return; }
      await this.disposeLocked();
    }
    await tick(); // выдача разрешений, каналы, токен
    this.listeners.push('onMessage');
    this.initialized = true;
    this.peer = peer;
    this.trace.push('init:готово');
  }

  private async disposeLocked(): Promise<void> {
    await tick(); // deleteToken ходит в сеть
    this.listeners = [];
    this.peer = null;
    this.initialized = false;
    this.trace.push('dispose:готово');
  }
}

describe('переключение личности: разбор против запуска', () => {
  it('без дорожки возврат в тот же аккаунт оставляет службу без подписок', async () => {
    const s = new ServiceModel(null);
    await s.init('A');
    const d = s.dispose();
    const i = s.init('A');
    await Promise.all([d, i]);
    expect(s.trace).toEqual(['init:готово', 'init:пропущен', 'dispose:готово']);
    expect(s.listeners).toEqual([]);
    expect(s.initialized).toBe(false);
  });

  it('с дорожкой возврат в тот же аккаунт поднимает подписки заново', async () => {
    const s = new ServiceModel(createSerialRunner());
    await s.init('A');
    const d = s.dispose();
    const i = s.init('A');
    await Promise.all([d, i]);
    expect(s.trace).toEqual(['init:готово', 'dispose:готово', 'init:готово']);
    expect(s.listeners).toEqual(['onMessage']);
    expect(s.initialized).toBe(true);
  });

  it('без дорожки смена аккаунта разбирает службу дважды', async () => {
    const s = new ServiceModel(null);
    await s.init('A');
    await Promise.all([s.dispose(), s.init('B')]);
    expect(s.trace.filter((t) => t === 'dispose:готово')).toHaveLength(2);
  });

  it('с дорожкой смена аккаунта разбирает ровно один раз', async () => {
    const s = new ServiceModel(createSerialRunner());
    await s.init('A');
    await Promise.all([s.dispose(), s.init('B')]);
    expect(s.trace.filter((t) => t === 'dispose:готово')).toHaveLength(1);
    expect(s.peer).toBe('B');
    expect(s.listeners).toEqual(['onMessage']);
  });

  it('повторный запуск того же аккаунта подряд по-прежнему ничего не делает', async () => {
    const s = new ServiceModel(createSerialRunner());
    await s.init('A');
    await s.init('A');
    expect(s.trace).toEqual(['init:готово', 'init:пропущен']);
    expect(s.listeners).toEqual(['onMessage']);
  });
});

describe('форма исходников', () => {
  const dir = path.join(__dirname, '..');
  const queue = fs.readFileSync(path.join(dir, 'lifecycleQueue.ts'), 'utf8');
  const push = fs.readFileSync(path.join(dir, 'pushNotifications.ts'), 'utf8');

  it('модуль дорожки ни от чего не зависит', () => {
    expect(queue).not.toMatch(/^import /m);
    expect(queue).not.toMatch(/\brequire\(/);
  });

  it('дорожка у службы одна', () => {
    expect(push.match(/createSerialRunner\(\)/g)).toHaveLength(1);
    expect(push).toContain('private readonly serial = createSerialRunner();');
  });

  it.each([
    ['init', 'initLocked'],
    ['dispose', 'disposeLocked'],
  ])('публичный %s только ставит задачу в дорожку', (pub, locked) => {
    const re = new RegExp(`async ${pub}\\(([^)]*)\\): Promise<void> \\{\\n    return this\\.serial\\(\\(\\) => this\\.${locked}\\(`);
    expect(push).toMatch(re);
  });

  it('запуск зовёт разбор напрямую, минуя дорожку', () => {
    expect(push).toContain('await this.disposeLocked();');
    // this.dispose() изнутри дорожки — вечное ожидание самого себя.
    expect(push).not.toMatch(/await this\.dispose\(\)/);
  });

  it('оба тела остаются закрытыми: снаружи их не позвать', () => {
    expect(push).toContain('private async initLocked(');
    expect(push).toContain('private async disposeLocked(');
  });

  it('флаг initialized сбрасывается в самом конце разбора', () => {
    const at = push.indexOf('private async disposeLocked(');
    expect(at).toBeGreaterThan(0);
    const body = push.slice(at, push.indexOf('\n  }\n', at));
    expect(body.trimEnd().endsWith('this.initialized = false;')).toBe(true);
  });
});
