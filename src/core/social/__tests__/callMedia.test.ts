import {
  disposeCallService,
  getCallMedia,
  getCurrentCall,
  hangupCall,
  initCallService,
  initiateCall,
  subscribeCallMedia,
  switchCamera,
  toggleCamera,
} from '../callService';

const mockOfferHandler: { current: ((msg: { fromPeerId: string; sdp: string }) => void) | null } = { current: null };
const mockHangupHandler: { current: ((msg: { fromPeerId?: string }) => void) | null } = { current: null };
const mockAnswerHandler: { current: ((msg: { fromPeerId: string; sdp: string }) => void) | null } = { current: null };
const mockPeerConnections: MockPeerConnection[] = [];
const mockSendHangup = jest.fn();
const mockSendIceCandidate = jest.fn();
const mockSendAnswer = jest.fn();
const mockSendOffer = jest.fn();
const mockRegister = jest.fn();

const mockAudioTrack = { enabled: true, stop: jest.fn() };
const mockFrontVideoTrack = { enabled: true, facing: 'front', _switchCamera: jest.fn(), stop: jest.fn() };
const mockRearVideoTrack = { enabled: true, facing: 'environment', _switchCamera: jest.fn(), stop: jest.fn() };
const mockLocalStream = {
  getTracks: () => [mockAudioTrack, mockFrontVideoTrack, mockRearVideoTrack],
  getAudioTracks: () => [mockAudioTrack],
  getVideoTracks: () => [mockFrontVideoTrack, mockRearVideoTrack],
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
  mediaDevices: {
    getUserMedia: mockGetUserMedia,
  },
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = mockRegister;
    disconnect = jest.fn();
    sendHangup = (peer: string): void => { mockSendHangup(peer); };
    sendIceCandidate = (peer: string, candidate: unknown): void => { mockSendIceCandidate(peer, candidate); };
    sendAnswer = (peer: string, sdp: string): void => { mockSendAnswer(peer, sdp); };
    sendOffer = (room: string, peer: string, sdp: string): void => { mockSendOffer(room, peer, sdp); };
    onOffer = (handler: typeof mockOfferHandler.current): void => { mockOfferHandler.current = handler; };
    onAnswer = (handler: typeof mockAnswerHandler.current): void => { mockAnswerHandler.current = handler; };
    onIceCandidate = jest.fn();
    onHangup = (handler: typeof mockHangupHandler.current): void => { mockHangupHandler.current = handler; };
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

const ME = 'M'.repeat(43);
const PEER = 'A'.repeat(43);
const TEST_PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  disposeCallService();
  mockOfferHandler.current = null;
  mockHangupHandler.current = null;
  mockAnswerHandler.current = null;
  mockPeerConnections.length = 0;
  mockSendHangup.mockClear();
  mockSendIceCandidate.mockClear();
  mockSendAnswer.mockClear();
  mockSendOffer.mockClear();
  mockRegister.mockClear();
  mockAudioTrack.enabled = true;
  mockFrontVideoTrack.enabled = true;
  mockRearVideoTrack.enabled = true;
  mockFrontVideoTrack._switchCamera.mockClear();
  mockRearVideoTrack._switchCamera.mockClear();
  mockGetUserMedia.mockClear();
  mockAudioTrack.stop.mockClear();
  mockFrontVideoTrack.stop.mockClear();
  mockRearVideoTrack.stop.mockClear();
  await initCallService(ME, TEST_PAIR);
});

afterEach(() => {
  disposeCallService();
});

describe('call media layer', () => {
  it('publishes local and remote streams and toggles only the front camera track', async () => {
    const snapshots: ReturnType<typeof getCallMedia>[] = [];
    const unsubscribe = subscribeCallMedia((media) => snapshots.push(media));

    await expect(initiateCall(PEER, 'peer', true)).resolves.toBe(true);
    expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith(ME, ME, TEST_PAIR);
    expect(mockSendOffer).toHaveBeenCalledWith(ME, PEER, expect.any(String));
    expect(getCallMedia().localStream).toBe(mockLocalStream);

    const remoteTrack = { stop: jest.fn() };
    const remoteStream = { getTracks: () => [remoteTrack] };
    mockPeerConnections[0]?.ontrack?.({ streams: [remoteStream] });

    expect(getCallMedia().remoteStream).toBe(remoteStream);
    expect(snapshots.some((media) => media.remoteStream === remoteStream)).toBe(true);
    expect(toggleCamera()).toBe(false);
    expect(mockFrontVideoTrack.enabled).toBe(false);
    expect(mockRearVideoTrack.enabled).toBe(true);
    expect(switchCamera()).toBe(true);
    expect(mockFrontVideoTrack._switchCamera).toHaveBeenCalledTimes(1);
    expect(mockRearVideoTrack._switchCamera).not.toHaveBeenCalled();
    expect(toggleCamera()).toBe(true);
    expect(mockFrontVideoTrack.enabled).toBe(true);

    unsubscribe();
  });

  it('rejects a parsed offer with an invalid inner SDP instead of handing JSON to WebRTC', async () => {
    mockOfferHandler.current?.({
      fromPeerId: PEER,
      sdp: JSON.stringify({ sdp: null, isVideo: true }),
    });
    await settle();

    expect(getCurrentCall()).toBeNull();
  });

  it('sends first-class and legacy hangup signals, then stops both streams', async () => {
    await expect(initiateCall(PEER, 'peer', true)).resolves.toBe(true);
    const remoteTrack = { stop: jest.fn() };
    const remoteStream = { getTracks: () => [remoteTrack] };
    mockPeerConnections[0]?.ontrack?.({ streams: [remoteStream] });

    await hangupCall();

    expect(mockSendHangup).toHaveBeenCalledWith(PEER);
    expect(mockSendIceCandidate).toHaveBeenCalledWith(PEER, { type: 'hangup' });
    expect(mockAudioTrack.stop).toHaveBeenCalled();
    expect(mockFrontVideoTrack.stop).toHaveBeenCalled();
    expect(remoteTrack.stop).toHaveBeenCalled();
    expect(mockPeerConnections[0]?.close).toHaveBeenCalled();
    expect(getCallMedia()).toMatchObject({ localStream: null, remoteStream: null });
  });

  it('accepts a first-class remote hangup and dispose cleans streams synchronously', async () => {
    mockOfferHandler.current?.({ fromPeerId: PEER, sdp: JSON.stringify({ sdp: 'offer-sdp', isVideo: true }) });
    await settle();
    expect(mockHangupHandler.current).not.toBeNull();
    mockHangupHandler.current?.({ fromPeerId: PEER });
    await settle();
    expect(getCallMedia()).toMatchObject({ localStream: null, remoteStream: null });

    await expect(initiateCall(PEER, 'peer', true)).resolves.toBe(true);
    const remoteTrack = { stop: jest.fn() };
    mockPeerConnections[mockPeerConnections.length - 1]?.ontrack?.({ streams: [{ getTracks: () => [remoteTrack] }] });
    disposeCallService();

    expect(mockAudioTrack.stop).toHaveBeenCalled();
    expect(remoteTrack.stop).toHaveBeenCalled();
    expect(getCallMedia()).toMatchObject({ localStream: null, remoteStream: null });
  });
});
