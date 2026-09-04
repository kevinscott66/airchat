/**
 * v4.32.549 — завершение звонка обязано доходить до собеседника, а звонок,
 * которого не берут, обязан когда-нибудь кончиться сам.
 *
 * Дефект был двойной. Сигнал «положили трубку» слал только `hangupCall`, то
 * есть нажатие человека; сорокапятисекундный срок дозвона, отказ ICE, разрыв и
 * неудачный запуск рвали звонок молча — телефон собеседника при этом продолжал
 * звонить. И симметрично: у входящего звонка не было срока вообще, поэтому
 * исчезнувший звонящий оставлял экран входящего звонка навсегда.
 */
import fs from 'fs';
import path from 'path';

import {
  INCOMING_RINGING_TIMEOUT_MS,
  OUTGOING_RINGING_TIMEOUT_MS,
  isLiveCallState,
  ringingTimeoutMs,
  shouldNotifyPeer,
  type CallStateName,
  type TeardownOrigin,
} from '../callTeardown';
import {
  acceptCall,
  disposeCallService,
  getCurrentCall,
  hangupCall,
  initCallService,
  initiateCall,
} from '../callService';
import { envelopeBody, makePeer, sealAnswer, sealOffer, testCallId } from './callTestPeers';

const mockOfferHandler: { current: ((msg: { fromPeerId: string; sdp: string }) => void) | null } = { current: null };
const mockHangupHandler: { current: ((msg: { fromPeerId?: string }) => void) | null } = { current: null };
const mockAnswerHandler: { current: ((msg: { fromPeerId?: string; sdp: string }) => void) | null } = { current: null };
const mockPeerConnections: MockPeerConnection[] = [];
const mockSendHangup = jest.fn();
const mockSendIceCandidate = jest.fn();
const mockSendAnswer = jest.fn();
const mockSendOffer = jest.fn();

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
  mediaDevices: {
    getUserMedia: mockGetUserMedia,
  },
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

const me = makePeer();
const peer = makePeer();
const ME = me.pub;
const PEER = peer.pub;

/** Прокрутить очередь микрозадач, не двигая часы. */
function settle(): Promise<void> {
  return jest.advanceTimersByTimeAsync(0);
}

/** Изобразить входящий звонок так, как его присылает сигнальный сервер. */
async function receiveOffer(callId = testCallId()): Promise<void> {
  mockOfferHandler.current?.({
    fromPeerId: PEER,
    sdp: await sealOffer(peer, ME, { isVideo: false, callId }),
  });
  await settle();
}

const STATES: CallStateName[] = ['idle', 'incoming', 'outgoing', 'connected', 'ended'];
const ORIGINS: TeardownOrigin[] = ['local', 'remote'];

const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'callService.ts'), 'utf8');
const MODULE = fs.readFileSync(path.join(__dirname, '..', 'callTeardown.ts'), 'utf8');

