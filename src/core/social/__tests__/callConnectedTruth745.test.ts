/**
 * «Разговор идёт» не начинается раньше, чем появился звук (v4.32.745).
 *
 * Обмен предложением и ответом идёт через сигнальный сервер и удаётся почти
 * всегда — он не говорит ничего о том, доходят ли пакеты между устройствами.
 * Пакеты потекут только после того, как ICE подберёт проходимую пару адресов,
 * а за симметричным NAT одного STUN на это не хватает, и TURN в настройках по
 * умолчанию нет: пара не находится вовсе.
 *
 * До правки `connectedAt` ставили прямо на обмен SDP, обеими сторонами. Отсюда
 * две неправды подряд. На экране поверх тишины бежали часы разговора. В журнале
 * такой звонок оставался «состоявшимся» и с длительностью — при том, что
 * слышно не было ни секунды.
 *
 * Теперь `connectedAt` — время найденного пути. Состояние `'connected'` своего
 * значения не поменяло («рукопожатие состоялось»), и экран звонка поднимается
 * как раньше; а у звонка, где путь так и не нашёлся, появился свой исход —
 * `'failed'`, он же «Не соединились».
 */
import fs from 'fs';
import path from 'path';

type OfferMsg = { fromPeerId: string; sdp: string };
type AnswerMsg = { fromPeerId: string; sdp: string };

const mockOfferHandler: { current: ((msg: OfferMsg) => void) | null } = { current: null };
const mockAnswerHandler: { current: ((msg: AnswerMsg) => void) | null } = { current: null };
const mockSendHangup = jest.fn();
const mockSendIceCandidate = jest.fn();
const mockSendAnswer = jest.fn();
const mockSendOffer = jest.fn();
const mockSendCallPush = jest.fn(async () => undefined);
const mockCancelNotification = jest.fn(async () => undefined);
const mockNotifyMissedCall = jest.fn(async () => undefined);

const mockKvGetSecret = jest.fn(async (_key: string): Promise<string | null> => null);
const mockKvSetSecret = jest.fn(async (_key: string, _value: string): Promise<boolean> => true);
const mockKvDelete = jest.fn(async (_key: string): Promise<void> => undefined);

const mockAudioTrack = { enabled: true, stop: jest.fn() };
const mockLocalStream = {
  getTracks: () => [mockAudioTrack],
  getAudioTracks: () => [mockAudioTrack],
  getVideoTracks: () => [],
};
const mockGetUserMedia = jest.fn(async () => mockLocalStream);

/**
 * Врезка в середину `acceptCall`: соединение к этому мигу уже создано, а строки
 * с «разговор идёт» ещё не было. Ровно в это окно у принимающего и успевает
 * соединиться ICE — порядок двух событий не задан.
 */
const pcHooks: { beforeAnswer: (() => void) | null } = { beforeAnswer: null };

/**
 * Последнее созданное соединение — через него тест и двигает ICE.
 *
 * Держим в поле, а не в переменной: присваивание `this` голой переменной
 * линтер не пропускает, а через поле читается ровно то же самое.
 */
const pcRef: { last: MockPeerConnection | null } = { last: null };

