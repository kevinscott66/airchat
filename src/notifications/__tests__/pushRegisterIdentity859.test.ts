/**
 * Повтор записи адреса доставки и смена личности (v4.32.859).
 *
 * Дефект. Повтор (v4.32.734) хранил токен, но не хранил, ЧЕЙ это адрес.
 * `runRegisterRetry` брал личность «свежую» — ту, что в приложении сейчас, — а
 * токен «свой», оставшийся от прошлой попытки. Пара из разных времён и есть
 * дефект. Собрать её нетрудно: обращение к ретранслятору живёт до десяти
 * секунд, и попытка, начатая до смены личности, заканчивается уже после неё —
 * ставя повтор заново, уже после того как `dispose` всё погасил.
 *
 * Цена. У ретранслятора на каждую личность ровно одна запись, и побеждает
 * последняя по времени (tokenStore.set: `ts <= previous.ts` — отказ). Повтор
 * подписывает свежую метку времени и потому побеждает всегда: верный адрес
 * нового человека затирался мёртвым токеном старого — тем самым, который
 * `dispose` уже удалил на устройстве. Уведомления после этого не приходили
 * вовсе, до следующего запуска приложения, и увидеть это можно было только по
 * их отсутствию: в журнале запись выглядела успешной.
 *
 * Правка. Повтор помнит личность, для которой он заведён, и токен, который
 * устройство считает своим. Личность сменилась — повтор бросается, а не
 * переписывается на нового человека. Ответ, пришедший на устаревшую попытку,
 * не трогает состояние повторов ни успехом, ни отказом.
 */
import * as fs from 'fs';
import * as path from 'path';

import { PUSH_REGISTER_RETRY_DELAYS_MS } from '../pushRegisterRetry';

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

jest.mock('../../core/config', () => ({
  loadConfig: jest.fn(async () => ({ webrtc: { signalingUrl: 'https://sig.example' } })),
}));
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
jest.mock('../../core/security/authGuard', () => ({ authGuard: { isSessionUnlocked: () => true } }));
jest.mock('../../core/social/messaging', () => ({
  getMessagingService: () => null,
  subscribeInAppNotifications: jest.fn(),
}));
jest.mock('../../core/social/groupMessaging', () => ({ setGroupMessageNotifyCallback: jest.fn() }));
jest.mock('../../core/social/contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../../core/notifications/muteStore', () => ({ isMuted: jest.fn(async () => false) }));
jest.mock('../senderTagLookup', () => ({ didForSenderTag: jest.fn(async () => null) }));

import { pushNotificationService } from '../pushNotifications';

const ALICE = 'did:key:zAAAA';
const BOB = 'did:key:zBBBB';
const T1 = 'fcm-token-1';
const T2 = 'fcm-token-2';
const WHOLE_LADDER_MS = PUSH_REGISTER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1_000;

/** Внутренности сервиса: у повтора нет и не должно быть публичного входа. */
const svc = pushNotificationService as unknown as {
  currentPeerId: string | null;
  currentToken: string | null;
  pendingRegistration: { peerId: string; token: string; attempt: number } | null;
  registerTokenTracked(peerId: string, token: string, event: string): Promise<void>;
  clearRegisterRetry(): void;
};

/** Что реально ушло ретранслятору: пара «личность ↔ токен» в каждом запросе. */
type Written = { peerId: string; token: string };
let mockWritten: Written[] = [];
/** Ответ на следующий запрос; 'hang' оставляет его висеть до releaseHung(). */
let mockAnswer: 'ok' | 'error' | 'hang' = 'ok';
let mockHung: ((ok: boolean) => void) | null = null;

/** Дать коду дойти до fetch (loadConfig, подпись, зеркало — всё через await). */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

function releaseHung(ok: boolean): void {
  const finish = mockHung;
  mockHung = null;
  finish?.(ok);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockAppStateHandlers.length = 0;
  mockWritten = [];
  mockAnswer = 'ok';
  mockHung = null;
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
    async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as Written;
      mockWritten.push({ peerId: sent.peerId, token: sent.token });
      if (mockAnswer === 'hang') {
        return new Promise((resolve) => {
          mockHung = (ok: boolean) => resolve({ ok, status: ok ? 200 : 503 });
        });
      }
      return { ok: mockAnswer === 'ok', status: mockAnswer === 'ok' ? 200 : 503 };
    }
  );
  svc.clearRegisterRetry();
  svc.currentPeerId = ALICE;
  svc.currentToken = null;
});