function bodyOf(src: string, head: string): string {
  const start = src.indexOf(`\n${head}`);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

const HANGUP_BODY = (): string => bodyOf(SERVICE, 'async function _hangup(');
const HANGUP_CALL_BODY = (): string => bodyOf(SERVICE, 'export async function hangupCall(');
const DISPOSE_BODY = (): string => bodyOf(SERVICE, 'export async function disposeCallService(');

describe('правило: кого предупреждать о конце звонка', () => {
  it('о нашем завершении собеседник узнаёт в любом живом состоянии', () => {
    expect(shouldNotifyPeer('outgoing', 'local')).toBe(true);
    expect(shouldNotifyPeer('incoming', 'local')).toBe(true);
    expect(shouldNotifyPeer('connected', 'local')).toBe(true);
  });

  it('завершение, пришедшее от собеседника, назад не отзеркаливается', () => {
    for (const state of STATES) {
      expect(shouldNotifyPeer(state, 'remote')).toBe(false);
    }
  });

  it('звонка нет — предупреждать не о чем', () => {
    expect(shouldNotifyPeer('idle', 'local')).toBe(false);
    expect(shouldNotifyPeer('ended', 'local')).toBe(false);
  });

  it('предупреждаем ровно в живых состояниях и только по своей воле', () => {
    for (const state of STATES) {
      for (const origin of ORIGINS) {
        expect(shouldNotifyPeer(state, origin)).toBe(origin === 'local' && isLiveCallState(state));
      }
    }
  });

  it('живые состояния — те, где у собеседника занят экран', () => {
    expect(STATES.filter(isLiveCallState)).toEqual(['incoming', 'outgoing', 'connected']);
  });
});

describe('правило: сроки звонка', () => {
  it('срок есть только у звонящих состояний', () => {
    expect(ringingTimeoutMs('outgoing')).toBe(OUTGOING_RINGING_TIMEOUT_MS);
    expect(ringingTimeoutMs('incoming')).toBe(INCOMING_RINGING_TIMEOUT_MS);
    expect(ringingTimeoutMs('connected')).toBeNull();
    expect(ringingTimeoutMs('idle')).toBeNull();
    expect(ringingTimeoutMs('ended')).toBeNull();
  });

  it('входящий держится дольше исходящего — иначе надпись у собеседника соврёт', () => {
    // Первым обязан сдаться звонящий: тогда мы закрываем звонок как
    // «завершён собеседником». При равных сроках мы успевали бы ответить
    // «отклонён» человеку, которому просто не взяли трубку.
    expect(INCOMING_RINGING_TIMEOUT_MS).toBeGreaterThan(OUTGOING_RINGING_TIMEOUT_MS);
  });

  it('срок положительный и конечный', () => {
    for (const ms of [OUTGOING_RINGING_TIMEOUT_MS, INCOMING_RINGING_TIMEOUT_MS]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  });
});

describe('поведение сервиса звонков', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await disposeCallService();
    mockOfferHandler.current = null;
    mockHangupHandler.current = null;
    mockAnswerHandler.current = null;
    mockPeerConnections.length = 0;
    mockSendHangup.mockClear();
    mockSendIceCandidate.mockClear();
    mockSendAnswer.mockClear();
    mockSendOffer.mockClear();
    mockGetUserMedia.mockClear();
    mockAudioTrack.enabled = true;
    mockAudioTrack.stop.mockClear();
    await initCallService(ME, me.pair);
  });

  afterEach(async () => {
    await disposeCallService();
    jest.useRealTimers();
  });

  it('исходящий, на который не ответили, гасит звонок и НА ТОМ КОНЦЕ ТОЖЕ', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    expect(getCurrentCall()?.state).toBe('outgoing');
    mockSendHangup.mockClear();

    await jest.advanceTimersByTimeAsync(OUTGOING_RINGING_TIMEOUT_MS);

    expect(getCurrentCall()?.state).toBe('ended');
    // Это и есть починка: раньше здесь не уходило ничего, и телефон
    // собеседника продолжал звонить.
    expect(mockSendHangup).toHaveBeenCalledWith(PEER);
    expect(mockSendIceCandidate).toHaveBeenCalledWith(PEER, { type: 'hangup' });
  });

  it('раньше срока исходящий звонок никто не рвёт', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(OUTGOING_RINGING_TIMEOUT_MS - 1000);
    expect(getCurrentCall()?.state).toBe('outgoing');
    expect(mockSendHangup).not.toHaveBeenCalled();
  });

  it('трубку положил собеседник — сигнал ему назад не летит', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    mockSendHangup.mockClear();
    mockSendIceCandidate.mockClear();

    mockHangupHandler.current?.({ fromPeerId: PEER });
    await settle();

    expect(getCurrentCall()?.state).toBe('ended');
    expect(mockSendHangup).not.toHaveBeenCalled();
    expect(mockSendIceCandidate).not.toHaveBeenCalled();
  });

  // v4.32.581. Сигнальный сервер в модели угроз недоверенный: он видит обе
  // стороны и может прислать что угодно. Отправителя события он ставит сам
  // (`fromPeerId: registration.peerId`), поэтому событие без отправителя или с
  // чужим — это не старый сервер, а подделка, и разговор она трогать не должна.
  it('«положили трубку» без отправителя разговор не рвёт', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);

    mockHangupHandler.current?.({});
    await settle();

    expect(getCurrentCall()?.state).toBe('outgoing');
  });

  it('«положили трубку» от постороннего разговор не рвёт', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);

    mockHangupHandler.current?.({ fromPeerId: makePeer().pub });
    mockHangupHandler.current?.({ fromPeerId: 'не ключ' });
    await settle();

    expect(getCurrentCall()?.state).toBe('outgoing');
  });

  it('ответ без отправителя до setRemoteDescription не доходит', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    const pc = mockPeerConnections[mockPeerConnections.length - 1];
    expect(pc).toBeDefined();
    expect(pc.remoteDescription).toBeNull();

    const callId = String(envelopeBody(mockSendOffer.mock.calls.at(-1)?.[2]).callId);
    const answer = await sealAnswer(peer, ME, { sdp: 'remote-answer-sdp', callId });
    mockAnswerHandler.current?.({ sdp: answer });
    await settle();

    expect(pc.remoteDescription).toBeNull();
    expect(getCurrentCall()?.state).toBe('outgoing');

    // А от собеседника — доходит: проверка строгая, но не глухая.
    mockAnswerHandler.current?.({ fromPeerId: PEER, sdp: answer });
    await settle();

    expect(pc.remoteDescription).not.toBeNull();
    expect(getCurrentCall()?.state).toBe('connected');
  });

  it('нажатие «положить трубку» по-прежнему доходит до собеседника', async () => {
    await expect(initiateCall(PEER, 'peer', false)).resolves.toBe(true);
    mockSendHangup.mockClear();

    await hangupCall();

    expect(getCurrentCall()?.state).toBe('ended');
    expect(mockSendHangup).toHaveBeenCalledWith(PEER);
  });

  it('входящий, которого не взяли, кончается сам', async () => {
    await receiveOffer();
    expect(getCurrentCall()?.state).toBe('incoming');

    // Срок исходящего уже прошёл, а наш — ещё нет: звонок продолжается.
    await jest.advanceTimersByTimeAsync(OUTGOING_RINGING_TIMEOUT_MS);
    expect(getCurrentCall()?.state).toBe('incoming');

    await jest.advanceTimersByTimeAsync(INCOMING_RINGING_TIMEOUT_MS - OUTGOING_RINGING_TIMEOUT_MS);
    expect(getCurrentCall()?.state).toBe('ended');
    const [to, body] = mockSendAnswer.mock.calls.at(-1) as [string, string];
    expect(to).toBe(PEER);
    expect(envelopeBody(body)).toMatchObject({ kind: 'answer', from: ME, to: PEER, control: 'declined' });
  });

  it('взятая трубка снимает срок ожидания', async () => {
    await receiveOffer();
    await expect(acceptCall()).resolves.toBe(true);
    expect(getCurrentCall()?.state).toBe('connected');

    await jest.advanceTimersByTimeAsync(INCOMING_RINGING_TIMEOUT_MS * 2);

    expect(getCurrentCall()?.state).toBe('connected');
  });

  it('отклонённый входящий не воскрешает свой таймер на следующем звонке', async () => {
    await receiveOffer();
    await hangupCall();
    expect(getCurrentCall()?.state).toBe('ended');

    await jest.advanceTimersByTimeAsync(INCOMING_RINGING_TIMEOUT_MS * 2);
    await receiveOffer(testCallId('b'));

    expect(getCurrentCall()?.state).toBe('incoming');
  });
});