class MockPeerConnection {
  ontrack: ((event: { streams?: unknown[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  iceConnectionState = 'new';
  remoteDescription: unknown = null;
  addTrack = jest.fn();
  close = jest.fn();

  constructor(_config: unknown) { void _config; pcRef.last = this; }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    pcHooks.beforeAnswer?.();
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(description: unknown): Promise<void> { void description; }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(_candidate: unknown): Promise<void> { void _candidate; }
}

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: MockPeerConnection,
  RTCSessionDescription: class { constructor(value: unknown) { void value; } },
  RTCIceCandidate: class { constructor(value: unknown) { void value; } },
  mediaDevices: { getUserMedia: mockGetUserMedia },
}));

jest.mock('../../storage/local', () => ({
  kvGetSecret: (key: string) => mockKvGetSecret(key),
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: (key: string) => mockKvDelete(key),
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendHangup = (peer: string): void => { mockSendHangup(peer); };
    sendIceCandidate = (peer: string, c: unknown): void => { mockSendIceCandidate(peer, c); };
    sendAnswer = (peer: string, sdp: string): void => { mockSendAnswer(peer, sdp); };
    sendOffer = (room: string, peer: string, sdp: string): void => { mockSendOffer(room, peer, sdp); };
    sendMissedReceipt = jest.fn();
    onOffer = (handler: typeof mockOfferHandler.current): void => { mockOfferHandler.current = handler; };
    onAnswer = (handler: typeof mockAnswerHandler.current): void => { mockAnswerHandler.current = handler; };
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

jest.mock('../../../notifications/pushNotifications', () => ({
  pushNotificationService: { sendCallPush: mockSendCallPush },
  notifyMissedCall: mockNotifyMissedCall,
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { cancelNotification: mockCancelNotification },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  acceptCall,
  declineCall,
  disposeCallService,
  getCallLog,
  getCurrentCall,
  hangupCall,
  initCallService,
  initiateCall,
} from '../callService';
import { envelopeBody, makePeer, sealAnswer, sealOffer } from './callTestPeers';

const me = makePeer();
const peer = makePeer();
const ME = me.pub;
const PEER = peer.pub;

/** Точка отсчёта: часы стоят, время двигает только сам тест. */
const T0 = 1_800_000_000_000;

/** Прокрутить очередь микрозадач, не двигая часы. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await jest.advanceTimersByTimeAsync(0);
}

/** Подвинуть часы, не запуская сроков: длительность меряется, таймеры спят. */
function tick(ms: number): void {
  jest.setSystemTime(Date.now() + ms);
}

/** Номер звонка из последнего ушедшего предложения. */
function lastOfferCallId(): string {
  const call = mockSendOffer.mock.calls.at(-1);
  return String((envelopeBody(call?.[2]) as { callId?: string }).callId);
}

/** Сказать соединению то, что о нём говорит ICE. */
function fireIce(state: string): void {
  const conn = pcRef.last;
  if (!conn) throw new Error('соединение ещё не создано');
  conn.iceConnectionState = state;
  conn.oniceconnectionstatechange?.();
}

/** Исходящий звонок до обмена SDP включительно — звука ещё нет. */
async function handshakeOutgoing(): Promise<void> {
  await expect(initiateCall(PEER, 'сосед', false)).resolves.toBe(true);
  await settle();
  const answer = await sealAnswer(peer, ME, { callId: lastOfferCallId() });
  mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: answer });
  await settle();
}

/** Входящий звонок до снятой трубки включительно. */
async function handshakeIncoming(): Promise<void> {
  const offer = await sealOffer(peer, ME, { isVideo: false });
  mockOfferHandler.current?.({ fromPeerId: PEER, sdp: offer });
  await settle();
  expect(getCurrentCall()?.state).toBe('incoming');
  await expect(acceptCall()).resolves.toBe(true);
  await settle();
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  await disposeCallService();
  pcRef.last = null;
  pcHooks.beforeAnswer = null;
  mockOfferHandler.current = null;
  mockAnswerHandler.current = null;
  mockSendHangup.mockClear();
  mockSendIceCandidate.mockClear();
  mockSendAnswer.mockClear();
  mockSendOffer.mockClear();
  mockSendCallPush.mockClear();
  mockCancelNotification.mockClear();
  mockNotifyMissedCall.mockClear();
  mockKvGetSecret.mockClear();
  mockKvSetSecret.mockClear();
  mockKvSetSecret.mockImplementation(async () => true);
  mockKvDelete.mockClear();
  mockGetUserMedia.mockClear();
  mockGetUserMedia.mockImplementation(async () => mockLocalStream);
  mockAudioTrack.enabled = true;
  mockAudioTrack.stop.mockClear();
  await initCallService(me.pair);
});

afterEach(async () => {
  await disposeCallService();
  jest.useRealTimers();
});

describe('время разговора ставит ICE, а не обмен SDP', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: ответ SDP по-прежнему поднимает экран разговора', async () => {
    await handshakeOutgoing();
    // Состояние своего значения не поменяло: «рукопожатие состоялось».
    expect(getCurrentCall()?.state).toBe('connected');
  });

  it('одного ответа SDP для времени разговора мало', async () => {
    await handshakeOutgoing();
    expect(getCurrentCall()?.connectedAt).toBeNull();
  });

  it('путь нашёлся — время появилось, и это время пути', async () => {
    await handshakeOutgoing();
    tick(3_000);
    fireIce('connected');
    await settle();
    expect(getCurrentCall()?.connectedAt).toBe(T0 + 3_000);
  });

  it('«completed» — тот же найденный путь', async () => {
    await handshakeOutgoing();
    tick(1_500);
    fireIce('completed');
    await settle();
    expect(getCurrentCall()?.connectedAt).toBe(T0 + 1_500);
  });

  it('пересобранный путь не переписывает начало разговора', async () => {
    await handshakeOutgoing();
    tick(5_000);
    fireIce('connected');
    await settle();
    // Связь моргнула и вернулась — разговор тот же самый, и считается он с
    // первой секунды, когда собеседника стало слышно.
    tick(20_000);
    fireIce('disconnected');
    fireIce('connected');
    await settle();
    expect(getCurrentCall()?.connectedAt).toBe(T0 + 5_000);
  });
});

