/**
 * Входящий звонок не исчезает из-за исходящего, начатого в ту же секунду
 * (v4.32.740).
 *
 * Дефект. `initiateCall` проверял занятость линии первым делом, а состояние
 * звонка записывал последним — между ними стояли три ожидания: очередь
 * ограничителя, регистрация на сигнальном сервере (сеть) и запрос разрешений на
 * микрофон с камерой (системное окно, которое висит, пока человек не ответит).
 * Входящий звонок, доехавший в это окно, успевал установиться целиком: `onOffer`
 * записывал `incoming`, гасил баннер из шторки и сжигал номер звонка в списке
 * виденных предложений. Возвращаясь из ожиданий, `initiateCall` писал поверх
 * свой `outgoing`.
 *
 * Пропажа была полной и тихой. `recordCallEnd` не звали — значит в списке
 * звонков не появлялось даже «Пропущен». Повторы предложения звонящий слал, но
 * их отбрасывали как уже виденные. Человек не узнавал, что ему звонили, а
 * звонящий слушал гудки до самого срока.
 *
 * Отдельно — окно после отбоя. Отмену сброса состояния `ended` делали до
 * ожиданий, и неудачная попытка позвонить (сигнальный сервер недоступен, в
 * разрешениях отказали) оставляла на экране «Завершён» навсегда: сброс уже
 * отменён, а ставить `null` некому.
 */
import fs from 'fs';
import path from 'path';

import {
  disposeCallService,
  getCurrentCall,
  hangupCall,
  initCallService,
  initiateCall,
} from '../callService';
import { makePeer, makePeerLadder, sealOffer, testCallId } from './callTestPeers';

const mockOfferHandler: { current: ((msg: { fromPeerId: string; sdp: string }) => void) | null } = { current: null };
const mockSendOffer = jest.fn();

/** Чем ответит `connect()` сигнального сервера в этом прогоне. */
const gate: { release: (() => void) | null; hold: boolean; fail: boolean } = {
  release: null,
  hold: false,
  fail: false,
};

const mockAudioTrack = { enabled: true, stop: jest.fn() };
const mockLocalStream = {
  getTracks: () => [mockAudioTrack],
  getAudioTracks: () => [mockAudioTrack],
  getVideoTracks: () => [],
};

class MockPeerConnection {
  ontrack: ((event: { streams?: unknown[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  addTrack = jest.fn();
  close = jest.fn();
  constructor(_config: unknown) { void _config; }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(d: unknown): Promise<void> { void d; }
  async setRemoteDescription(d: unknown): Promise<void> { void d; }
  async addIceCandidate(c: unknown): Promise<void> { void c; }
}

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: MockPeerConnection,
  RTCSessionDescription: class { constructor(v: unknown) { void v; } },
  RTCIceCandidate: class { constructor(v: unknown) { void v; } },
  mediaDevices: { getUserMedia: jest.fn(async () => mockLocalStream) },
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    // Регистрация переигрывается на каждой попытке звонка — так ожидание
    // регистрации становится тем самым окном, которое проверяется ниже.
    isRegistered = (): boolean => false;
    connect = async (): Promise<void> => {
      if (gate.hold) await new Promise<void>((resolve) => { gate.release = resolve; });
      if (gate.fail) throw new Error('signaling_down');
    };
    register = jest.fn(async () => undefined);
    disconnect = jest.fn();
    sendHangup = jest.fn();
    sendIceCandidate = jest.fn();
    sendAnswer = jest.fn();
    sendOffer = (room: string, peer: string, sdp: string): void => { mockSendOffer(room, peer, sdp); };
    onOffer = (handler: typeof mockOfferHandler.current): void => { mockOfferHandler.current = handler; };
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onHangup = jest.fn();
    onPeerUnavailable = jest.fn();
    onMissedCalls = jest.fn();
  },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({
    webrtc: { signalingUrl: 'http://signal.test', stunServers: [], turnServers: [] },
  })),
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async (): Promise<void> => undefined,
    isBlocked: (): boolean => false,
  },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const { me } = makePeerLadder();
const peer = makePeer();
const ME = me.pub;
const PEER = peer.pub;

/** Прокрутить очередь микрозадач, не двигая часы. */
function settle(): Promise<void> {
  return jest.advanceTimersByTimeAsync(0);
}

/** Изобразить входящий звонок так, как его присылает сигнальный сервер. */
async function receiveOffer(): Promise<void> {
  mockOfferHandler.current?.({
    fromPeerId: PEER,
    sdp: await sealOffer(peer, ME, { isVideo: false, callId: testCallId() }),
  });
  await settle();
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'callService.ts'), 'utf8');

