/**
 * v4.32.658: журнал звонков принадлежит тому профилю, под которым поднялась
 * служба, а не тому, что активен в момент чтения или очистки.
 *
 * `loadCallLog` и `clearCallLog` выводили владельца заново —
 * `profileManager.getActiveProfile()?.id ?? 1`, — тогда как все записи журнала
 * идут в `callProfileId`, то есть в тот номер, что передали в
 * `initCallService`. Между этими двумя моментами есть окно: служба звонков
 * поднимается после первого кадра, за несколькими await. Если за это время
 * человек переключил аккаунт, чтение брало журнал нового профиля, а
 * последующая запись, перешифровка и миграция legacy-ключа клали его в
 * хранилище старого — метаданные звонков одного аккаунта оказывались в другом.
 * Симметрично «Очистить» стирала журнал чужого профиля, а свой оставляла.
 *
 * Тест сторожит поведение: при расхождении «владелец службы» ≠ «активный
 * профиль» хранилище трогается ТОЛЬКО по ключу владельца.
 */
import {
  clearCallLog,
  disposeCallService,
  initCallService,
} from '../callService';
import { makePeer } from './callTestPeers';

const OWNER_PID = 7;
const OTHER_PID = 3;
const OWNER_KEY = `p${OWNER_PID}:call_log`;
const OTHER_KEY = `p${OTHER_PID}:call_log`;
const LEGACY_KEY = 'call_log';

/** Профиль, активный «прямо сейчас» — тест двигает его между сценариями. */
const mockActivePid = { current: OTHER_PID };
const mockGetActiveProfile = jest.fn(() => ({ id: mockActivePid.current }));

const mockKvGetSecret = jest.fn(async (_key: string): Promise<string | null> => null);
const mockKvSetSecret = jest.fn(async (_key: string, _value: string): Promise<boolean> => true);
const mockKvDelete = jest.fn(async (_key: string): Promise<void> => undefined);

jest.mock('../../storage/local', () => ({
  kvGetSecret: (key: string) => mockKvGetSecret(key),
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: (key: string) => mockKvDelete(key),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => mockGetActiveProfile() },
}));

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class { close = jest.fn(); },
  RTCSessionDescription: class { constructor(value: unknown) { void value; } },
  RTCIceCandidate: class { constructor(value: unknown) { void value; } },
  mediaDevices: { getUserMedia: jest.fn() },
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendHangup = jest.fn();
    sendIceCandidate = jest.fn();
    sendAnswer = jest.fn();
    sendOffer = jest.fn();
    onOffer = jest.fn();
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

const me = makePeer();

const keysOf = (fn: jest.Mock): string[] => fn.mock.calls.map((c) => String(c[0]));

describe('владелец журнала звонков — тот, под кем поднялась служба', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await disposeCallService();
    mockActivePid.current = OTHER_PID;
    mockGetActiveProfile.mockClear();
    mockKvGetSecret.mockClear();
    mockKvSetSecret.mockClear();
    mockKvDelete.mockClear();
  });

  afterEach(async () => {
    await disposeCallService();
    jest.useRealTimers();
  });

  it('чтение при старте идёт по ключу владельца, а не активного профиля', async () => {
    await initCallService(me.pair, OWNER_PID);

    const read = keysOf(mockKvGetSecret);
    // ПРОВЕРКА НЕ ПУСТАЯ: журнал действительно читали.
    expect(read.length).toBeGreaterThan(0);
    expect(read).toContain(OWNER_KEY);
    expect(read).not.toContain(OTHER_KEY);
  });

  it('миграция legacy-ключа кладёт журнал владельцу', async () => {
    mockKvGetSecret.mockImplementation(async (key: string) =>
      (key === LEGACY_KEY ? JSON.stringify([]) : null));

    await initCallService(me.pair, OWNER_PID);

    const written = keysOf(mockKvSetSecret);
    // ПРОВЕРКА НЕ ПУСТАЯ: миграция сработала, запись была.
    expect(written).toContain(OWNER_KEY);
    expect(written).not.toContain(OTHER_KEY);
  });

  it('«Очистить» стирает журнал владельца, даже если аккаунт уже переключили', async () => {
    await initCallService(me.pair, OWNER_PID);
    mockKvDelete.mockClear();
    // Человек переключился на другой аккаунт уже после запуска службы.
    mockActivePid.current = OTHER_PID;

    await clearCallLog();

    const deleted = keysOf(mockKvDelete);
    // ПРОВЕРКА НЕ ПУСТАЯ: очистка дошла до хранилища.
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted).toContain(OWNER_KEY);
    expect(deleted).toContain(LEGACY_KEY);
    expect(deleted).not.toContain(OTHER_KEY);
  });

  it('без поднятой службы очистка не трогает чужое хранилище', async () => {
    await clearCallLog();
    expect(mockKvDelete).not.toHaveBeenCalled();
  });

  it('ни чтение, ни очистка не спрашивают активный профиль', async () => {
    await initCallService(me.pair, OWNER_PID);
    await clearCallLog();
    expect(mockGetActiveProfile).not.toHaveBeenCalled();

    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: активный профиль и владелец журнала — разные
    // числа, поэтому предыдущая проверка не может пройти сама собой.
    expect(mockGetActiveProfile().id).toBe(OTHER_PID);
    expect(OTHER_PID).not.toBe(OWNER_PID);
  });
});