describe('у принимающего два события идут в обратном порядке', () => {
  it('ICE успел соединиться раньше, чем трубка договорила', async () => {
    // Ровно так и бывает на принимающей стороне: ICE отвечает быстрее, чем
    // `acceptCall` доходит до строки с «разговор идёт».
    // Часы после найденного пути ещё идут: подписать конверт и отправить
    // ответ — тоже время. Разговор считается с пути, а не с этой строки.
    pcHooks.beforeAnswer = () => { tick(700); fireIce('connected'); tick(5_000); };

    await handshakeIncoming();

    expect(getCurrentCall()?.state).toBe('connected');
    expect(getCurrentCall()?.connectedAt).toBe(T0 + 700);
  });

  it('ICE молчит — снятая трубка времени не даёт и здесь', async () => {
    await handshakeIncoming();
    expect(getCurrentCall()?.state).toBe('connected');
    expect(getCurrentCall()?.connectedAt).toBeNull();
  });
});

describe('журнал не выдаёт несостоявшийся разговор за состоявшийся', () => {
  it('трубку сняли, звука не было — «не соединились», без длительности', async () => {
    await handshakeOutgoing();
    tick(12_000);
    await hangupCall();
    await settle();
    expect(getCallLog()[0]).toMatchObject({
      peerPubB64: PEER,
      outcome: 'failed',
      durationMs: null,
    });
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: состоявшийся разговор по-прежнему «состоялся»', async () => {
    await handshakeOutgoing();
    fireIce('connected');
    await settle();
    tick(9_000);
    await hangupCall();
    await settle();
    expect(getCallLog()[0]).toMatchObject({ outcome: 'answered', durationMs: 9_000 });
  });

  it('длительность меряется от найденного пути, а не от ответа SDP', async () => {
    await handshakeOutgoing();
    // Две секунды между «трубку сняли» и «стало слышно» разговором не были.
    tick(2_000);
    fireIce('connected');
    await settle();
    tick(9_000);
    await hangupCall();
    await settle();
    expect(getCallLog()[0]).toMatchObject({ outcome: 'answered', durationMs: 9_000 });
  });

  it('никто не брал трубку — по-прежнему «пропущен»', async () => {
    await expect(initiateCall(PEER, 'сосед', false)).resolves.toBe(true);
    await settle();
    await hangupCall();
    await settle();
    expect(getCallLog()[0]).toMatchObject({ outcome: 'missed', durationMs: null });
  });

  it('отказ — по-прежнему «отклонён»', async () => {
    const offer = await sealOffer(peer, ME, { isVideo: false });
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: offer });
    await settle();
    await declineCall();
    await settle();
    expect(getCallLog()[0]).toMatchObject({ outcome: 'declined', durationMs: null });
  });
});

describe('отметка о пути принадлежит соединению, а не службе', () => {
  it('следующий звонок не наследует чужое время', async () => {
    await handshakeOutgoing();
    fireIce('connected');
    await settle();
    expect(getCurrentCall()?.connectedAt).toBe(T0);
    await hangupCall();
    await settle();

    // Второй звонок тому же человеку: путь для него ещё не искали.
    tick(30_000);
    await handshakeOutgoing();
    expect(getCurrentCall()?.state).toBe('connected');
    expect(getCurrentCall()?.connectedAt).toBeNull();
  });
});

describe('исход доезжает до экрана и переживает перезапуск', () => {
  it('«не соединились» подписано своим словом, а не чужим', () => {
    const screen = fs.readFileSync(
      path.join(__dirname, '../../../ui/screens/ProfileScreen.tsx'),
      'utf8',
    );
    // Подписать это «Нет ответа» значило бы обвинить собеседника в том,
    // чего он не делал: трубку он снял.
    expect(screen).toContain("? 'Не соединились'");
  });

  it('журнал с диска новый исход принимает, а выдуманный — нет', async () => {
    await disposeCallService();
    const rows = [
      { id: '1_aaaaaaaa', peerPubB64: PEER, peerName: 'сосед', isVideo: false, direction: 'outgoing', outcome: 'failed', startedAt: T0, durationMs: null },
      { id: '2_bbbbbbbb', peerPubB64: PEER, peerName: 'сосед', isVideo: false, direction: 'outgoing', outcome: 'улетел', startedAt: T0, durationMs: null },
    ];
    mockKvGetSecret.mockImplementation(async (key: string) =>
      (key === 'p1:call_log' ? JSON.stringify(rows) : null));

    await initCallService(me.pair);
    await settle();

    expect(getCallLog().map((e) => e.outcome)).toEqual(['failed']);
  });
});
