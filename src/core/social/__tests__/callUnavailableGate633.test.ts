/**
 * Сигнальный сервер не кончает чужой разговор (v4.32.633).
 *
 * Две дыры одного рода. Первая: событие `peer_unavailable` сервер сочиняет сам
 * — подписи в нём нет, `targetPeerId` в нём тоже его собственный, — а по этому
 * событию звонок обрывался со словом «Недоступен». Повторяя его, сервер сделал
 * бы разговор между двумя людьми невозможным, и выглядело бы это как плохая
 * связь. Ровно этот довод в файле уже разобран для события `hangup`, но на
 * `peer_unavailable` распространён не был.
 *
 * Вторая: номер звонка присваивался только перед отправкой предложения — после
 * прогрева микрофона, запроса ICE-серверов по сети и подписи конверта. Всё это
 * время ожидаемый номер в проверку конверта не подставлялся, то есть не
 * сверялся, и сервер мог переиграть в это окно подписанный «Отклонён» от
 * прошлого звонка тому же собеседнику. Человек видел отказ, которого не было.
 */
import {
  disposeCallService,
  getCurrentCall,
  initCallService,
  initiateCall,
} from '../callService';
import { envelopeBody, makePeer, sealAnswer, sealOffer, testCallId } from './callTestPeers';

type OfferMsg = { fromPeerId: string; sdp: string };
type AnswerMsg = { fromPeerId: string; sdp: string };
type UnavailableMsg = { targetPeerId: string; roomId: string };

const mockOfferHandler: { current: ((msg: OfferMsg) => void) | null } = { current: null };
const mockAnswerHandler: { current: ((msg: AnswerMsg) => void) | null } = { current: null };
const mockUnavailableHandler: { current: ((msg: UnavailableMsg) => void) | null } = { current: null };
const mockSendHangup = jest.fn();
const mockSendIceCandidate = jest.fn();
const mockSendAnswer = jest.fn();
const mockSendOffer = jest.fn();
const mockSendMissedReceipt = jest.fn();
const mockSendCallPush = jest.fn(async () => undefined);
const mockCancelNotification = jest.fn(async () => undefined);
const mockNotifyMissedCall = jest.fn(async () => undefined);

const mockAudioTrack = { enabled: true, stop: jest.fn() };
const mockLocalStream = {
  getTracks: () => [mockAudioTrack],
  getAudioTracks: () => [mockAudioTrack],
  getVideoTracks: () => [],
};
const mockGetUserMedia = jest.fn(async () => mockLocalStream);

class MockPeerConnection {
  ontrack: ((event: { streams?: unknown[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  remoteDescription: unknown = null;
  addTrack = jest.fn();
  close = jest.fn();

  constructor(_config: unknown) { void _config; }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
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
    sendMissedReceipt = (peer: string, e: string): void => { mockSendMissedReceipt(peer, e); };
    onOffer = (handler: typeof mockOfferHandler.current): void => { mockOfferHandler.current = handler; };
    onAnswer = (handler: typeof mockAnswerHandler.current): void => { mockAnswerHandler.current = handler; };
    onIceCandidate = jest.fn();
    onHangup = jest.fn();
    onPeerUnavailable = (handler: typeof mockUnavailableHandler.current): void => {
      mockUnavailableHandler.current = handler;
    };
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

const me = makePeer();
const peer = makePeer();
const ME = me.pub;
const PEER = peer.pub;

/** Прокрутить очередь микрозадач, не двигая часы. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await jest.advanceTimersByTimeAsync(0);
}

/** Номер звонка из последнего ушедшего предложения. */
function lastOfferCallId(): string {
  const call = mockSendOffer.mock.calls.at(-1);
  return String((envelopeBody(call?.[2]) as { callId?: string }).callId);
}

/** Сказать нам то, что говорит сервер про телефон вне сети. */
async function serverSaysUnavailable(): Promise<void> {
  mockUnavailableHandler.current?.({ targetPeerId: PEER, roomId: PEER });
  await settle();
}

describe('сигнальный сервер не кончает чужой разговор', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await disposeCallService();
    mockOfferHandler.current = null;
    mockAnswerHandler.current = null;
    mockUnavailableHandler.current = null;
    mockSendHangup.mockClear();
    mockSendIceCandidate.mockClear();
    mockSendAnswer.mockClear();
    mockSendOffer.mockClear();
    mockSendMissedReceipt.mockClear();
    mockSendCallPush.mockClear();
    mockCancelNotification.mockClear();
    mockNotifyMissedCall.mockClear();
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

  /** Довести исходящий звонок до разговора. */
  async function connectOutgoing(): Promise<void> {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await settle();
    const answer = await sealAnswer(peer, ME, { callId: lastOfferCallId() });
    mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: answer });
    await settle();
    expect(getCurrentCall()?.state).toBe('connected');
  }

  it('ПРОВЕРКА НЕ ПУСТАЯ: событие сервера доходит до нас, а звонки заводятся', async () => {
    expect(mockUnavailableHandler.current).not.toBeNull();
    expect(mockAnswerHandler.current).not.toBeNull();
    expect(mockOfferHandler.current).not.toBeNull();
    await connectOutgoing();
  });

  it('слово сервера не обрывает начавшийся разговор', async () => {
    await connectOutgoing();

    await serverSaysUnavailable();

    // Настоящий обрыв закроет сторож ICE; выдумке сервера верить нечему.
    expect(getCurrentCall()?.state).toBe('connected');
  });

  it('слово сервера не гасит звонящий телефон', async () => {
    const offer = await sealOffer(peer, ME, { isVideo: false });
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: offer });
    await settle();
    expect(getCurrentCall()?.state).toBe('incoming');

    await serverSaysUnavailable();

    // Пропавший звонящий кончится сроком дозвона, а не словом сервера.
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: отказ с номером текущего звонка звонок кончает', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await settle();

    const decline = await sealAnswer(peer, ME, {
      control: 'declined',
      callId: lastOfferCallId(),
    });
    mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: decline });
    await settle();

    expect(getCurrentCall()?.state).toBe('ended');
  });

  it('старый «Отклонён» не проскакивает, пока греется микрофон', async () => {
    const stale = await sealAnswer(peer, ME, {
      control: 'declined',
      callId: testCallId('c'),
    });
    // Отказ приезжает ровно в том окне, где номер звонка ещё не был присвоен.
    mockGetUserMedia.mockImplementationOnce(async () => {
      mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: stale });
      await settle();
      return mockLocalStream;
    });

    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await settle();

    expect(getCurrentCall()?.state).toBe('outgoing');
    expect(lastOfferCallId()).not.toBe(testCallId('c'));
  });
});
