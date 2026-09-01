import fs from 'fs';
import path from 'path';
import { createTimerScope, type TimerScopeHost } from '../timerScope';

const SRC = path.join(__dirname, '..', '..', '..');

type Spawned = { id: number; kind: 'timeout' | 'interval' | 'frame'; fn: () => void; ms: number; cancelled: boolean };

function fakeHost(withRaf = true): { host: TimerScopeHost; spawned: Spawned[]; fire: (id: number) => void } {
  const spawned: Spawned[] = [];
  let seq = 0;
  const make = (kind: Spawned['kind']) => (fn: () => void, ms = 0): unknown => {
    const id = ++seq;
    spawned.push({ id, kind, fn, ms, cancelled: false });
    return id;
  };
  const cancel = (handle: unknown): void => {
    const row = spawned.find((s) => s.id === handle);
    if (row) row.cancelled = true;
  };
  const host: TimerScopeHost = {
    setTimeout: make('timeout'),
    clearTimeout: cancel,
    setInterval: make('interval'),
    clearInterval: cancel,
    requestAnimationFrame: withRaf ? ((fn: () => void) => make('frame')(fn, 0)) : undefined,
    cancelAnimationFrame: withRaf ? cancel : undefined,
  };
  const fire = (id: number): void => {
    const row = spawned.find((s) => s.id === id);
    if (!row) throw new Error(`нет таймера ${id}`);
    row.fn();
  };
  return { host, spawned, fire };
}

describe('createTimerScope — заведение и снятие', () => {
  test('interval заводится через хост и живёт в счёте', () => {
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => {}, 1000);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].kind).toBe('interval');
    expect(spawned[0].ms).toBe(1000);
    expect(scope.activeCount).toBe(1);
  });

  test('интервал остаётся в счёте после срабатывания', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    let ticks = 0;
    scope.interval(() => { ticks += 1; }, 1000);
    fire(spawned[0].id);
    fire(spawned[0].id);
    expect(ticks).toBe(2);
    expect(scope.activeCount).toBe(1);
  });

  test('одноразовый таймаут уходит из счёта при срабатывании', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    scope.timeout(() => {}, 5);
    expect(scope.activeCount).toBe(1);
    fire(spawned[0].id);
    expect(scope.activeCount).toBe(0);
  });

  test('кадр уходит из счёта при срабатывании', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    scope.frame(() => {});
    expect(scope.activeCount).toBe(1);
    fire(spawned[0].id);
    expect(scope.activeCount).toBe(0);
  });

  test('бросок изнутри одноразового таймера не оставляет мёртвой записи', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    scope.frame(() => { throw new Error('boom'); });
    expect(() => fire(spawned[0].id)).toThrow('boom');
    // Это и есть страховка панели вкладок: непустой счёт там значит
    // «кадр уже заказан», и залипший счётчик убил бы переключение навсегда.
    expect(scope.activeCount).toBe(0);
  });

  test('кадр, заказавший следующий кадр, не копит счёт', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    const again = (): void => { scope.frame(again); };
    scope.frame(again);
    fire(spawned[0].id);
    expect(scope.activeCount).toBe(1);
    fire(spawned[1].id);
    expect(scope.activeCount).toBe(1);
  });

  test('clearAll снимает все живые таймеры у хоста', () => {
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => {}, 1000);
    scope.timeout(() => {}, 10);
    scope.frame(() => {});
    scope.clearAll();
    expect(spawned.every((s) => s.cancelled)).toBe(true);
    expect(scope.activeCount).toBe(0);
  });

  test('clearAll не разбирает область — новые таймеры заводятся', () => {
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => {}, 1000);
    scope.clearAll();
    scope.interval(() => {}, 1000);
    expect(scope.disposed).toBe(false);
    expect(scope.activeCount).toBe(1);
    expect(spawned).toHaveLength(2);
  });

  test('уже снятый таймер не снимается повторно', () => {
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => {}, 1000);
    scope.clearAll();
    const cancelledOnce = spawned.filter((s) => s.cancelled).length;
    scope.clearAll();
    expect(spawned.filter((s) => s.cancelled).length).toBe(cancelledOnce);
  });
});

