/**
 * Запись адреса доставки не бросается на первом отказе сети (v4.32.734).
 *
 * Адрес пишется один раз, при запуске приложения, — и запуск как раз та
 * секунда, когда сети чаще всего нет. Исход записи с v4.32.733 назван вслух,
 * но пользоваться им было некому: `'unreachable'` уходил в журнал, и
 * уведомления молча не работали до следующего запуска.
 *
 * Здесь проверяется ровно то, чего не было: повтор по лестнице, остановка на
 * первом успехе, отсутствие повтора там, где он бессмыслен, конечность
 * лестницы и её сброс при возвращении в приложение.
 */
import { PUSH_REGISTER_RETRY_DELAYS_MS, nextRetryDelayMs } from '../pushRegisterRetry';

/** Слушатели AppState, поставленные кодом: через них проверяется возвращение. */
const mockAppStateHandlers: ((s: string) => void)[] = [];
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    currentState: 'active',
    addEventListener: (_e: string, h: (s: string) => void) => {
      mockAppStateHandlers.push(h);
      return {
        remove: () => {
          const i = mockAppStateHandlers.indexOf(h);
          if (i >= 0) mockAppStateHandlers.splice(i, 1);
        },
      };
    },
  },
  PermissionsAndroid: { request: jest.fn(), PERMISSIONS: {}, RESULTS: {} },
}));

const mockConfig: { webrtc?: { signalingUrl?: string } } = { webrtc: { signalingUrl: 'https://sig.example' } };
jest.mock('../../core/config', () => ({ loadConfig: jest.fn(async () => mockConfig) }));

jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../core/storage/secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../core/storage/local', () => ({
  kvGet: jest.fn(async () => null),
  kvSetChecked: jest.fn(async () => true),
  kvTryGet: jest.fn(async () => ({ value: null })),
}));

jest.mock('../pushEnvelope', () => ({
  peerIdFromDid: (did: string) => `peer-${did.slice(-4)}`,
  signPushPayload: jest.fn(async (p: Record<string, unknown>) => p),
}));

jest.mock('../../core/security/authGuard', () => ({ authGuard: { isSessionUnlocked: async () => true } }));
jest.mock('../../core/social/messaging', () => ({
  getMessagingService: () => null,
  subscribeInAppNotifications: jest.fn(),
}));
jest.mock('../../core/social/groupMessaging', () => ({ setGroupMessageNotifyCallback: jest.fn() }));
jest.mock('../../core/social/contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../../core/notifications/muteStore', () => ({ isMuted: jest.fn(async () => false) }));
jest.mock('../senderTagLookup', () => ({ didForSenderTag: jest.fn(async () => null) }));

import { pushNotificationService } from '../pushNotifications';

const PEER = 'did:key:zAAAA';
const TOKEN = 'fcm-token';
/** Вся лестница целиком плюс запас — чтобы «больше не звонит» было честным. */
const WHOLE_LADDER_MS = PUSH_REGISTER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1_000;

/** Ответ сигналинга и счётчик обращений к нему — общие на весь тест. */
let mockKind: 'ok' | 'error' = 'ok';
let mockCalls = 0;

/** Внутренности сервиса: у повтора нет и не должно быть публичного входа. */
const svc = pushNotificationService as unknown as {
  currentPeerId: string | null;
  registerTokenTracked(peerId: string, token: string, event: string): Promise<void>;
  clearRegisterRetry(): void;
};

beforeEach(() => {
  jest.useFakeTimers();
  mockConfig.webrtc = { signalingUrl: 'https://sig.example' };
  mockKind = 'ok';
  mockCalls = 0;
  mockAppStateHandlers.length = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
    mockCalls += 1;
    return { ok: mockKind === 'ok', status: mockKind === 'ok' ? 200 : 503 };
  });
  svc.clearRegisterRetry();
  svc.currentPeerId = PEER;
});

afterEach(() => {
  svc.clearRegisterRetry();
  jest.useRealTimers();
});

describe('лестница повторов', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: у каждой ступени свой срок, за последней — ничего', () => {
    expect(nextRetryDelayMs(0)).toBe(PUSH_REGISTER_RETRY_DELAYS_MS[0]);
    expect(nextRetryDelayMs(PUSH_REGISTER_RETRY_DELAYS_MS.length - 1)).toBe(
      PUSH_REGISTER_RETRY_DELAYS_MS[PUSH_REGISTER_RETRY_DELAYS_MS.length - 1],
    );
    expect(nextRetryDelayMs(PUSH_REGISTER_RETRY_DELAYS_MS.length)).toBeNull();
  });

  it('сроки только растут — иначе повторы учащались бы под отказом', () => {
    for (let i = 1; i < PUSH_REGISTER_RETRY_DELAYS_MS.length; i += 1) {
      expect(PUSH_REGISTER_RETRY_DELAYS_MS[i]).toBeGreaterThan(PUSH_REGISTER_RETRY_DELAYS_MS[i - 1]);
    }
  });

  it('отрицательная и дробная ступень — не срок, а ошибка счёта', () => {
    expect(nextRetryDelayMs(-1)).toBeNull();
    expect(nextRetryDelayMs(1.5)).toBeNull();
  });
});

