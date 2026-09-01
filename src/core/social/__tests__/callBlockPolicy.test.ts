/**
 * Звонки и блок-лист (v4.32.318).
 *
 * Блокировка глушила переписку целиком: сообщения не сохранялись, «печатает…»
 * не показывалось, отметки о прочтении не уходили. Звонок при этом проходил
 * насквозь и звонил на весь дом — единственный канал, которым заблокированный
 * человек по-прежнему дотягивался до того, кто его заблокировал.
 *
 * Второе правило здесь — молчание. Ни «занято», ни «отклонён»: любой ответ
 * говорит звонящему, что устройство на связи и приложение работает. Ему
 * полагается видеть ровно то же, что при выключенном телефоне.
 */
type OfferHandler = (msg: { fromPeerId?: string; sdp: string }) => void;

let mockOfferHandler: OfferHandler | null = null;
const mockSendAnswer = jest.fn();
const mockSendOffer = jest.fn();

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendAnswer = (...a: unknown[]): void => { mockSendAnswer(...a); };
    sendOffer = (...a: unknown[]): void => { mockSendOffer(...a); };
    sendIceCandidate = jest.fn();
    onOffer = (h: OfferHandler): void => { mockOfferHandler = h; };
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onPeerUnavailable = jest.fn();
  },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({ webrtc: { signalingUrl: 'http://signal.test' } })),
}));

let mockBlocked = new Set<string>();
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async (): Promise<void> => undefined,
    isBlocked: (k: string): boolean => mockBlocked.has(k),
  },
}));

import {
  disposeCallService,
  getCurrentCall,
  initCallService,
  initiateCall,
} from '../callService';

const ME = 'M'.repeat(43);
const PEER = 'A'.repeat(43);
const SDP = JSON.stringify({ sdp: 'v=0\r\n', isVideo: true });
const TEST_PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

/** Обработчик входящего звонка асинхронный — дать ему доработать. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  mockBlocked = new Set();
  mockOfferHandler = null;
  mockSendAnswer.mockClear();
  mockSendOffer.mockClear();
  disposeCallService();
  await initCallService(ME, TEST_PAIR);
});

afterEach(() => {
  disposeCallService();
});

describe('входящий звонок от заблокированного', () => {
  it('не звонит и не отвечает ничего', async () => {
    mockBlocked.add(PEER);
    expect(mockOfferHandler).not.toBeNull();
    mockOfferHandler?.({ fromPeerId: PEER, sdp: SDP });
    await settle();
    expect(getCurrentCall()).toBeNull();
    expect(mockSendAnswer).not.toHaveBeenCalled();
  });

  it('молчит и когда мы заняты — «занято» тоже выдало бы нас', async () => {
    // Сперва обычный звонок, чтобы состояние стало не-idle.
    mockOfferHandler?.({ fromPeerId: 'B'.repeat(43), sdp: SDP });
    await settle();
    expect(getCurrentCall()?.state).toBe('incoming');

    mockBlocked.add(PEER);
    mockOfferHandler?.({ fromPeerId: PEER, sdp: SDP });
    await settle();
    expect(mockSendAnswer).not.toHaveBeenCalled();
    // И чужой звонок не подменил собой текущий.
    expect(getCurrentCall()?.peerPubB64).toBe('B'.repeat(43));
  });

  it('от незаблокированного — звонит как обычно', async () => {
    mockOfferHandler?.({ fromPeerId: PEER, sdp: SDP });
    await settle();
    expect(getCurrentCall()).toMatchObject({ state: 'incoming', peerPubB64: PEER, isVideo: true });
  });
});

describe('исходящий звонок заблокированному', () => {
  it('не начинается — писать ему тоже нельзя', async () => {
    mockBlocked.add(PEER);
    await expect(initiateCall(PEER, 'кто-то', false)).resolves.toBe(false);
    expect(mockSendOffer).not.toHaveBeenCalled();
  });
});
