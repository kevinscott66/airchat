/**
 * Unit tests for WebRTCSignaling: listener deduplication, disconnect cleanup.
 */
import EventEmitter from 'events';

// Minimal Socket.IO-compatible mock.
// EventEmitter already provides .on() / .off() / .emit() — we add only .connected and .disconnect().
class MockSocket extends EventEmitter {
  connected = true;

  // socket.io-client's Socket.off(event) removes ALL listeners for that event (no handler arg required)
  off(event: string, listener?: (...args: unknown[]) => void): this {
    if (listener) this.removeListener(event, listener);
    else this.removeAllListeners(event);
    return this;
  }

  disconnect(): void {
    this.connected = false;
  }

  emit(event: string, ...args: unknown[]): boolean {
    if (event === 'register') {
      const ack = args[1];
      if (typeof ack === 'function') ack({ ok: true });
    }
    return super.emit(event, ...args);
  }
}

let mockSocket: MockSocket;

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => {
    mockSocket = new MockSocket();
    process.nextTick(() => {
      mockSocket.emit('registration_challenge', { challenge: 'test-challenge' });
      mockSocket.emit('connect');
    });
    return mockSocket;
  }),
}));

jest.mock('../../../config', () => ({
  loadConfig: jest.fn(async () => ({
    webrtc: {
      signalingUrl: 'ws://localhost:3001',
      stunServers: [],
      turnServers: [],
    },
  })),
}));

jest.mock('../../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { WebRTCSignaling } from '../signaling';
import { log } from '../../../logger';

const warn = log.warn as jest.Mock;

async function connectedSignaling(): Promise<WebRTCSignaling> {
  const s = new WebRTCSignaling('ws://localhost:3001');
  await s.connect();
  return s;
}

describe('WebRTCSignaling — listener deduplication', () => {
  test('second onOffer call replaces first, not accumulates', async () => {
    const s = await connectedSignaling();
    const calls1: unknown[] = [];
    const calls2: unknown[] = [];

    s.onOffer(() => calls1.push(1));
    s.onOffer(() => calls2.push(2)); // should replace

    mockSocket.emit('offer', { sdp: 'v=0', fromPeerId: 'peer1' });

    expect(calls1).toHaveLength(0); // stale handler evicted
    expect(calls2).toHaveLength(1);
  });

  test('second onIceCandidate call replaces first', async () => {
    const s = await connectedSignaling();
    const stale: unknown[] = [];
    const fresh: unknown[] = [];

    s.onIceCandidate(() => stale.push(1));
    s.onIceCandidate(() => fresh.push(1));

    mockSocket.emit('ice-candidate', { fromPeerId: 'p', candidate: {} });

    expect(stale).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });

  test('second onAnswer call replaces first', async () => {
    const s = await connectedSignaling();
    const stale: unknown[] = [];
    const fresh: unknown[] = [];

    // v4.32.623: устаревший обработчик отмечается в списке, а не бросает.
    // С этой версии обработчики обёрнуты (guardHandler), и брошенное внутри
    // ловится и уходит в журнал — проверка «не сработал» через исключение
    // стала бы проверкой ни о чём.
    s.onAnswer(() => { stale.push(1); });
    s.onAnswer(() => fresh.push(1));

    mockSocket.emit('answer', { sdp: 'v=0', fromPeerId: 'p' });
    expect(stale).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });

  test('onRemoteSignal replaces any prior offer handler', async () => {
    const s = await connectedSignaling();
    const stale: unknown[] = [];
    const remote: string[] = [];

    s.onOffer(() => stale.push(1));
    s.onRemoteSignal((peerId) => remote.push(peerId));

    mockSocket.emit('offer', { sdp: 'v=0', fromPeerId: 'alice' });

    expect(stale).toHaveLength(0);
    expect(remote).toEqual(['alice']);
  });

  test('disconnect clears socket; subsequent emits do not throw', async () => {
    const s = await connectedSignaling();
    s.disconnect();
    expect(() => s.sendOffer('room', 'peer', 'sdp')).not.toThrow();
    expect(() => s.sendAnswer('peer', 'sdp')).not.toThrow();
  });

  test('re-registers after Socket.IO reconnect with the new challenge', async () => {
    const s = await connectedSignaling();
    const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
    await s.register('room', 'peer', pair);
    expect(s.isRegistered()).toBe(true);

    mockSocket.connected = false;
    mockSocket.emit('disconnect');
    expect(s.isRegistered()).toBe(false);

    mockSocket.connected = true;
    mockSocket.emit('registration_challenge', { challenge: 'reconnect-challenge' });
    mockSocket.emit('connect');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(s.isRegistered()).toBe(true);
  });
});

describe('WebRTCSignaling — расписка о получении журнала (v4.32.617)', () => {
  test('расписка уходит только после обработчика', async () => {
    const s = await connectedSignaling();
    const seen: unknown[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.onMissedCalls(async (msg) => {
      seen.push(msg);
      await gate;
    });

    const ack = jest.fn();
    mockSocket.emit('missed_calls', { calls: [] }, ack);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    // Обработчик ещё не закончил — сервер журнал не убирает.
    expect(ack).not.toHaveBeenCalled();

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('обработчик упал — расписки нет, журнал придёт снова', async () => {
    const s = await connectedSignaling();
    s.onMissedCalls(() => {
      throw new Error('storage down');
    });
    const ack = jest.fn();
    mockSocket.emit('missed_calls', { calls: [] }, ack);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ack).not.toHaveBeenCalled();
  });

  test('проверка не пустая: обычный обработчик расписку шлёт', async () => {
    const s = await connectedSignaling();
    const seen: unknown[] = [];
    s.onMissedCalls((msg) => {
      seen.push(msg);
    });
    const ack = jest.fn();
    mockSocket.emit('missed_calls', { calls: [] }, ack);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(1);
    expect(ack).toHaveBeenCalledTimes(1);
  });
});

/**
 * v4.32.623: сбой обработчика больше не пропадает бесследно.
 *
 * Обработчики звонков асинхронные (`sig.onOffer(async (msg) => …)`), а emitter
 * socket.io возвращённый промис не берёт: брошенное внутри исчезало целиком —
 * ни записи в журнале, ни отказа, ни звонка.
 */
describe('WebRTCSignaling — сбой обработчика', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  test('исключение обработчика не выходит наружу и попадает в журнал', async () => {
    const s = await connectedSignaling();
    s.onOffer(() => { throw new Error('boom'); });

    expect(() => mockSocket.emit('offer', { sdp: 'v=0', fromPeerId: 'p' })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'signaling_handler_failed',
      expect.objectContaining({ event: 'offer', err: 'boom' }),
    );
  });

  test('отказ асинхронного обработчика тоже доходит до журнала', async () => {
    const s = await connectedSignaling();
    s.onAnswer(async () => { throw new Error('async boom'); });

    mockSocket.emit('answer', { sdp: 'v=0', fromPeerId: 'p' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith(
      'signaling_handler_failed',
      expect.objectContaining({ event: 'answer', err: 'async boom' }),
    );
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: обработчик без сбоя зовётся сразу и журнал молчит', async () => {
    const s = await connectedSignaling();
    const seen: unknown[] = [];
    s.onIceCandidate(() => { seen.push(1); });

    mockSocket.emit('ice-candidate', { fromPeerId: 'p', candidate: {} });
    // Синхронно: перенос обработчика в микрозадачу сдвинул бы порядок
    // относительно кода, стоящего сразу за emit.
    expect(seen).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