describe('запись адреса доставки', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: записалось с первого раза — повторять нечего', async () => {
    await svc.registerTokenTracked(PEER, TOKEN, 'push_register_not_done');
    expect(mockCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockCalls).toBe(1);
    // И слушателя возвращения в приложение за собой не оставили.
    expect(mockAppStateHandlers).toHaveLength(0);
  });

  it('сервер не ответил — попытка повторяется по срокам, а не теряется', async () => {
    mockKind = 'error';
    await svc.registerTokenTracked(PEER, TOKEN, 'push_register_not_done');
    expect(mockCalls).toBe(1);
    // До срока первой ступени никто никуда не ходит.
    await jest.advanceTimersByTimeAsync(PUSH_REGISTER_RETRY_DELAYS_MS[0] - 1);
    expect(mockCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(PUSH_REGISTER_RETRY_DELAYS_MS[1]);
    expect(mockCalls).toBe(3);
  });

  it('сервер ответил на повторе — дальше не звоним', async () => {
    mockKind = 'error';
    await svc.registerTokenTracked(PEER, TOKEN, 'push_register_not_done');
    mockKind = 'ok';
    await jest.advanceTimersByTimeAsync(PUSH_REGISTER_RETRY_DELAYS_MS[0]);
    expect(mockCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockCalls).toBe(2);
    expect(mockAppStateHandlers).toHaveLength(0);
  });

  it('лестница конечна — сигналинг не долбится до конца сессии', async () => {
    mockKind = 'error';
    await svc.registerTokenTracked(PEER, TOKEN, 'push_register_not_done');
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    const spent = 1 + PUSH_REGISTER_RETRY_DELAYS_MS.length;
    expect(mockCalls).toBe(spent);
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS * 3);
    expect(mockCalls).toBe(spent);
  });

  /**
   * Без этого дефект вернулся бы в точности, только отложенный: телефон
   * пролежал час без сети, лестница догорела вхолостую, push мёртв до
   * перезапуска. Человек, открывший приложение, обычно и принёс с собой сеть.
   */
  it('возвращение в приложение начинает лестницу заново', async () => {
    mockKind = 'error';
    await svc.registerTokenTracked(PEER, TOKEN, 'push_register_not_done');
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    const burned = mockCalls;
    expect(mockAppStateHandlers.length).toBeGreaterThan(0);

    // Уход в фон поводом не является — новая попытка только на возвращении.
    mockAppStateHandlers.forEach((h) => h('background'));
    await Promise.resolve();
    expect(mockCalls).toBe(burned);

    mockKind = 'ok';
    mockAppStateHandlers.forEach((h) => h('active'));
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCalls).toBe(burned + 1);
    // Записалось — слушатель снят, лишних попыток больше не будет.
    expect(mockAppStateHandlers).toHaveLength(0);
  });

  it('писать некуда — повтора нет вовсе: он ничего не изменит', async () => {
    mockConfig.webrtc = {};
    await svc.registerTokenTracked(PEER, TOKEN, 'push_register_not_done');
    expect(mockCalls).toBe(0);
    expect(mockAppStateHandlers).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockCalls).toBe(0);
  });

  it('уборка снимает и срок, и слушателя — смена личности не тащит старый токен', async () => {
    mockKind = 'error';
    await svc.registerTokenTracked(PEER, TOKEN, 'push_register_not_done');
    expect(mockAppStateHandlers.length).toBeGreaterThan(0);
    svc.clearRegisterRetry();
    expect(mockAppStateHandlers).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockCalls).toBe(1);
  });
});

describe('уборка вызывается там, где личность сменилась', () => {
  it('disposeLocked снимает повтор до того, как обнулит peerId', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src: string = require('fs').readFileSync(
      require('path').join(__dirname, '../pushNotifications.ts'),
      'utf8',
    );
    const a = src.indexOf('private async disposeLocked');
    const b = src.indexOf('this.currentPeerId = null;', a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(src.slice(a, b)).toContain('this.clearRegisterRetry();');
  });
});
