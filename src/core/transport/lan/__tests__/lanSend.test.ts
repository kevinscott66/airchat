/**
 * v4.32.499 — отправка по локальной сети рапортует об успехе только по
 * подтверждению записи.
 *
 * Раньше `true` возвращался по неподвижному таймеру на 150 мс после
 * `write()`, а следом сокет уничтожался. Всё, что не успело уйти,
 * обрывалось, но наверх шло «отправлено» — вложения молча пропадали.
 *
 * Модуль сокетов здесь подставной: тест сам решает, когда придёт
 * подтверждение записи, придёт ли оно с ошибкой и не придёт ли вовсе.
 */

import fs from 'fs';
import path from 'path';
import { tcpSend, LAN_SEND_TIMEOUT_MS, type TcpModule } from '../lanSend';

type Fake = {
  mod: TcpModule;
  /** Позвать колбэк соединения. */
  connect: () => void;
  /** Подтвердить запись (или отказать). */
  ack: (err?: Error) => void;
  emit: (ev: string) => void;
  written: Uint8Array[];
  destroyed: number;
  writeCbSeen: boolean;
};

function fakeTcp(opts: { throwOnConnect?: boolean; throwOnWrite?: boolean } = {}): Fake {
  const handlers = new Map<string, (err?: Error) => void>();
  const state: Fake = {
    mod: null as unknown as TcpModule,
    connect: () => {},
    ack: () => {},
    emit: (ev) => handlers.get(ev)?.(),
    written: [],
    destroyed: 0,
    writeCbSeen: false,
  };
  let writeCb: ((err?: Error) => void) | null = null;
  state.ack = (err?: Error) => {
    state.writeCbSeen = true;
    writeCb?.(err);
  };
  state.mod = {
    createServer: (() => { throw new Error('не нужен'); }) as unknown as TcpModule['createServer'],
    createConnection: (_o, cb) => {
      if (opts.throwOnConnect) throw new Error('нет маршрута');
      state.connect = cb;
      return {
        write: (data, _enc, cb2) => {
          if (opts.throwOnWrite) throw new Error('сокет закрыт');
          state.written.push(data as Uint8Array);
          writeCb = cb2 ?? null;
        },
        destroy: () => { state.destroyed += 1; },
        on: (ev, h) => { handlers.set(ev, h); },
      };
    },
  };
  return state;
}

const FRAME = new Uint8Array([1, 2, 3, 4]);
/** Дать промису шанс разрешиться, не завися от таймеров. */
const settle = (): Promise<void> => Promise.resolve().then(() => undefined);

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('успех — только по подтверждению записи', () => {
  it('пока подтверждения нет, отправка не считается удачной', async () => {
    const f = fakeTcp();
    let settled: boolean | null = null;
    void tcpSend(f.mod, '10.0.0.2', 5555, FRAME).then((v) => { settled = v; });
    f.connect();
    await settle();
    expect(f.written).toHaveLength(1);
    // Ровно та точка, где прежний код уже отвечал «отправлено».
    jest.advanceTimersByTime(150);
    await settle();
    expect(settled).toBeNull();
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(settled).toBeNull();
  });

  it('подтверждение пришло — true, сокет закрыт', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.connect();
    await settle();
    f.ack();
    await expect(p).resolves.toBe(true);
    expect(f.destroyed).toBe(1);
  });

  it('подтверждение с ошибкой — false', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.connect();
    await settle();
    f.ack(new Error('broken pipe'));
    await expect(p).resolves.toBe(false);
    expect(f.destroyed).toBe(1);
  });

  it('подтверждение так и не пришло — отказ по общему сроку', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.connect();
    await settle();
    jest.advanceTimersByTime(LAN_SEND_TIMEOUT_MS);
    await expect(p).resolves.toBe(false);
    expect(f.destroyed).toBe(1);
  });

  it('кадр уходит в сокет ровно один раз и целиком', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.connect();
    await settle();
    f.ack();
    await p;
    expect(f.written).toHaveLength(1);
    expect(Array.from(f.written[0])).toEqual([1, 2, 3, 4]);
  });
});

describe('отказы', () => {
  it('событие error — false', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.emit('error');
    await expect(p).resolves.toBe(false);
  });

  it('событие timeout — false', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.emit('timeout');
    await expect(p).resolves.toBe(false);
  });

  it('соединение не установилось — false, без сокета', async () => {
    const f = fakeTcp({ throwOnConnect: true });
    await expect(tcpSend(f.mod, '10.0.0.2', 5555, FRAME)).resolves.toBe(false);
    expect(f.destroyed).toBe(0);
  });

  it('write бросил — false', async () => {
    const f = fakeTcp({ throwOnWrite: true });
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.connect();
    await expect(p).resolves.toBe(false);
    expect(f.destroyed).toBe(1);
  });

  it('нет соединения — общий срок всё равно закрывает попытку', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    jest.advanceTimersByTime(LAN_SEND_TIMEOUT_MS);
    await expect(p).resolves.toBe(false);
    expect(f.written).toHaveLength(0);
  });

  it('ответ один: подтверждение после отказа ничего не меняет', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.connect();
    await settle();
    f.emit('error');
    f.ack();
    await expect(p).resolves.toBe(false);
    expect(f.destroyed).toBe(1);
  });

  it('срок после успеха уже не срабатывает и сокет не рвётся дважды', async () => {
    const f = fakeTcp();
    const p = tcpSend(f.mod, '10.0.0.2', 5555, FRAME);
    f.connect();
    await settle();
    f.ack();
    await p;
    jest.advanceTimersByTime(LAN_SEND_TIMEOUT_MS * 2);
    expect(f.destroyed).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('форма исходников', () => {
  const dir = path.join(__dirname, '..');
  const send = fs.readFileSync(path.join(dir, 'lanSend.ts'), 'utf8');
  const transport = fs.readFileSync(path.join(dir, 'lanTransport.ts'), 'utf8');

  it('неподвижного таймера успеха больше нет', () => {
    // Именно вызов, а не упоминание числа в объяснении выше.
    expect(send).not.toMatch(/\}, 150\)/);
    expect(send).not.toMatch(/finish\(true\)[\s\S]{0,40}setTimeout/);
    // Единственный setTimeout — общий срок попытки.
    expect(send.match(/setTimeout\(/g)).toHaveLength(1);
  });

  it('успех объявляется ровно в одном месте — в колбэке записи', () => {
    expect(send.match(/finish\(!err\)/g)).toHaveLength(1);
    expect(send.match(/finish\(true\)/g)).toBeNull();
  });

  it('срок снимается только в finish', () => {
    expect(send.match(/clearTimeout\(/g)).toHaveLength(1);
    const at = send.indexOf('const finish = ');
    const body = send.slice(at, send.indexOf('\n    };', at));
    expect(body).toContain('clearTimeout(timer)');
  });

  it('транспорт берёт отправку из отдельного модуля и своей копии не держит', () => {
    expect(transport).toContain("import { tcpSend, type TcpModule } from './lanSend';");
    expect(transport).not.toContain('function tcpSend(');
  });

  it('модуль отправки ни от чего не зависит', () => {
    expect(send).not.toMatch(/^import /m);
  });
});
