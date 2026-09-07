/**
 * Завершение звонка под подписью (v4.32.615).
 *
 * Предложение и ответ ходят под подписью с v4.32.585, а положить трубку за
 * собеседника сигнальный сервер по-прежнему мог: `fromPeerId` в событии он
 * проставляет сам, и другой проверки у завершения не было. Для соединённого
 * разговора это была последняя оставшаяся у него власть — медиа идёт напрямую,
 * слушать её он не может, а оборвать мог в любую секунду и сколько угодно раз.
 *
 * Конверт едет внутри объекта ICE-кандидата, рядом с прежним `type: 'hangup'`:
 * сервер пересылает кандидат как есть, поэтому менять его не пришлось, а
 * клиент прошлой версии по-прежнему кладёт трубку по одному только `type` и
 * лишнего поля не замечает.
 */
import {
  disposeCallService,
  getCurrentCall,
  hangupCall,
  initCallService,
  initiateCall,
} from '../callService';
import { envelopeBody, makePeer, sealAnswer, sealHangup, sealOffer, testCallId } from './callTestPeers';

type IceMsg = { fromPeerId?: string; candidate: unknown };
const mockOfferHandler: { current: ((msg: { fromPeerId: string; sdp: string }) => void) | null } = { current: null };
const mockIceHandler: { current: ((msg: IceMsg) => void) | null } = { current: null };
const mockHangupHandler: { current: ((msg: { fromPeerId?: string }) => void) | null } = { current: null };
const mockSendIce = jest.fn();
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
    sendAnswer = jest.fn();
    sendOffer = (room: string, peerId: string, sdp: string): void => { mockSendOffer(room, peerId, sdp); };
    sendIceCandidate = (peerId: string, candidate: unknown): void => { mockSendIce(peerId, candidate); };
    onOffer = (h: typeof mockOfferHandler.current): void => { mockOfferHandler.current = h; };
    onAnswer = jest.fn();
    onIceCandidate = (h: typeof mockIceHandler.current): void => { mockIceHandler.current = h; };
    onHangup = (h: typeof mockHangupHandler.current): void => { mockHangupHandler.current = h; };
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
const other = makePeer();
const ME = me.pub;
const PEER = peer.pub;
const CALL_ID = testCallId();

const settle = (): Promise<void> => jest.advanceTimersByTimeAsync(0);

/** Довести службу до звонящего входящего: с этого места есть что обрывать. */
async function ringIncoming(): Promise<void> {
  mockOfferHandler.current?.({
    fromPeerId: PEER,
    sdp: await sealOffer(peer, ME, { sdp: 'v=0\r\n', callId: CALL_ID }),
  });
  await settle();
  expect(getCurrentCall()?.state).toBe('incoming');
}

/** Прислать сентинел завершения от имени собеседника — как это делает сервер. */
async function deliverHangup(sealed?: unknown): Promise<void> {
  mockIceHandler.current?.({
    fromPeerId: PEER,
    candidate: sealed === undefined ? { type: 'hangup' } : { type: 'hangup', e: sealed },
  });
  await settle();
}

beforeEach(async () => {
  jest.useFakeTimers();
  await disposeCallService();
  mockOfferHandler.current = null;
  mockIceHandler.current = null;
  mockHangupHandler.current = null;
  mockSendIce.mockClear();
  mockSendOffer.mockClear();
  await initCallService(me.pair);
});

afterEach(async () => {
  await disposeCallService();
  jest.useRealTimers();
});

describe('подписанное завершение кладёт трубку', () => {
  it('конверт собеседника обрывает звонок', async () => {
    await ringIncoming();
    await deliverHangup(await sealHangup(peer, ME, { callId: CALL_ID }));
    // Звонок доживает недолгое «завершён» — это экран, а не разговор.
    expect(getCurrentCall()?.state).toBe('ended');
  });
});

describe('неподписанное завершение больше не проходит', () => {
  it('голый сентинел не обрывает звонок', async () => {
    await ringIncoming();
    await deliverHangup();
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('сервер подписал своим ключом, а назвался собеседником', async () => {
    await ringIncoming();
    await deliverHangup(await sealHangup(server, ME, { callId: CALL_ID }));
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('завершение прошлого звонка не обрывает текущий', async () => {
    await ringIncoming();
    await deliverHangup(await sealHangup(peer, ME, { callId: testCallId('b') }));
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('завершение, адресованное другому, нам не завершение', async () => {
    await ringIncoming();
    await deliverHangup(await sealHangup(peer, other, { callId: CALL_ID }));
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('подписанный отказ не годится за завершение', async () => {
    // Виды конвертов разделены намеренно: иначе отказом гасили бы разговор.
    await ringIncoming();
    await deliverHangup(await sealAnswer(peer, ME, { callId: CALL_ID, control: 'declined' }));
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('отдельное событие «hangup» сигнального сервера ничего не рвёт', async () => {
    await ringIncoming();
    expect(mockHangupHandler.current).not.toBeNull();
    mockHangupHandler.current?.({ fromPeerId: PEER });
    await settle();
    expect(getCurrentCall()?.state).toBe('incoming');
  });
});

describe('своё завершение уходит с конвертом', () => {
  it('в сентинеле едет подпись, а сам ключ type остаётся для старых клиентов', async () => {
    await initiateCall(PEER, 'кто-то', false);
    await settle();
    expect(getCurrentCall()?.state).toBe('outgoing');
    // Номер звонка виден только внутри конверта — берём из своего предложения.
    const sentOffer = mockSendOffer.mock.calls.at(-1)?.[2];
    const callId = envelopeBody(sentOffer).callId;
    expect(typeof callId).toBe('string');

    mockSendIce.mockClear();
    await hangupCall();
    await settle();

    const sentinel = mockSendIce.mock.calls
      .map((c) => c[1] as { type?: string; e?: unknown })
      .find((c) => c?.type === 'hangup');
    expect(sentinel).toBeDefined();
    expect(typeof sentinel?.e).toBe('string');
    expect(envelopeBody(sentinel?.e)).toMatchObject({
      kind: 'hangup',
      from: ME,
      to: PEER,
      callId,
    });
  });
});
