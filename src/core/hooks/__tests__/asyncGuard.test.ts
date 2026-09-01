import { createKeyGate, createPressGate, runAndSettle } from '../asyncGuard';

describe('createPressGate', () => {
  it('пропускает первое нажатие', () => {
    const gate = createPressGate();
    expect(gate.tryStart(1000, 80)).toBe('run');
    expect(gate.isBusy()).toBe(true);
  });

  it('пропускает нажатие в нулевой момент времени', () => {
    // Гейт, инициализированный нулём, отсёк бы его как повторное.
    const gate = createPressGate();
    expect(gate.tryStart(0, 80)).toBe('run');
  });

  it('отбрасывает второе нажатие, пока работа идёт', () => {
    const gate = createPressGate();
    gate.tryStart(1000, 80);
    // Прошло много времени — throttle тут ни при чём, дело именно в занятости.
    expect(gate.tryStart(999_000, 80)).toBe('busy');
  });

  it('отбрасывает повторное нажатие внутри окна throttle', () => {
    const gate = createPressGate();
    gate.tryStart(1000, 80);
    gate.finish();
    expect(gate.tryStart(1079, 80)).toBe('throttled');
  });

  it('различает причины отказа', () => {
    const gate = createPressGate();
    gate.tryStart(1000, 80);
    expect(gate.tryStart(1001, 80)).toBe('busy');
    gate.finish();
    expect(gate.tryStart(1001, 80)).toBe('throttled');
  });

  it('пропускает нажатие ровно на границе окна', () => {
    const gate = createPressGate();
    gate.tryStart(1000, 80);
    gate.finish();
    expect(gate.tryStart(1080, 80)).toBe('run');
  });

  it('отсчитывает throttle от начала нажатия, а не от завершения работы', () => {
    const gate = createPressGate();
    gate.tryStart(1000, 300);
    // Работа заняла пять секунд; накидывать сверху ещё 300 мс паузы незачем.
    gate.finish();
    expect(gate.tryStart(6000, 300)).toBe('run');
  });

  it('не двигает точку отсчёта отброшенным нажатием', () => {
    const gate = createPressGate();
    gate.tryStart(1000, 80);
    gate.finish();
    expect(gate.tryStart(1040, 80)).toBe('throttled');
    // Иначе тремор продлевал бы блокировку сам себя: каждый отказ сдвигал бы
    // окно вперёд, и до кнопки было бы не достучаться.
    expect(gate.tryStart(1081, 80)).toBe('run');
  });

  it('нулевой throttle оставляет только защиту от параллельного запуска', () => {
    const gate = createPressGate();
    expect(gate.tryStart(1000, 0)).toBe('run');
    expect(gate.tryStart(1000, 0)).toBe('busy');
    gate.finish();
    expect(gate.tryStart(1000, 0)).toBe('run');
  });

  it('лишний finish не ломает состояние', () => {
    const gate = createPressGate();
    gate.tryStart(1000, 80);
    gate.finish();
    gate.finish();
    expect(gate.isBusy()).toBe(false);
    expect(gate.tryStart(2000, 80)).toBe('run');
  });

  it('гейты независимы друг от друга', () => {
    const a = createPressGate();
    const b = createPressGate();
    a.tryStart(1000, 80);
    expect(b.tryStart(1000, 80)).toBe('run');
  });
});