describe('начало исходящего звонка', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await disposeCallService();
    mockOfferHandler.current = null;
    mockSendOffer.mockClear();
    gate.release = null;
    gate.hold = false;
    gate.fail = false;
    await initCallService(me.pair);
  });

  afterEach(async () => {
    gate.hold = false;
    gate.fail = false;
    gate.release?.();
    await disposeCallService();
    jest.useRealTimers();
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: на свободной линии звонок по-прежнему заводится', async () => {
    // Здесь ничего из починки не участвует: проверка обязана проходить и до
    // неё, и после — иначе «до правки всё красное» ничего не значит.
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    expect(getCurrentCall()?.state).toBe('outgoing');
    expect(getCurrentCall()?.direction).toBe('outgoing');
    expect(SRC.length).toBeGreaterThan(20000);
    expect(SRC).toContain("log.warn('call_permissions_denied', { isVideo });");
  });

  it('входящий, доехавший во время ожидания, НЕ затирается исходящим', async () => {
    gate.hold = true;
    const started = initiateCall(PEER, 'peer', false);
    await settle();
    // Ожидание ещё идёт: состояние звонка не записано, линия свободна.
    expect(getCurrentCall()).toBeNull();

    await receiveOffer();
    expect(getCurrentCall()?.state).toBe('incoming');

    gate.hold = false;
    gate.release?.();
    await expect(started).resolves.toBe(false);

    // Вот это и есть починка: раньше здесь стоял `outgoing`, а входящий звонок
    // исчезал без следа — ни экрана, ни «Пропущен» в списке.
    expect(getCurrentCall()?.state).toBe('incoming');
    expect(getCurrentCall()?.direction).toBe('incoming');
    expect(getCurrentCall()?.peerPubB64).toBe(PEER);
    // И предложения своего звонка мы не отправляли: звонить было уже некуда.
    expect(mockSendOffer).not.toHaveBeenCalled();
  });

  it('уже идущий разговор не перебивается и без всякого ожидания', async () => {
    await receiveOffer();
    expect(getCurrentCall()?.state).toBe('incoming');
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(false);
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('неудачная попытка из окна после отбоя не оставляет «Завершён» навсегда', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await hangupCall();
    expect(getCurrentCall()?.state).toBe('ended');

    // Сигнальный сервер отвалился — звонок не начнётся.
    gate.fail = true;
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(false);

    // Раньше отмену сброса делали до ожиданий: сброс уже не приходил, а новое
    // состояние записать было некому — «Завершён» висел до перезапуска.
    await jest.advanceTimersByTimeAsync(3000);
    expect(getCurrentCall()).toBeNull();
  });
});

describe('правило занятости линии записано один раз', () => {
  it('и входящий, и исходящий спрашивают одну и ту же функцию', () => {
    expect(SRC).toContain('function callInProgress(): boolean {');
    expect(SRC).toContain(
      "return !!currentCall && currentCall.state !== 'idle' && currentCall.state !== 'ended';"
    );
    // Приём предложения, ранний отказ и поздняя перепроверка.
    expect(SRC.split('if (callInProgress())').length - 1).toBe(3);
  });

  it('поздняя проверка стоит после всех ожиданий и до записи состояния', () => {
    const from = SRC.indexOf('export async function initiateCall(');
    expect(from).toBeGreaterThan(0);
    const body = SRC.slice(from, SRC.indexOf('\n  clearRemoteStream();', from));
    const perms = body.indexOf('const permsOk = await ensureCallPermissions(isVideo);');
    const late = body.indexOf("log.warn('call_already_active_late'");
    const write = body.indexOf('currentCall = {');
    expect(perms).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(perms);
    expect(write).toBeGreaterThan(late);
    // Между поздней проверкой и записью не осталось ни одного ожидания.
    expect(body.slice(late, write)).not.toContain('await ');
  });

  it('отмена сброса «Завершён» переехала вплотную к записи', () => {
    const from = SRC.indexOf('export async function initiateCall(');
    const body = SRC.slice(from, SRC.indexOf('\n  clearRemoteStream();', from));
    const cancel = body.indexOf('clearTimeout(endedResetTimer);');
    expect(cancel).toBeGreaterThan(body.indexOf('const permsOk = await ensureCallPermissions(isVideo);'));
    expect(cancel).toBeLessThan(body.indexOf('currentCall = {'));
  });
});