describe('форма исходников', () => {
  it('модуль правил без импортов — его можно проверять без WebRTC', () => {
    expect(MODULE).not.toMatch(/^import\s/m);
    expect(MODULE).not.toMatch(/\brequire\(/);
  });

  it('_hangup сам решает, предупреждать ли собеседника', () => {
    const body = HANGUP_BODY();
    expect(body).toContain('shouldNotifyPeer(currentCall.state, origin)');
    expect(body).toContain('sendHangupSignal(currentCall.peerPubB64, currentCall.state, activeCallId)');
  });

  it('у _hangup есть источник завершения со значением по умолчанию', () => {
    expect(SERVICE).toContain("origin: TeardownOrigin = 'local'");
  });

  it('завершения от собеседника помечены как чужие', () => {
    // Три места, откуда завершение приходит с той стороны: ответ «занято» /
    // «отклонён», ICE-сентинел и явный hangup.
    expect(SERVICE.match(/, 'remote'\)/g)?.length).toBe(3);
  });

  it('кнопка больше не дублирует сигнал — он один, внутри _hangup', () => {
    expect(HANGUP_CALL_BODY()).not.toContain('sendHangupSignal');
    expect(DISPOSE_BODY()).not.toContain('sendHangupSignal');
    expect(SERVICE.match(/sendHangupSignal\(/g)?.length).toBe(2);
  });

  it('срок входящего звонка ставится не числом из воздуха', () => {
    expect(SERVICE).toContain("ringingTimeoutMs('incoming')");
    expect(SERVICE).toContain("ringingTimeoutMs('outgoing')");
    expect(SERVICE).not.toContain('}, 45_000);');
  });

  it('оба таймера снимаются в одних и тех же местах', () => {
    expect(HANGUP_BODY()).toContain('incomingTimeoutTimer = null;');
    expect(DISPOSE_BODY()).toContain('incomingTimeoutTimer = null;');
    expect(bodyOf(SERVICE, 'export async function acceptCall(')).toContain('incomingTimeoutTimer = null;');
  });
});
