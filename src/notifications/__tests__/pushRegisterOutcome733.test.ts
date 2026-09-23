/**
 * Запись адреса доставки на сигналинге отвечает, состоялась ли она.
 *
 * v4.32.733. `registerTokenWithSignaling` отвечал `void` и глотал все свои
 * отказы: нет адреса сигналинга, конверт не подписался, сеть не дошла, сервер
 * ответил ошибкой. Без этой записи ретранслятору некуда слать уведомление —
 * токен устройства он знает только отсюда, — то есть отказ здесь означает
 * «уведомлений не будет», а не мелкую неудачу.
 *
 * Цену платил переключатель «Уведомления в браузере»: `enableWebPush`
 * возвращал `'enabled'` сразу после вызова, переключатель вставал в положение
 * «включено», подпись под ним гасла. Ветка `failed` с верным текстом («Не
 * удалось подписаться. Проверьте соединение и попробуйте ещё раз») у экрана
 * была, но достижима не была.
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  AppState: { currentState: 'active', addEventListener: jest.fn() },
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

/** Подпись конверта: по умолчанию удачная, отдельный тест её ломает. */
let mockSignOk = true;
jest.mock('../pushEnvelope', () => ({
  peerIdFromDid: (did: string) => `peer-${did.slice(-4)}`,
  signPushPayload: jest.fn(async (p: Record<string, unknown>) => (mockSignOk ? p : null)),
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

/** Ответ сети на POST /register-token. */
function respond(kind: 'ok' | 'error' | 'throw'): void {
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
    if (kind === 'throw') throw new Error('сеть недоступна');
    return { ok: kind === 'ok', status: kind === 'ok' ? 200 : 503 };
  });
}

beforeEach(() => {
  mockSignOk = true;
  mockConfig.webrtc = { signalingUrl: 'https://sig.example' };
  respond('ok');
});

describe('исход записи адреса называется', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: сервер принял — записано', async () => {
    await expect(pushNotificationService.registerTokenWithSignaling(PEER, 'tok')).resolves.toBe('registered');
  });

  it('сервер ответил ошибкой — сервер недоступен, а не «записано»', async () => {
    respond('error');
    await expect(pushNotificationService.registerTokenWithSignaling(PEER, 'tok')).resolves.toBe('unreachable');
  });

  it('сеть не дошла — то же самое', async () => {
    respond('throw');
    await expect(pushNotificationService.registerTokenWithSignaling(PEER, 'tok')).resolves.toBe('unreachable');
  });

  it('адреса сигналинга нет — писать некуда, повтор не поможет', async () => {
    mockConfig.webrtc = {};
    await expect(pushNotificationService.registerTokenWithSignaling(PEER, 'tok')).resolves.toBe('unsupported');
  });

  it('конверт не подписался — тоже некуда: без подписи сервер его не примет', async () => {
    mockSignOk = false;
    await expect(pushNotificationService.registerTokenWithSignaling(PEER, 'tok')).resolves.toBe('unsupported');
  });
});

describe('переключатель в браузере не обещает лишнего', () => {
  /**
   * `enableWebPush` ходит в `@react-native-firebase/messaging` через require —
   * подменяем его на месте, чтобы разрешение и «токен» были заведомо удачны и
   * различие оставалось ровно в записи адреса.
   */
  beforeEach(() => {
    jest.doMock('@react-native-firebase/messaging', () => ({
      __esModule: true,
      default: Object.assign(() => ({
        requestPermission: async () => 1,
        getToken: async () => 'web-subscription-json',
      }), { AuthorizationStatus: { AUTHORIZED: 1 } }),
    }), { virtual: true });
    (pushNotificationService as unknown as { currentPeerId: string }).currentPeerId = PEER;
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: адрес записан — уведомления включены', async () => {
    await expect(pushNotificationService.enableWebPush()).resolves.toBe('enabled');
  });

  it('адрес не записался — «не удалось», а не «включено»', async () => {
    respond('error');
    await expect(pushNotificationService.enableWebPush()).resolves.toBe('failed');
  });

  it('писать адрес некуда — тоже не «включено»', async () => {
    mockConfig.webrtc = {};
    await expect(pushNotificationService.enableWebPush()).resolves.toBe('failed');
  });
});
