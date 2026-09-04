/**
 * Звонок доходит до закрытого приложения (v4.32.573).
 *
 * До этой версии звонок жил ровно на живом сокете получателя. У свёрнутого или
 * закрытого приложения сокета нет, сервер отвечал звонящему `peer_unavailable`,
 * и звонок обрывался на первой секунде словом «Недоступен»: дозвониться можно
 * было только до человека, который и так смотрит в телефон.
 *
 * Починка состоит из двух частей, и здесь проверяются обе. Push будит
 * устройство — в нём едет только случайный номер звонка, sdp по этой дороге не
 * ходит, потому что несёт адреса устройства. И предложение повторяется по
 * сокету, пока телефон не появится в сети или пока не выйдет обычный срок
 * дозвона.
 */
import { OUTGOING_RINGING_TIMEOUT_MS } from '../callTeardown';
import {
  disposeCallService,
  getCallLog,
  getCurrentCall,
  initCallService,
  initiateCall,
} from '../callService';
import { envelopeBody, makePeer, sealOffer, testCallId } from './callTestPeers';

type OfferMsg = { fromPeerId: string; sdp: string };
type UnavailableMsg = { targetPeerId: string; roomId: string };
type MissedMsg = { calls: Array<{ fromPeerId: string; at: number; attempts: number }> };

const mockOfferHandler: { current: ((msg: OfferMsg) => void) | null } = { current: null };
const mockUnavailableHandler: { current: ((msg: UnavailableMsg) => void) | null } = { current: null };
const mockMissedHandler: { current: ((msg: MissedMsg) => void) | null } = { current: null };
const mockPeerConnections: MockPeerConnection[] = [];
const mockSendHangup = jest.fn();
const mockSendIceCandidate = jest.fn();
const mockSendAnswer = jest.fn();
const mockSendOffer = jest.fn();
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

  constructor(_config: unknown) {
    mockPeerConnections.push(this);
  }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(description: unknown): Promise<void> {
    void description;
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(_candidate: unknown): Promise<void> {
    return undefined;
  }
}

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: MockPeerConnection,
  RTCSessionDescription: class {
    constructor(value: unknown) { void value; }
  },
  RTCIceCandidate: class {
    constructor(value: unknown) { void value; }
  },
  mediaDevices: { getUserMedia: mockGetUserMedia },
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendHangup = (peer: string): void => { mockSendHangup(peer); };
    sendIceCandidate = (peer: string, candidate: unknown): void => { mockSendIceCandidate(peer, candidate); };
    sendAnswer = (peer: string, sdp: string): void => { mockSendAnswer(peer, sdp); };
    sendOffer = (room: string, peer: string, sdp: string): void => { mockSendOffer(room, peer, sdp); };
    onOffer = (handler: typeof mockOfferHandler.current): void => { mockOfferHandler.current = handler; };
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onHangup = jest.fn();
    onPeerUnavailable = (handler: typeof mockUnavailableHandler.current): void => {
      mockUnavailableHandler.current = handler;
    };
    onMissedCalls = (handler: typeof mockMissedHandler.current): void => {
      mockMissedHandler.current = handler;
    };
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
  // Push уходит через динамический import — до него очередь доходит не с
  // первого оборота, поэтому крутим её несколько раз.
  for (let i = 0; i < 8; i += 1) await jest.advanceTimersByTimeAsync(0);
}

/** Тело последнего ушедшего предложения. */
function lastOfferBody(): { sdp?: string; isVideo?: boolean; callId?: string } {
  const call = mockSendOffer.mock.calls.at(-1);
  return envelopeBody(call?.[2]) as { sdp?: string; isVideo?: boolean; callId?: string };
}

/** Сказать звонящему то, что говорит сервер про телефон вне сети. */
async function peerOffline(): Promise<void> {
  mockUnavailableHandler.current?.({ targetPeerId: PEER, roomId: PEER });
  await settle();
}