describe('createTimerScope — dispose', () => {
  test('dispose снимает живые таймеры', () => {
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => {}, 1000);
    scope.dispose();
    expect(spawned[0].cancelled).toBe(true);
    expect(scope.activeCount).toBe(0);
    expect(scope.disposed).toBe(true);
  });

  test('после dispose новый интервал НЕ заводится — хост о нём не узнаёт', () => {
    // Ровно тот дефект: `.then()` чтения из kv приходит после уборки экрана и
    // заводит секундный тикер, снимать который уже некому.
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.dispose();
    scope.interval(() => {}, 1000);
    expect(spawned).toHaveLength(0);
    expect(scope.activeCount).toBe(0);
  });

  test('после dispose не заводятся ни таймаут, ни кадр', () => {
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.dispose();
    scope.timeout(() => {}, 0);
    scope.frame(() => {});
    expect(spawned).toHaveLength(0);
  });

  test('запоздавший тикер не тикает: до исправления он тикал бы вечно', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    let ticks = 0;
    // Уборка экрана.
    scope.dispose();
    // Ответ асинхронного чтения приходит уже после неё.
    scope.interval(() => { ticks += 1; }, 1000);
    expect(spawned).toHaveLength(0);
    expect(() => fire(1)).toThrow();
    expect(ticks).toBe(0);
  });

  test('dispose повторно — не бросает и ничего не портит', () => {
    const { host } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => {}, 1000);
    scope.dispose();
    expect(() => scope.dispose()).not.toThrow();
    expect(scope.disposed).toBe(true);
  });

  test('dispose из тела собственного колбэка безопасен', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => { scope.dispose(); }, 1000);
    expect(() => fire(spawned[0].id)).not.toThrow();
    expect(spawned[0].cancelled).toBe(true);
    expect(scope.activeCount).toBe(0);
  });

  test('clearAll из тела собственного колбэка безопасен', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    scope.interval(() => { scope.clearAll(); }, 1000);
    fire(spawned[0].id);
    expect(scope.activeCount).toBe(0);
    expect(scope.disposed).toBe(false);
  });

  test('хост, бросающий на отмене, не ломает dispose', () => {
    const { host } = fakeHost();
    const scope = createTimerScope({ ...host, clearInterval: () => { throw new Error('уже забыт'); } });
    scope.interval(() => {}, 1000);
    expect(() => scope.dispose()).not.toThrow();
    expect(scope.activeCount).toBe(0);
  });
});

