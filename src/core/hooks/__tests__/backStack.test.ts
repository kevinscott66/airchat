import {
  pushBackHandler,
  runBackHandlers,
  resetBackHandlersForTest,
} from '../backStack';

describe('backStack (v4.32.540)', () => {
  beforeEach(() => resetBackHandlersForTest());

  it('возвращает false, когда возвращаться некуда — жест не закрывает приложение', () => {
    expect(runBackHandlers()).toBe(false);
  });

  it('спрашивает последний зарегистрированный первым: верхняя модалка закрывается раньше', () => {
    const order: string[] = [];
    pushBackHandler(() => { order.push('screen'); return true; });
    pushBackHandler(() => { order.push('modal'); return true; });
    expect(runBackHandlers()).toBe(true);
    expect(order).toEqual(['modal']);
  });

  it('пропускает событие дальше, когда верхний обработчик вернул false', () => {
    const order: string[] = [];
    pushBackHandler(() => { order.push('screen'); return true; });
    pushBackHandler(() => { order.push('modal'); return false; });
    expect(runBackHandlers()).toBe(true);
    expect(order).toEqual(['modal', 'screen']);
  });

  it('трактует undefined как «поглощено» — тот же контракт, что у системной кнопки', () => {
    pushBackHandler(() => { /* закрыл оверлей и ничего не вернул */ });
    expect(runBackHandlers()).toBe(true);
  });

  it('снятый обработчик больше не спрашивается', () => {
    const seen: string[] = [];
    const off = pushBackHandler(() => { seen.push('modal'); return true; });
    off();
    pushBackHandler(() => { seen.push('screen'); return true; });
    runBackHandlers();
    expect(seen).toEqual(['screen']);
  });

  it('обработчик, который снимает сам себя, не заставляет пропустить соседа', () => {
    const seen: string[] = [];
    pushBackHandler(() => { seen.push('screen'); return true; });
    const off = pushBackHandler(() => { seen.push('modal'); off(); return false; });
    expect(runBackHandlers()).toBe(true);
    expect(seen).toEqual(['modal', 'screen']);
  });

  it('исключение в обработчике не блокирует те, что под ним', () => {
    const seen: string[] = [];
    pushBackHandler(() => { seen.push('screen'); return true; });
    pushBackHandler(() => { throw new Error('boom'); });
    expect(runBackHandlers()).toBe(true);
    expect(seen).toEqual(['screen']);
  });
});
