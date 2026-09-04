/**
 * Сигнализация звонка под подписью (v4.32.585).
 *
 * Сигнальный сервер в модели угроз недоверенный, но до этой версии он был
 * недоверенным только на словах: `fromPeerId` в событии проставлял он сам, а
 * SDP шёл голым. А в SDP лежит `a=fingerprint` — отпечаток DTLS. Значит сервер
 * мог прислать Борису «предложение от Алисы» со своим отпечатком, Алисе —
 * «ответ от Бориса» со вторым своим, и оказаться посередине двух совершенно
 * исправных шифрованных соединений: оба видят имя собеседника, оба видят
 * замок, и оба разговаривают через сервер, который слышит всё.
 *
 * Здесь проверяется, что подделка больше не проходит ни в одном из четырёх
 * видов: чужая подпись, чужой адресат, отсутствие подписи вовсе и выдуманный
 * сервером отказ, которым он мог оборвать любой звонок.
 */
import {
  acceptCall,
  disposeCallService,
  getCurrentCall,
  initCallService,
  initiateCall,
} from '../callService';
import { envelopeBody, makePeer, sealAnswer, sealOffer, testCallId } from './callTestPeers';

const mockOfferHandler: { current: ((msg: { fromPeerId: string; sdp: string }) => void) | null } = { current: null };
const mockAnswerHandler: { current: ((msg: { fromPeerId?: string; sdp: string }) => void) | null } = { current: null };
const mockSendAnswer = jest.fn();
const mockSendOffer = jest.fn();

const mockAudioTrack = { enabled: true, stop: jest.fn() };
const mockLocalStream = {
  getTracks: () => [mockAudioTrack],
  getAudioTracks: () => [mockAudioTrack],
  getVideoTracks: () => [],
};

class MockPeerConnection {
  ontrack: ((event: { streams?: unknown[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  remoteDescription: unknown = null;
  addTrack = jest.fn();
  close = jest.fn();
  constructor(_config: unknown) { void _config; }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(d: unknown): Promise<void> { void d; }
  async setRemoteDescription(d: unknown): Promise<void> { this.remoteDescription = d; }
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
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendHangup = jest.fn();
    sendIceCandidate = jest.fn();
    sendAnswer = (peer: string, sdp: string): void => { mockSendAnswer(peer, sdp); };
    sendOffer = (room: string, peer: string, sdp: string): void => { mockSendOffer(room, peer, sdp); };
    onOffer = (h: typeof mockOfferHandler.current): void => { mockOfferHandler.current = h; };
    onAnswer = (h: typeof mockAnswerHandler.current): void => { mockAnswerHandler.current = h; };
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

const me = makePeer();
const peer = makePeer();
const server = makePeer();
const ME = me.pub;
const PEER = peer.pub;

const settle = (): Promise<void> => jest.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  jest.useFakeTimers();
  await disposeCallService();
  mockOfferHandler.current = null;
  mockAnswerHandler.current = null;
  mockSendAnswer.mockClear();
  mockSendOffer.mockClear();
  await initCallService(ME, me.pair);
});

afterEach(async () => {
  await disposeCallService();
  jest.useRealTimers();
});

describe('предложение без подписи собеседника не звонит', () => {
  it('сервер подписал своим ключом, а назвался собеседником', async () => {
    // Ровно посадка посередине: своё имя в поле `from`, свой отпечаток в SDP.
    const forged = await sealOffer(server, ME, { sdp: 'v=0\r\na=fingerprint:MITM\r\n' });
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: forged });
    await settle();

    expect(getCurrentCall()).toBeNull();
    // И даже «занято» не уходит: ответ подтвердил бы, что телефон на связи.
    expect(mockSendAnswer).not.toHaveBeenCalled();
  });

  it('чужое предложение, переадресованное нам, не годится', async () => {
    // Конверт настоящий и подписан собеседником — но адресован не нам.
    const elsewhere = await sealOffer(peer, server.pub, {});
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: elsewhere });
    await settle();

    expect(getCurrentCall()).toBeNull();
  });

  it('предложение старого образца — голый JSON — больше не принимается', async () => {
    mockOfferHandler.current?.({
      fromPeerId: PEER,
      sdp: JSON.stringify({ sdp: 'remote-offer-sdp', isVideo: false, callId: testCallId() }),
    });
    await settle();

    expect(getCurrentCall()).toBeNull();
  });

  it('а подписанное собеседником — звонит, и ответ уходит подписанным', async () => {
    const callId = testCallId('c');
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: await sealOffer(peer, ME, { callId }) });
    await settle();
    expect(getCurrentCall()).toMatchObject({ state: 'incoming', peerPubB64: PEER });

    await expect(acceptCall()).resolves.toBe(true);
    await settle();

    const [to, body] = mockSendAnswer.mock.calls.at(-1) as [string, string];
    expect(to).toBe(PEER);
    expect(envelopeBody(body)).toMatchObject({
      kind: 'answer', from: ME, to: PEER, callId, sdp: 'answer-sdp',
    });
  });
});

describe('ответ без подписи собеседника не рвёт звонок', () => {
  async function callOut(): Promise<string> {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await settle();
    return String(envelopeBody(mockSendOffer.mock.calls.at(-1)?.[2]).callId);
  }

  it('выдуманное сервером «занято» звонок не обрывает', async () => {
    await callOut();
    // Прежде это была голая строка 'busy' — сервер печатал её и клал трубку
    // за собеседника.
    mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: 'busy' });
    await settle();

    expect(getCurrentCall()?.state).toBe('outgoing');
  });

  it('«отклонён», подписанный чужим ключом, тоже не проходит', async () => {
    const callId = await callOut();
    const forged = await sealAnswer(server, ME, { callId, control: 'declined' });
    mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: forged });
    await settle();

    expect(getCurrentCall()?.state).toBe('outgoing');
  });

  it('ответ от прошлого звонка не подхватывается текущим', async () => {
    await callOut();
    const stale = await sealAnswer(peer, ME, { callId: testCallId('f'), sdp: 'remote-answer-sdp' });
    mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: stale });
    await settle();

    expect(getCurrentCall()?.state).toBe('outgoing');
  });

  it('свой подписанный отказ звонок завершает', async () => {
    const callId = await callOut();
    const decline = await sealAnswer(peer, ME, { callId, control: 'declined' });
    mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: decline });
    await settle();

    expect(getCurrentCall()?.state).toBe('ended');
  });
});