describe('createTimerScope — частные случаи хоста', () => {
  test('без кадрового хоста frame вырождается в нулевой таймаут', () => {
    const { host, spawned } = fakeHost(false);
    const scope = createTimerScope(host);
    scope.frame(() => {});
    expect(spawned).toHaveLength(1);
    expect(spawned[0].kind).toBe('timeout');
    expect(spawned[0].ms).toBe(0);
  });

  test('нулевой таймаут-подмена тоже уходит из счёта и снимается', () => {
    const { host, spawned, fire } = fakeHost(false);
    const scope = createTimerScope(host);
    scope.frame(() => {});
    scope.frame(() => {});
    fire(spawned[0].id);
    expect(scope.activeCount).toBe(1);
    scope.dispose();
    expect(spawned[1].cancelled).toBe(true);
  });

  test('синхронный хост: отработавший таймер не остаётся в счёте', () => {
    // Поддельные таймеры иногда выполняют тело прямо в setTimeout. Запись
    // добавляется после возврата хоста — если не заметить, она осталась бы
    // в счёте навсегда.
    let ran = 0;
    const sync: TimerScopeHost = {
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      setInterval: (fn) => { fn(); return 2; },
      clearInterval: () => {},
    };
    const scope = createTimerScope(sync);
    scope.timeout(() => { ran += 1; }, 0);
    expect(ran).toBe(1);
    expect(scope.activeCount).toBe(0);
  });

  test('области независимы: dispose одной не трогает другую', () => {
    const { host, spawned } = fakeHost();
    const a = createTimerScope(host);
    const b = createTimerScope(host);
    a.interval(() => {}, 1000);
    b.interval(() => {}, 1000);
    a.dispose();
    expect(spawned[0].cancelled).toBe(true);
    expect(spawned[1].cancelled).toBe(false);
    expect(b.disposed).toBe(false);
    expect(b.activeCount).toBe(1);
  });

  test('область без таймеров разбирается вхолостую', () => {
    const { host, spawned } = fakeHost();
    const scope = createTimerScope(host);
    scope.dispose();
    expect(spawned).toHaveLength(0);
    expect(scope.activeCount).toBe(0);
  });

  test('счёт растёт и падает по мере жизни таймеров', () => {
    const { host, spawned, fire } = fakeHost();
    const scope = createTimerScope(host);
    scope.timeout(() => {}, 1);
    scope.timeout(() => {}, 2);
    scope.interval(() => {}, 3);
    expect(scope.activeCount).toBe(3);
    fire(spawned[0].id);
    expect(scope.activeCount).toBe(2);
    fire(spawned[1].id);
    expect(scope.activeCount).toBe(1);
    fire(spawned[2].id);
    expect(scope.activeCount).toBe(1);
  });
});

describe('форма исходников — v4.32.505', () => {
  const groups = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
  const mod = fs.readFileSync(path.join(SRC, 'core', 'lifecycle', 'timerScope.ts'), 'utf8');

  test('модуль без импортов — область живёт и в фоновом контексте', () => {
    expect(mod).not.toMatch(/^import\s/m);
    expect(mod).not.toContain('require(');
  });

  test('в GroupsScreen не осталось голого ref под тикер', () => {
    expect(groups).not.toContain('slowTickRef');
  });

  test('GroupsScreen заводит отсчёт только через область', () => {
    expect(groups).toContain('slowScopeRef.current = createTimerScope()');
    expect(groups).toContain('scope.interval(() => {');
    expect(groups).toContain('slowScope?.dispose();');
  });

  test('восстановление отметки медленного режима отменяемо', () => {
    const m = groups.match(/void scopedKvGet\(slowKey\)\.then\(\(raw\) => \{[\s\S]*?\}, \[slowKey, startSlowCooldown\]\);/);
    expect(m).not.toBeNull();
    const block = m?.[0] ?? '';
    expect(block).toContain('if (cancelled) return;');
    expect(block).toContain('return () => { cancelled = true; };');
  });

  test('startSlowCooldown не работает с разобранной областью', () => {
    expect(groups).toContain('if (!scope || scope.disposed) return;');
  });

  test('в App.tsx не осталось неснимаемого кадра под вкладки', () => {
    expect(app).not.toContain('tabRafRef');
    // Остальные rAF в App.tsx — это ожидание кадров внутри await'нутого
    // промиса, у них нет пережившего размонтирование хвоста.
    const block = app.match(/const scheduleTab = useCallback[\s\S]*?\n {2}\}, \[\]\);/)?.[0] ?? '';
    expect(block).not.toBe('');
    expect(block).not.toContain('requestAnimationFrame');
  });

  test('App.tsx разбирает область вкладок при размонтировании', () => {
    expect(app).toContain('tabScopeRef.current = createTimerScope()');
    expect(app).toContain('return () => { scope?.dispose(); };');
  });

  test('коалесинг тапов держится на счёте живых кадров', () => {
    expect(app).toContain('if (scope.activeCount > 0) return;');
    expect(app).toContain('scope.frame(() => {');
  });
});
