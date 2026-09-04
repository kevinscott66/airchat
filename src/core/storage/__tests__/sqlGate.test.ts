/**
 * v4.32.581 — очередь операторов к одному соединению.
 */
import { SqlGate, txnEffect } from '../sqlGate';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('txnEffect', () => {
  it('узнаёт открытие и закрытие в любом виде', () => {
    expect(txnEffect('BEGIN')).toBe('open');
    expect(txnEffect('BEGIN IMMEDIATE')).toBe('open');
    expect(txnEffect('  begin deferred  ')).toBe('open');
    expect(txnEffect('COMMIT')).toBe('close');
    expect(txnEffect('rollback')).toBe('close');
    expect(txnEffect('END')).toBe('close');
  });

  it('не принимает за транзакцию оператор, который просто так начинается', () => {
    // Ни одно из этих слов не является BEGIN, хотя начинается похоже.
    expect(txnEffect('BEGINNING')).toBe('none');
    expect(txnEffect('SELECT 1')).toBe('none');
    expect(txnEffect("INSERT INTO kv (k, v) VALUES ('begin', 'commit')")).toBe('none');
    expect(txnEffect('ENDPOINT')).toBe('none');
  });

  it('видит оператор за комментарием', () => {
    expect(txnEffect('-- заводим транзакцию\nBEGIN IMMEDIATE')).toBe('open');
    expect(txnEffect('/* ... */ COMMIT')).toBe('close');
  });
});

describe('SqlGate', () => {
  it('выполняет операторы по одному и в порядке подачи', async () => {
    const gate = new SqlGate(0);
    const order: string[] = [];
    let running = 0;
    const op = (name: string) =>
      gate.submit('a', 'none', async () => {
        running += 1;
        expect(running).toBe(1);
        await tick();
        running -= 1;
        order.push(name);
      });
    await Promise.all([op('1'), op('2'), op('3')]);
    expect(order).toEqual(['1', '2', '3']);
  });

  it('упавший оператор не отравляет очередь', async () => {
    const gate = new SqlGate(0);
    const boom = gate.submit('a', 'none', async () => {
      throw new Error('нет такой таблицы');
    });
    await expect(boom).rejects.toThrow('нет такой таблицы');
    await expect(gate.submit('a', 'none', async () => 'жив')).resolves.toBe('жив');
  });

  it('чужой оператор не попадает внутрь открытой транзакции', async () => {
    const gate = new SqlGate(0);
    const seen: string[] = [];

    await gate.submit('вкладка-1', 'open', async () => {
      seen.push('BEGIN(1)');
    });

    // Вторая вкладка пишет ровно в этот момент. Раньше её запись оказалась бы
    // внутри чужой транзакции и уехала бы вместе с её откатом.
    const outsider = gate.submit('вкладка-2', 'none', async () => {
      seen.push('INSERT(2)');
    });

    await tick();
    await tick();
    expect(seen).toEqual(['BEGIN(1)']);

    await gate.submit('вкладка-1', 'none', async () => {
      seen.push('INSERT(1)');
    });
    await gate.submit('вкладка-1', 'close', async () => {
      seen.push('COMMIT(1)');
    });

    await outsider;
    expect(seen).toEqual(['BEGIN(1)', 'INSERT(1)', 'COMMIT(1)', 'INSERT(2)']);
  });

  it('несостоявшийся BEGIN не оставляет затвор закрытым', async () => {
    const gate = new SqlGate(0);
    await expect(
      gate.submit('a', 'open', async () => {
        throw new Error('база занята');
      })
    ).rejects.toThrow('база занята');
    expect(gate.openTransactionOwner).toBeNull();
    await expect(gate.submit('b', 'none', async () => 'ок')).resolves.toBe('ок');
  });

  it('упавший COMMIT тоже отпускает: держать соединение в неизвестном виде нельзя', async () => {
    const gate = new SqlGate(0);
    await gate.submit('a', 'open', async () => undefined);
    await expect(
      gate.submit('a', 'close', async () => {
        throw new Error('диск');
      })
    ).rejects.toThrow('диск');
    expect(gate.openTransactionOwner).toBeNull();
  });

  it('закрытая вкладка не запирает базу навсегда', async () => {
    const abandoned: string[] = [];
    const gate = new SqlGate(20, (o) => abandoned.push(o));
    await gate.submit('ушедшая', 'open', async () => undefined);

    const waiting = gate.submit('живая', 'none', async () => 'дождалась');
    await new Promise((r) => setTimeout(r, 60));

    expect(abandoned).toEqual(['ушедшая']);
    expect(gate.openTransactionOwner).toBeNull();
    await expect(waiting).resolves.toBe('дождалась');
  });

  it('прощание вкладки снимает затвор сразу', async () => {
    const gate = new SqlGate(0);
    await gate.submit('ушедшая', 'open', async () => undefined);
    const waiting = gate.submit('живая', 'none', async () => 'дождалась');
    gate.release('ушедшая');
    await expect(waiting).resolves.toBe('дождалась');
  });

  it('прощание чужой вкладки затвор не трогает', async () => {
    const gate = new SqlGate(0);
    await gate.submit('держит', 'open', async () => undefined);
    gate.release('посторонняя');
    expect(gate.openTransactionOwner).toBe('держит');
  });
});
