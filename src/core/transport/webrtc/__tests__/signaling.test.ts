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
    const fresh: unknown[] = [];

    s.onAnswer(() => { throw new Error('stale handler must not fire'); });
    s.onAnswer(() => fresh.push(1));

    mockSocket.emit('answer', { sdp: 'v=0', fromPeerId: 'p' });
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
