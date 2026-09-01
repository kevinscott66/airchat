/**
 * v4.32.551 — подключённый сокет без рукопожатия обязан быть разорван, а не
 * выдан за готовое соединение.
 *
 * Дефект: если сигнальный сервер не присылал `registration_challenge` за пять
 * секунд, ожидание падало, а сокет оставался подключённым и присвоенным.
 * `connect()` начинался словами «если сокет подключён — возвращаемся», поэтому
 * каждый следующий вызов немедленно сообщал об успехе, а `register()` сразу за
 * ним падал с `registration_challenge_missing`. Одна медленная секунда на
 * старте сервера навсегда переводила приложение в состояние «соединён и
 * бесполезен»: звонки не проходили до перезапуска.
 */
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';

import {
  CHALLENGE_ABORTED_REASON,
  CHALLENGE_TIMEOUT_MS,
  CHALLENGE_TIMEOUT_REASON,
  classifyHandshake,
  isReusableConnection,
  needsTeardown,
  type HandshakeState,
  type SocketFacts,
} from '../handshakeState';

/** Сервер, который можно попросить промолчать в ответ на подключение. */
const serverBehaviour = { sendChallenge: true };

class MockSocket extends EventEmitter {
  connected = true;
  disconnectCalls = 0;

  off(event: string, listener?: (...args: unknown[]) => void): this {
    if (listener) this.removeListener(event, listener);
    else this.removeAllListeners(event);
    return this;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  emit(event: string, ...args: unknown[]): boolean {
    if (event === 'register') {
      const ack = args[1];
      if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: true });
    }
    return super.emit(event, ...args);
  }
}

const sockets: MockSocket[] = [];

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => {
    const socket = new MockSocket();
    sockets.push(socket);
    process.nextTick(() => {
      if (serverBehaviour.sendChallenge) {
        socket.emit('registration_challenge', { challenge: `challenge-${sockets.length}` });
      }
      socket.emit('connect');
    });
    return socket;
  }),
}));

jest.mock('../../../config', () => ({
  loadConfig: jest.fn(async () => ({
    webrtc: { signalingUrl: 'ws://localhost:3001', stunServers: [], turnServers: [] },
  })),
}));