describe('createKeyGate', () => {
  it('пропускает первый вызов по ключу', () => {
    const gate = createKeyGate();
    expect(gate.tryStart('post-1')).toBe(true);
    expect(gate.isActive('post-1')).toBe(true);
  });

  it('отбрасывает повторный вызов по тому же ключу', () => {
    const gate = createKeyGate();
    gate.tryStart('post-1');
    expect(gate.tryStart('post-1')).toBe(false);
  });

  it('разные ключи работают параллельно', () => {
    const gate = createKeyGate();
    expect(gate.tryStart('post-1')).toBe(true);
    expect(gate.tryStart('post-2')).toBe(true);
    expect(gate.activeCount()).toBe(2);
  });

  it('освобождает ключ после finish', () => {
    const gate = createKeyGate();
    gate.tryStart('post-1');
    gate.finish('post-1');
    expect(gate.isActive('post-1')).toBe(false);
    expect(gate.tryStart('post-1')).toBe(true);
  });

  it('finish по одному ключу не освобождает остальные', () => {
    const gate = createKeyGate();
    gate.tryStart('post-1');
    gate.tryStart('post-2');
    gate.finish('post-1');
    expect(gate.isActive('post-2')).toBe(true);
    expect(gate.activeCount()).toBe(1);
  });

  it('finish по незанятому ключу ничего не делает', () => {
    const gate = createKeyGate();
    gate.tryStart('post-1');
    gate.finish('post-404');
    expect(gate.isActive('post-1')).toBe(true);
    expect(gate.activeCount()).toBe(1);
  });

  it('isActive не занимает ключ', () => {
    const gate = createKeyGate();
    expect(gate.isActive('post-1')).toBe(false);
    expect(gate.tryStart('post-1')).toBe(true);
  });

  it('пустая строка — обычный ключ', () => {
    const gate = createKeyGate();
    expect(gate.tryStart('')).toBe(true);
    expect(gate.tryStart('')).toBe(false);
    expect(gate.isActive('')).toBe(true);
  });

  it('не течёт после полного цикла', () => {
    const gate = createKeyGate();
    for (const key of ['a', 'b', 'c']) gate.tryStart(key);
    for (const key of ['a', 'b', 'c']) gate.finish(key);
    expect(gate.activeCount()).toBe(0);
  });
});

describe('runAndSettle', () => {
  it('завершает после успешного действия', async () => {
    const settled = jest.fn();
    const onError = jest.fn();
    runAndSettle(async () => {}, settled, onError);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('завершает после отклонённого промиса и отдаёт ошибку', async () => {
    const settled = jest.fn();
    const onError = jest.fn();
    const boom = new Error('boom');
    runAndSettle(() => Promise.reject(boom), settled, onError);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('завершает, когда действие бросило синхронно', () => {
    // Здесь ломалась прежняя версия: исключение улетало из обработчика
    // нажатия, флаг занятости оставался поднятым, кнопка умирала навсегда.
    const settled = jest.fn();
    const onError = jest.fn();
    const boom = new Error('sync');
    expect(() =>
      runAndSettle(
        () => {
          throw boom;
        },
        settled,
        onError,
      ),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('завершает, когда действие вернуло не промис', async () => {
    const settled = jest.fn();
    const onError = jest.fn();
    // Обычная функция вместо async — `.catch` у undefined бросал TypeError.
    runAndSettle(() => undefined, settled, onError);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('зовёт onSettled ровно один раз, даже если действие бросило после await', async () => {
    const settled = jest.fn();
    const onError = jest.fn();
    runAndSettle(
      async () => {
        await Promise.resolve();
        throw new Error('late');
      },
      settled,
      onError,
    );
    await new Promise((r) => setImmediate(r));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('не завершает раньше времени, пока действие не закончилось', async () => {
    const settled = jest.fn();
    let release: () => void = () => {};
    runAndSettle(
      () => new Promise<void>((r) => { release = r; }),
      settled,
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));
    expect(settled).not.toHaveBeenCalled();
    release();
    await new Promise((r) => setImmediate(r));
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('ошибка в onError не мешает завершению', async () => {
    const settled = jest.fn();
    runAndSettle(
      () => Promise.reject(new Error('boom')),
      settled,
      () => {
        throw new Error('logger broke');
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe('гейт + завершение вместе', () => {
  it('после ошибки в действии кнопка снова доступна', async () => {
    const gate = createPressGate();
    expect(gate.tryStart(1000, 80)).toBe('run');
    runAndSettle(
      () => Promise.reject(new Error('network')),
      () => gate.finish(),
      jest.fn(),
    );
    await new Promise((r) => setImmediate(r));
    expect(gate.isBusy()).toBe(false);
    expect(gate.tryStart(5000, 80)).toBe('run');
  });

  it('после синхронного броска ключ освобождается', () => {
    const gate = createKeyGate();
    gate.tryStart('post-1');
    runAndSettle(
      () => {
        throw new Error('sync');
      },
      () => gate.finish('post-1'),
      jest.fn(),
    );
    expect(gate.isActive('post-1')).toBe(false);
  });
});
