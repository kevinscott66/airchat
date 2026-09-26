/**
 * Повтор записи адреса доставки перебивал токен, который ещё ехал (v4.32.981).
 *
 * Дефект. Повтор (v4.32.734) сверял, не сменилась ли личность, но не сверял
 * токен — притом что ответ на сам запрос сверяет с v4.32.859 и то, и другое.
 * Асимметрия и есть дефект: `registerTokenTracked` первой же строкой
 * объявляет свой токен текущим (`this.currentToken = token`), поэтому повтор,
 * сработавший пока новый токен ещё едет к ретранслятору, задним числом делал
 * своим мёртвый токен. Дальше по кругу: ответ о мёртвом приходил
 * «своевременным» и признавался записанным, а ответ о живом — устаревшим и
 * молча отбрасывался.
 *
 * Цена. У ретранслятора на каждую личность ровно одна запись, и побеждает
 * последняя по времени (tokenStore.js: `ts <= previous.ts` — отказ). Последней
 * оказывалась мёртвая: уведомления не приходили вовсе, до следующего запуска
 * приложения, и увидеть это можно было только по их отсутствию — в журнале
 * обе записи выглядели успешными.
 *
 * Случай не выдуманный. Токен обновляют как раз тогда, когда старый умер, —
 * а значит его запись в те же секунды и срывается, заводя повтор. Первая
 * ступень лестницы (5 с) короче срока одного обращения к ретранслятору
 * (до 10 с), так что повтор попадает внутрь окна без всякой редкости.
 *
 * Правка. Повтор сверяет и токен — тем же условием, что и ответ. Не совпал —
 * повтор бросается: токеном занят тот, кто его сменил, и свой повтор он
 * заведёт сам, если не запишется.
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
/** Имена событий журнала: по ним видно, чей ответ сочли своим, а чей — нет. */
const mockLogInfo = jest.fn();
jest.mock('../../core/logger', () => ({
  log: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: (...args: unknown[]) => mockLogInfo(...args),
  },
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
/** Мёртвый токен: тот, из-за которого устройству и выдали новый. */
const DEAD = 'fcm-token-dead';
/** Живой токен, который устройство считает своим. */
const FRESH = 'fcm-token-fresh';
const FIRST_STEP_MS = PUSH_REGISTER_RETRY_DELAYS_MS[0];
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
/**
 * Все висящие ответы, а не последний.
 *
 * На дореформенном дереве повтор уходил к ретранслятору, пока живой токен ещё
 * ехал, — висящих запросов становилось два. Держи мок только последний, живой
 * так и остался бы неотпущенным, и проверка падала бы по таймауту вместо
 * утверждения. Падать она должна словами.
 */
let mockHung: ((ok: boolean) => void)[] = [];

/** Дать коду дойти до fetch (loadConfig, подпись, зеркало — всё через await). */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

function releaseHung(ok: boolean): void {
  const waiting = mockHung;
  mockHung = [];
  waiting.forEach((finish) => finish(ok));
}

/** Токены в порядке, в каком их получил ретранслятор. Побеждает последний. */
const tokens = (): string[] => mockWritten.map((w) => w.token);

/** Какие события попали в журнал за этот прогон. */
const events = (): string[] => mockLogInfo.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  jest.useFakeTimers();
  mockAppStateHandlers.length = 0;
  mockWritten = [];
  mockAnswer = 'ok';
  mockHung = [];
  mockLogInfo.mockClear();
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
    async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as Written;
      mockWritten.push({ peerId: sent.peerId, token: sent.token });
      if (mockAnswer === 'hang') {
        return new Promise((resolve) => {
          mockHung.push((ok: boolean) => resolve({ ok, status: ok ? 200 : 503 }));
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

/**
 * Довести дело до самой развилки: мёртвый токен не записался и ждёт повтора,
 * новый токен уехал к ретранслятору и ответа ещё нет.
 */
async function deadPendingWhileFreshInFlight(): Promise<{ inFlight: Promise<void> }> {
  mockAnswer = 'error';
  await svc.registerTokenTracked(ALICE, DEAD, 'push_register_not_done');
  mockAnswer = 'hang';
  // В обёртке нарочно: голый промис `await` развернул бы, и помощник ждал бы
  // ответа, которого ещё нет, — ровно того, что тест и не должен дожидаться.
  const inFlight = svc.registerTokenTracked(ALICE, FRESH, 'push_reregister_not_done');
  await flush();
  return { inFlight };
}

describe('повтор мёртвого токена не встаёт поперёк живого', () => {
  it('по сроку он не пишется — токеном занят не он', async () => {
    const { inFlight } = await deadPendingWhileFreshInFlight();
    await jest.advanceTimersByTimeAsync(FIRST_STEP_MS);

    expect(tokens()).toEqual([DEAD, FRESH]);

    releaseHung(true);
    await inFlight;
  });

  it('последним у ретранслятора остаётся живой токен, а не мёртвый', async () => {
    const { inFlight } = await deadPendingWhileFreshInFlight();
    await jest.advanceTimersByTimeAsync(FIRST_STEP_MS);
    releaseHung(true);
    await inFlight;
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);

    expect(tokens()[tokens().length - 1]).toBe(FRESH);
  });

  it('своим устройство продолжает считать живой токен', async () => {
    const { inFlight } = await deadPendingWhileFreshInFlight();
    await jest.advanceTimersByTimeAsync(FIRST_STEP_MS);

    expect(svc.currentToken).toBe(FRESH);

    releaseHung(true);
    await inFlight;
  });

  it('ответ о живом токене доходит как свой, а не как устаревший', async () => {
    const { inFlight } = await deadPendingWhileFreshInFlight();
    await jest.advanceTimersByTimeAsync(FIRST_STEP_MS);
    releaseHung(true);
    await inFlight;

    // Пустой `pendingRegistration` сам по себе ничего не доказывает: снять
    // повтор мог и ответ о мёртвом токене, признав своим себя. Доказывает
    // журнал — живой ответ не должен был попасть в «устаревшие».
    expect(events()).not.toContain('push_register_answer_stale');
    expect(svc.pendingRegistration).toBeNull();
    expect(mockAppStateHandlers).toHaveLength(0);
  });

  it('возвращение в приложение — тоже не повод оживить мёртвый токен', async () => {
    const { inFlight } = await deadPendingWhileFreshInFlight();
    const burned = mockWritten.length;
    mockAppStateHandlers.forEach((h) => h('active'));
    await flush();

    expect(mockWritten).toHaveLength(burned);

    releaseHung(true);
    await inFlight;
  });

  it('ГРАНИЦА: не записался и живой — свой повтор он заводит сам', async () => {
    const { inFlight } = await deadPendingWhileFreshInFlight();
    await jest.advanceTimersByTimeAsync(FIRST_STEP_MS);
    releaseHung(false);
    await inFlight;

    expect(svc.pendingRegistration).toEqual({ peerId: ALICE, token: FRESH, attempt: 0 });
    await jest.advanceTimersByTimeAsync(FIRST_STEP_MS);
    expect(tokens()[tokens().length - 1]).toBe(FRESH);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: лестница работает, как работала', () => {
  it('тот же токен и та же личность — повтор идёт по всем ступеням', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, DEAD, 'push_register_not_done');
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);

    expect(mockWritten).toHaveLength(1 + PUSH_REGISTER_RETRY_DELAYS_MS.length);
    expect(new Set(tokens())).toEqual(new Set([DEAD]));
  });

  it('смена личности повтор по-прежнему бросает (v4.32.859)', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, DEAD, 'push_register_not_done');
    const burned = mockWritten.length;
    svc.currentPeerId = BOB;
    await jest.advanceTimersByTimeAsync(WHOLE_LADDER_MS);

    expect(mockWritten).toHaveLength(burned);
    expect(svc.pendingRegistration).toBeNull();
  });

  it('удачная запись повтора не оставляет вовсе', async () => {
    await svc.registerTokenTracked(ALICE, FRESH, 'push_register_not_done');

    expect(svc.pendingRegistration).toBeNull();
    expect(tokens()).toEqual([FRESH]);
  });

  it('ГРАНИЦА: новый токен сменился до срока — повтор берёт новый, а не старый', async () => {
    mockAnswer = 'error';
    await svc.registerTokenTracked(ALICE, DEAD, 'push_register_not_done');
    await svc.registerTokenTracked(ALICE, FRESH, 'push_reregister_not_done');
    await jest.advanceTimersByTimeAsync(FIRST_STEP_MS);

    // Обе попытки закончились: повтор заведён на живой токен и пишет его.
    expect(svc.pendingRegistration?.token).toBe(FRESH);
    expect(tokens()[tokens().length - 1]).toBe(FRESH);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('попытка объявляет свой токен текущим первой же строкой', () => {
    const at = SRC.indexOf('private async registerTokenTracked(');
    expect(at).toBeGreaterThan(0);
    const head = SRC.slice(at, at + 200);
    expect(head).toContain('this.currentToken = token;');
    expect(head).toContain('await this.registerTokenWithSignaling(peerId, token);');
  });

  it('ответ сверяет и личность, и токен — повтор обязан тем же', () => {
    expect(SRC).toContain('if (this.currentPeerId !== peerId || this.currentToken !== token) {');
  });

  it('первая ступень лестницы короче срока одного обращения', () => {
    expect(SRC).toContain('setTimeout(() => ctrl.abort(), 10_000);');
    expect(FIRST_STEP_MS).toBeLessThan(10_000);
  });

  it('новый токен и правда приезжает сам, без участия человека', () => {
    const at = SRC.indexOf('messaging().onTokenRefresh(');
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(at, at + 800)).toContain(
      "await this.registerTokenTracked(peerId, t, 'push_reregister_not_done');"
    );
  });

  it('у ретранслятора одна запись на личность, и побеждает последняя', () => {
    expect(STORE).toContain('if (previous && ts <= previous.ts) return false;');
    expect(SRC).toContain('ts: Date.now(),');
  });
});

describe('ЗАКРЕПКА', () => {
  it('повтор сверяет пару целиком', () => {
    const at = SRC.indexOf('private async runRegisterRetry(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, at + 500);
    expect(body).toContain(
      'if (this.currentPeerId !== pending.peerId || this.currentToken !== pending.token) {'
    );
  });
});