jest.mock('../../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { WebRTCSignaling } from '../signaling';

const STATES: HandshakeState[] = ['absent', 'connecting', 'half-open', 'ready'];

function facts(over: Partial<SocketFacts> = {}): SocketFacts {
  return { hasSocket: true, connected: true, challengeReceived: true, ...over };
}

const MODULE = fs.readFileSync(path.join(__dirname, '..', 'handshakeState.ts'), 'utf8');
const SIGNALING = fs.readFileSync(path.join(__dirname, '..', 'signaling.ts'), 'utf8');

const PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

describe('состояние рукопожатия', () => {
  it('половинчатое соединение названо своим именем', () => {
    expect(classifyHandshake(facts({ challengeReceived: false }))).toBe('half-open');
  });

  it('остальные состояния различимы', () => {
    expect(classifyHandshake(facts({ hasSocket: false }))).toBe('absent');
    expect(classifyHandshake(facts({ connected: false }))).toBe('connecting');
    expect(classifyHandshake(facts())).toBe('ready');
  });

  it('нет сокета — неважно, что там про challenge', () => {
    expect(classifyHandshake({ hasSocket: false, connected: true, challengeReceived: true }))
      .toBe('absent');
    expect(classifyHandshake({ hasSocket: false, connected: false, challengeReceived: false }))
      .toBe('absent');
  });

  it('пригодно к работе ровно одно состояние из четырёх', () => {
    expect(STATES.filter(isReusableConnection)).toEqual(['ready']);
  });

  it('рвём ровно половинчатое — подключающийся сокет не трогаем', () => {
    expect(STATES.filter(needsTeardown)).toEqual(['half-open']);
  });

  it('пригодное и подлежащее разрыву никогда не совпадают', () => {
    for (const state of STATES) {
      expect(isReusableConnection(state) && needsTeardown(state)).toBe(false);
    }
  });

  it('у двух разных провалов рукопожатия разные причины', () => {
    expect(CHALLENGE_TIMEOUT_REASON).not.toBe(CHALLENGE_ABORTED_REASON);
    expect(CHALLENGE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('поведение сигнализации', () => {
  beforeEach(() => {
    // nextTick оставляем настоящим: им мок-сокет доставляет `connect` и
    // `registration_challenge`. Подменяем только пятисекундный срок ожидания.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    serverBehaviour.sendChallenge = true;
    sockets.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('обычное подключение доводит рукопожатие до конца', async () => {
    const s = new WebRTCSignaling('ws://localhost:3001');
    await s.connect();
    await expect(s.register('room', 'peer', PAIR)).resolves.toBeUndefined();
    expect(s.isRegistered()).toBe(true);
  });

  it('молчащий сервер: подключение падает и НЕ оставляет за собой сокет', async () => {
    serverBehaviour.sendChallenge = false;
    const s = new WebRTCSignaling('ws://localhost:3001');
    // Обработчик отказа вешаем сразу: иначе отказ прилетит во время прокрутки
    // таймеров и будет учтён как необработанный.
    const attempt = s.connect().catch((e: unknown) => e as Error);
    await jest.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS);
    expect((await attempt)?.message).toBe(CHALLENGE_TIMEOUT_REASON);

    expect(sockets).toHaveLength(1);
    // Это и есть починка: раньше сокет оставался подключённым и присвоенным.
    expect(sockets[0]?.disconnectCalls).toBe(1);
    expect(s.isRegistered()).toBe(false);
  });

  it('после несостоявшегося рукопожатия следующая попытка идёт заново', async () => {
    serverBehaviour.sendChallenge = false;
    const s = new WebRTCSignaling('ws://localhost:3001');
    const first = s.connect().catch((e: unknown) => e as Error);
    await jest.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS);
    expect((await first)?.message).toBe(CHALLENGE_TIMEOUT_REASON);

    serverBehaviour.sendChallenge = true;
    await s.connect();

    // Раньше второй connect() возвращался мгновенно на том же мёртвом сокете,
    // а register() падал с registration_challenge_missing навсегда.
    expect(sockets).toHaveLength(2);
    await expect(s.register('room', 'peer', PAIR)).resolves.toBeUndefined();
    expect(s.isRegistered()).toBe(true);
  });

  it('регистрация после молчания сервера чинится сама, а не остаётся мёртвой', async () => {
    serverBehaviour.sendChallenge = false;
    const s = new WebRTCSignaling('ws://localhost:3001');
    const attempt = s.register('room', 'peer', PAIR).catch((e: unknown) => e as Error);
    await jest.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS);
    expect(await attempt).toBeInstanceOf(Error);
    expect(s.isRegistered()).toBe(false);

    serverBehaviour.sendChallenge = true;
    await expect(s.register('room', 'peer', PAIR)).resolves.toBeUndefined();
    expect(s.isRegistered()).toBe(true);
  });

  it('сокет отвалился под ожидающим — тот узнаёт причину сразу, а не через таймер', async () => {
    serverBehaviour.sendChallenge = false;
    const s = new WebRTCSignaling('ws://localhost:3001');
    const attempt = s.connect().catch((e: unknown) => e as Error);
    await new Promise((resolve) => process.nextTick(resolve));

    sockets[0].connected = false;
    sockets[0].emit('disconnect');

    // Ни одна секунда пятисекундного срока не потрачена.
    expect((await attempt)?.message).toBe(CHALLENGE_ABORTED_REASON);
  });
});

describe('форма исходников', () => {
  it('модуль состояния без импортов', () => {
    expect(MODULE).not.toMatch(/^import\s/m);
    expect(MODULE).not.toMatch(/\brequire\(/);
  });

  it('connect спрашивает состояние, а не «подключён ли сокет»', () => {
    expect(SIGNALING).toContain('if (isReusableConnection(state)) return;');
    expect(SIGNALING).toContain('if (needsTeardown(state) && this.socket) this.discardHalfOpenSocket(this.socket);');
    expect(SIGNALING).not.toContain('if (this.socket?.connected) return;\n    if (this.connectInFlight)');
  });

  it('провал рукопожатия убирает за собой так же, как connect_error', () => {
    expect(SIGNALING).toContain('this.discardHalfOpenSocket(socket);');
    expect(SIGNALING).toContain('private discardHalfOpenSocket(socket: Socket): void {');
    expect(SIGNALING).toContain("log.warn('webrtc_signaling_handshake_incomplete'");
  });

  it('обрыв будит ожидающих challenge', () => {
    expect(SIGNALING).toContain('this.failChallengeWaiters(CHALLENGE_ABORTED_REASON);');
  });

  it('сроки и причины взяты из модуля, а не написаны числом на месте', () => {
    expect(SIGNALING).toContain('}, CHALLENGE_TIMEOUT_MS);');
    expect(SIGNALING).toContain('reject(new Error(CHALLENGE_TIMEOUT_REASON));');
    expect(SIGNALING).not.toContain("new Error('registration_challenge_timeout')");
  });
});
