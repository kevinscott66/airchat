/**
 * v4.32.545. Три экрана переписывали одну и ту же склейку вызовов от руки, и
 * все три роняли отказ в пустоту: обновление зовут через `void`, а значит
 * сорвавшееся чтение базы не видно ни в журнале, ни на экране — список просто
 * перестаёт пополняться. Проверяется и поведение (кто чего дожидается, кому
 * достаётся ошибка, сколько раз выполняется работа), и форма исходников — что
 * своих склеек в дереве не осталось.
 */
import fs from 'fs';
import path from 'path';
import { createCoalescedTask } from '../coalescedTask';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

const MOD = read('core/utils/coalescedTask.ts');
const CHAT = read('ui/screens/ChatScreen.tsx');
const GROUPS = read('ui/screens/GroupsScreen.tsx');
const OFFLINE = read('ui/components/OfflineStatus.tsx');

/** Отложенное обещание — чтобы держать работу «в полёте» сколько нужно. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve: () => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createCoalescedTask', () => {
  it('одна работа за раз: второй вызов не запускает вторую', async () => {
    const d = deferred();
    const calls: number[] = [];
    const task = createCoalescedTask();
    const first = task.run(async () => {
      calls.push(1);
      await d.promise;
    });
    void task.run(async () => {
      calls.push(2);
    });
    expect(calls).toEqual([1]);
    d.resolve();
    await first;
    await flush();
    expect(calls).toEqual([1, 2]);
  });

  it('повтор — один, сколько бы раз ни просили', async () => {
    const d = deferred();
    let repeats = 0;
    const task = createCoalescedTask();
    const first = task.run(async () => { await d.promise; });
    const again = async (): Promise<void> => { repeats += 1; };
    void task.run(again);
    void task.run(again);
    void task.run(again);
    d.resolve();
    await first;
    await flush();
    expect(repeats).toBe(1);
  });

  it('повторяется последняя из просьб, а не первая', async () => {
    const d = deferred();
    const done: string[] = [];
    const task = createCoalescedTask();
    const first = task.run(async () => { await d.promise; });
    void task.run(async () => { done.push('старая'); });
    void task.run(async () => { done.push('свежая'); });
    d.resolve();
    await first;
    await flush();
    expect(done).toEqual(['свежая']);
  });

  it('отказ не выходит наружу, а уходит в onError', async () => {
    const seen: unknown[] = [];
    const task = createCoalescedTask({ onError: (e) => seen.push(e) });
    const boom = new Error('база занята');
    await expect(task.run(async () => { throw boom; })).resolves.toBeUndefined();
    expect(seen).toEqual([boom]);
  });

  it('без onError отказ просто гасится', async () => {
    const task = createCoalescedTask();
    await expect(task.run(async () => { throw new Error('тихо'); })).resolves.toBeUndefined();
  });

  it('ожидающему не достаётся чужая ошибка', async () => {
    const d = deferred();
    const seen: unknown[] = [];
    const task = createCoalescedTask({ onError: (e) => seen.push(e) });
    const first = task.run(async () => { await d.promise; });
    const second = task.run(async () => {});
    const boom = new Error('чужая беда');
    d.reject(boom);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(seen).toEqual([boom]);
  });

  it('после отказа повтор всё равно выполняется', async () => {
    const d = deferred();
    let repeated = false;
    const task = createCoalescedTask({ onError: () => {} });
    const first = task.run(async () => { await d.promise; });
    void task.run(async () => { repeated = true; });
    d.reject(new Error('сорвалось'));
    await first;
    await flush();
    expect(repeated).toBe(true);
  });

  it('repeat: false — просьба во время работы не порождает второй заход', async () => {
    const d = deferred();
    let second = 0;
    const task = createCoalescedTask({ repeat: false });
    const first = task.run(async () => { await d.promise; });
    void task.run(async () => { second += 1; });
    d.resolve();
    await first;
    await flush();
    expect(second).toBe(0);
  });

  it('isBusy отвечает честно до и после', async () => {
    const d = deferred();
    const task = createCoalescedTask();
    expect(task.isBusy()).toBe(false);
    const first = task.run(async () => { await d.promise; });
    expect(task.isBusy()).toBe(true);
    d.resolve();
    await first;
    expect(task.isBusy()).toBe(false);
  });

  it('длинная цепочка повторов не растит стек: повтор — виток цикла', async () => {
    const task = createCoalescedTask();
    let depth = 0;
    let maxDepth = 0;
    const work = async (): Promise<void> => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      await Promise.resolve();
      depth -= 1;
    };
    const d = deferred();
    const first = task.run(async () => { await d.promise; });
    for (let i = 0; i < 50; i += 1) void task.run(work);
    d.resolve();
    await first;
    await flush();
    // Работы не вкладываются друг в друга — иначе прежний `void loadMessages()`
    // из finally уводил бы стек вглубь на каждую просьбу.
    expect(maxDepth).toBe(1);
  });

  it('работа, позвавшая run из себя, видит, что обновление уже идёт', async () => {
    const task = createCoalescedTask();
    let busyInside: boolean | null = null;
    await task.run(async () => {
      busyInside = task.isBusy();
    });
    expect(busyInside).toBe(true);
  });
});

describe('модуль остаётся чистым', () => {
  it('в coalescedTask.ts нет ни одного import', () => {
    expect(MOD.split('\n').filter((l) => l.startsWith('import '))).toEqual([]);
    expect(MOD).not.toContain('require(');
  });

  it('модуль не знает ни про React, ни про экраны', () => {
    expect(MOD).not.toMatch(/React|useRef|useCallback|setState/);
  });
});

describe('своих склеек в дереве не осталось', () => {
  it('три места зовут общий модуль', () => {
    for (const src of [CHAT, GROUPS, OFFLINE]) {
      expect(src).toContain("from '../../core/utils/coalescedTask'");
      expect(src).toContain('createCoalescedTask(');
    }
  });

  it('ручные InFlight/Again-ссылки убраны', () => {
    for (const src of [CHAT, GROUPS, OFFLINE]) {
      expect(src).not.toMatch(/InFlightRef/);
      expect(src).not.toMatch(/AgainRef/);
    }
  });

  it('у каждого места есть, куда сообщить о сорвавшемся обновлении', () => {
    for (const src of [CHAT, GROUPS, OFFLINE]) {
      expect(src).toMatch(/onError: \(e\) => log\.(warn|error)\(/);
    }
  });

  it('подсчёт очереди не повторяется — он идемпотентен', () => {
    expect(OFFLINE).toContain('repeat: false');
  });

  it('обновление по потягиванию списка больше не молчит', () => {
    const start = CHAT.indexOf('const onRefresh = useCallback');
    expect(start).toBeGreaterThan(-1);
    const body = CHAT.slice(start, CHAT.indexOf('\n  }, [', start));
    expect(body).toContain('} catch (e) {');
    expect(body).toContain("log.error('ui_chat_refresh_failed'");
    expect(body).toContain('userErrorText(e,');
    expect(body.indexOf('} catch (e) {')).toBeLessThan(body.indexOf('} finally {'));
  });

  it('во всём src не осталось try/finally без catch в этих трёх файлах', () => {
    for (const [name, src] of [['ChatScreen', CHAT], ['GroupsScreen', GROUPS], ['OfflineStatus', OFFLINE]] as const) {
      const lines = src.split('\n');
      const bad: number[] = [];
      lines.forEach((line, i) => {
        if (!/^\s*\} finally \{\s*$/.test(line)) return;
        // Ищем вверх ближайший `try {` того же отступа и смотрим, был ли catch.
        const indent = (line.match(/^\s*/) ?? [''])[0];
        for (let j = i - 1; j >= 0; j -= 1) {
          if (lines[j] === `${indent}} catch {` || lines[j].startsWith(`${indent}} catch (`)) return;
          if (lines[j] === `${indent}try {`) { bad.push(i + 1); return; }
        }
      });
      expect({ name, bad }).toEqual({ name, bad: [] });
    }
  });
});