afterEach(() => {
  svc.clearRegisterRetry();
  svc.currentToken = null;
  jest.useRealTimers();
});

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pushNotifications.ts'), 'utf8');
const STORE = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'signaling-server', 'tokenStore.js'),
  'utf8'
);

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('обычная запись доходит и несёт свою пару «личность ↔ токен»', async () => {
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    expect(mockWritten).toEqual([{ peerId: 'peer-AAAA', token: T1 }]);
  });

  it('отказ ставит повтор, и повтор пишет ту же пару', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    await jest.advanceTimersByTimeAsync(PUSH_REGISTER_RETRY_DELAYS_MS[0]);
    expect(mockWritten).toHaveLength(2);
    expect(mockWritten[1]).toEqual(mockWritten[0]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('у ретранслятора одна запись на личность, и побеждает последняя по времени', () => {
    expect(STORE).toContain('if (previous && ts <= previous.ts) return false;');
    expect(SRC).toContain('ts: Date.now(),');
  });

  it('попытка живёт до десяти секунд — окно для смены личности настоящее', () => {
    expect(SRC).toContain('setTimeout(() => ctrl.abort(), 10_000);');
  });

  it('повтор идёт мимо общей дорожки — ни dispose, ни init его не дожидаются', () => {
    const arm = SRC.indexOf('private armRegisterRetry');
    const end = SRC.indexOf('private clearRegisterRetry');
    expect(arm).toBeGreaterThan(0);
    expect(SRC.slice(arm, end)).not.toContain('this.serial(');
    expect(SRC.slice(arm, end)).toContain('void this.runRegisterRetry(');
  });

  it('dispose гасит повтор — и всё равно этого оказалось мало', () => {
    const a = SRC.indexOf('private async disposeLocked');
    const b = SRC.indexOf('this.initialized = false;', a);
    expect(SRC.slice(a, b)).toContain('this.clearRegisterRetry();');
  });
});

describe('попытка, закончившаяся после смены личности', () => {
  it('отказ не ставит повтор на нового человека', async () => {
    mockAnswer = 'hang';
    const inFlight = svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    await flush();
    // Личность сменилась, пока мы ждали ответа.
    svc.currentPeerId = BOB;
    svc.currentToken = T2;
    releaseHung(false);
    await inFlight;
    expect(svc.pendingRegistration).toBeNull();
    expect(mockAppStateHandlers).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockWritten).toHaveLength(1);
  });

  it('успех не снимает повтор, заведённый новой личностью', async () => {
    mockAnswer = 'hang';
    const inFlight = svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    await flush();
    svc.currentPeerId = BOB;
    mockAnswer = 'error';
    await svc.registerTokenTracked(BOB, T2, 'push_register_not_done');
    expect(svc.pendingRegistration).toEqual({ peerId: BOB, token: T2, attempt: 0 });
    releaseHung(true);
    await inFlight;
    expect(svc.pendingRegistration).toEqual({ peerId: BOB, token: T2, attempt: 0 });
  });

  it('устаревший ответ не путает счёт ступеней новой лестницы', async () => {
    mockAnswer = 'hang';
    const inFlight = svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    await flush();
    svc.currentPeerId = BOB;
    mockAnswer = 'error';
    await svc.registerTokenTracked(BOB, T2, 'push_register_not_done');
    releaseHung(false);
    await inFlight;
    expect(svc.pendingRegistration?.attempt).toBe(0);
  });
});

describe('повтор, доживший до смены личности', () => {
  it('по сроку не пишется — адрес чужой', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    const burned = mockWritten.length;
    svc.currentPeerId = BOB;
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockWritten).toHaveLength(burned);
    expect(svc.pendingRegistration).toBeNull();
  });

  it('возвращение в приложение — тоже не повод', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    const burned = mockWritten.length;
    svc.currentPeerId = BOB;
    mockAnswer = 'ok';
    mockAppStateHandlers.forEach((h) => h('active'));
    await jest.advanceTimersByTimeAsync(0);
    expect(mockWritten).toHaveLength(burned);
  });

  it('слушателя за собой не оставляет', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    svc.currentPeerId = BOB;
    await jest.advanceTimersByTimeAsync(PUSH_REGISTER_RETRY_DELAYS_MS[0]);
    expect(mockAppStateHandlers).toHaveLength(0);
  });
});

describe('сменился токен, а не личность', () => {
  it('мёртвый токен не возвращается в повтор через сорвавшуюся попытку', async () => {
    mockAnswer = 'hang';
    const inFlight = svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    await flush();
    // Устройство выдало новый токен и записало его успешно.
    mockAnswer = 'ok';
    await svc.registerTokenTracked(ALICE, T2, 'push_reregister_not_done');
    releaseHung(false);
    await inFlight;
    expect(svc.pendingRegistration).toBeNull();
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockWritten.map((w) => w.token)).toEqual([T1, T2]);
  });

  it('повтор после смены токена пишет новый токен, а не тот, с которого начинал', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    await svc.registerTokenTracked(ALICE, T2, 'push_reregister_not_done');
    expect(svc.pendingRegistration).toEqual({ peerId: ALICE, token: T2, attempt: 0 });
    await jest.advanceTimersByTimeAsync(PUSH_REGISTER_RETRY_DELAYS_MS[0]);
    expect(mockWritten[mockWritten.length - 1].token).toBe(T2);
  });
});

describe('уход личности забывает и токен', () => {
  it('dispose перестаёт считать токен своим — его там же и удаляют', () => {
    const a = SRC.indexOf('private async disposeLocked');
    const b = SRC.indexOf('this.initialized = false;', a);
    expect(SRC.slice(a, b)).toContain('this.currentToken = null;');
  });
});

describe('обычный путь не задет', () => {
  it('та же личность и тот же токен — лестница идёт как шла', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(mockWritten).toHaveLength(1 + PUSH_REGISTER_RETRY_DELAYS_MS.length);
    expect(new Set(mockWritten.map((w) => w.token))).toEqual(new Set([T1]));
  });

  it('записалось — повтора нет и слушателя нет', async () => {
    await svc.registerTokenTracked(ALICE, T1, 'push_register_not_done');
    expect(svc.pendingRegistration).toBeNull();
    expect(mockAppStateHandlers).toHaveLength(0);
  });
});