describe('дозвон до телефона, которого нет в сети', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await disposeCallService();
    mockOfferHandler.current = null;
    mockUnavailableHandler.current = null;
    mockPeerConnections.length = 0;
    mockSendHangup.mockClear();
    mockSendIceCandidate.mockClear();
    mockSendAnswer.mockClear();
    mockSendOffer.mockClear();
    mockSendCallPush.mockClear();
    mockCancelNotification.mockClear();
    mockNotifyMissedCall.mockClear();
    mockGetUserMedia.mockClear();
    mockAudioTrack.enabled = true;
    mockAudioTrack.stop.mockClear();
    await initCallService(ME, me.pair);
  });

  afterEach(async () => {
    await disposeCallService();
    jest.useRealTimers();
  });

  it('исходящий звонок будит устройство push-ом', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await settle();

    expect(mockSendCallPush).toHaveBeenCalledTimes(1);
    const [recipientDid, callId, senderDid] = mockSendCallPush.mock.calls[0] as unknown as string[];
    expect(recipientDid).toMatch(/^did:key:z/);
    expect(senderDid).toMatch(/^did:key:z/);
    expect(recipientDid).not.toBe(senderDid);
    // Номер звонка — тот же, что уехал внутри предложения: по нему получатель
    // и погасит баннер, когда предложение доедет.
    expect(callId).toMatch(/^[a-f0-9]{32}$/);
    expect(lastOfferBody().callId).toBe(callId);
  });

  it('sdp по дороге push не едет', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await settle();

    // Три аргумента и ни одного лишнего: адреса устройства на сервере не оседают.
    const args = mockSendCallPush.mock.calls[0] as unknown as string[];
    expect(args).toHaveLength(3);
    for (const arg of args) {
      expect(String(arg)).not.toContain('offer-sdp');
    }
  });

  it('«нет в сети» больше не обрывает звонок', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await peerOffline();

    // Ровно эта строчка и была дефектом: раньше здесь было 'ended'/«Недоступен».
    expect(getCurrentCall()?.state).toBe('outgoing');
    expect(mockSendHangup).not.toHaveBeenCalled();
  });

  it('предложение повторяется, пока телефон не появится', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await peerOffline();
    const sentAtStart = mockSendOffer.mock.calls.length;

    await jest.advanceTimersByTimeAsync(3000 * 3);

    expect(mockSendOffer.mock.calls.length).toBeGreaterThan(sentAtStart);
    // Повторяем то же самое предложение с тем же номером звонка, а не новое:
    // иначе у получателя каждый раз звонил бы новый звонок.
    const bodies = mockSendOffer.mock.calls.map((c) => String(c[2]));
    expect(new Set(bodies).size).toBe(1);
    expect(mockSendCallPush).toHaveBeenCalledTimes(1);
  });

  it('повторы кончаются вместе со звонком', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await peerOffline();

    await jest.advanceTimersByTimeAsync(OUTGOING_RINGING_TIMEOUT_MS);
    expect(getCurrentCall()?.state).toBe('ended');
    const afterTimeout = mockSendOffer.mock.calls.length;

    await jest.advanceTimersByTimeAsync(3000 * 5);
    expect(mockSendOffer.mock.calls.length).toBe(afterTimeout);
  });

  it('повтор, дошедший до звонящего телефона, не получает «занято»', async () => {
    const offer = await sealOffer(peer, ME, { isVideo: false });
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: offer });
    await settle();
    expect(getCurrentCall()?.state).toBe('incoming');

    mockSendAnswer.mockClear();
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: offer });
    await settle();

    // Ответить «занято» на собственный повтор значило бы оборвать ровно тот
    // звонок, который только что зазвонил.
    expect(mockSendAnswer).not.toHaveBeenCalled();
    expect(getCurrentCall()?.state).toBe('incoming');
  });

  it('дошедшее предложение гасит баннер, поднятый push-ом', async () => {
    const callId = testCallId('b');
    mockOfferHandler.current?.({
      fromPeerId: PEER,
      sdp: await sealOffer(peer, ME, { isVideo: false, callId }),
    });
    await settle();

    expect(mockCancelNotification).toHaveBeenCalledWith(`call:${callId}`);
  });

  it('чужой звонок во время нашего по-прежнему получает «занято»', async () => {
    const other = makePeer();
    mockOfferHandler.current?.({
      fromPeerId: PEER,
      sdp: await sealOffer(peer, ME, { isVideo: false }),
    });
    await settle();

    const otherCallId = testCallId('c');
    mockOfferHandler.current?.({
      fromPeerId: other.pub,
      sdp: await sealOffer(other, ME, { sdp: 'other-offer-sdp', isVideo: false, callId: otherCallId }),
    });
    await settle();

    // «Занято» тоже подписано — и своим номером звонка, а не номером нашего.
    const [to, body] = mockSendAnswer.mock.calls.at(-1) as [string, string];
    expect(to).toBe(other.pub);
    expect(envelopeBody(body)).toMatchObject({
      kind: 'answer', from: ME, to: other.pub, control: 'busy', callId: otherCallId,
    });
  });

  it('звонок, случившийся без нас, приезжает в журнал при следующем входе', async () => {
    const at = Date.now() - 60_000;
    mockMissedHandler.current?.({ calls: [{ fromPeerId: PEER, at, attempts: 4 }] });
    await settle();
    await settle();

    const [entry] = getCallLog();
    expect(entry).toMatchObject({
      peerPubB64: PEER,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: at,
      durationMs: null,
    });
    // Четыре повтора одного звонка — одна запись, а не четыре.
    expect(getCallLog()).toHaveLength(1);
    expect(mockNotifyMissedCall).toHaveBeenCalledWith({ count: 1 });
  });

  it('повторная доставка того же журнала не раздваивает звонок', async () => {
    const at = Date.now() - 60_000;
    mockMissedHandler.current?.({ calls: [{ fromPeerId: PEER, at, attempts: 1 }] });
    await settle();
    mockNotifyMissedCall.mockClear();
    mockMissedHandler.current?.({ calls: [{ fromPeerId: PEER, at, attempts: 1 }] });
    await settle();

    expect(getCallLog()).toHaveLength(1);
    expect(mockNotifyMissedCall).not.toHaveBeenCalled();
  });

  it('о звонке, который идёт прямо сейчас, «вам звонили» не пишется', async () => {
    mockOfferHandler.current?.({
      fromPeerId: PEER,
      sdp: await sealOffer(peer, ME, { isVideo: false }),
    });
    await settle();
    expect(getCurrentCall()?.state).toBe('incoming');

    mockMissedHandler.current?.({ calls: [{ fromPeerId: PEER, at: Date.now(), attempts: 1 }] });
    await settle();

    expect(getCallLog()).toHaveLength(0);
    expect(mockNotifyMissedCall).not.toHaveBeenCalled();
  });
});
