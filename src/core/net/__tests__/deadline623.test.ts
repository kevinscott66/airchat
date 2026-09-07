/**
 * Два запроса, у которых не было срока ожидания (v4.32.623).
 *
 * `fetchWithDeadline` завели в v4.32.614 и в его шапке перечислены ровно два
 * намеренных исключения — `syncApi.fetchSigned` и `linkProofCheck.getText`.
 * Эти двое в список не входили, а срока у них всё равно не было: сервер,
 * принявший соединение и молчащий в ответ, оставлял промис невыполненным
 * навсегда.
 *
 * Наружу это выглядело так: нажатие на @юзернейм в переписке не делало НИЧЕГО
 * (ни перехода, ни ошибки — `handleMentionPress` ждёт ответа без индикатора),
 * а экран «Привязать к Apple ID» навсегда оставался без кнопок входа.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const secure = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => secure.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { secure.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { secure.delete(key); }),
  };
});
jest.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '18.0', constants: {}, isPad: false },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' }, nativeAppVersion: '1.0.0', platform: { ios: { model: 'iPhone' } } },
}));
jest.mock('../../storage/accountVault', () => ({
  accountIdFromPublicKey: jest.fn(() => 'account-id'),
  accountVaultIdFromMnemonic: jest.fn(() => 'legacy-id'),
}));
jest.mock('../../backup/seedPhrase', () => ({
  deriveKeyPairFromMnemonic: jest.fn(() => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) })),
}));
jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({ cloudBackup: { enabled: true, baseUrl: 'https://sync.example/cloud-vault' } })),
}));
jest.mock('../../crypto/signature', () => ({ signJson: jest.fn(async () => ({ payload: '{}', signature: 'sig' })) }));
jest.mock('../../crypto/keyManager', () => ({ ED25519_SECRET_KEY_BYTES: 32 }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { lookupSyncUsername } from '../../sync/syncApi';
import { listSeedBindingProviders } from '../../backup/seedBinding';

/** Срок у обоих один и тот же — 15 секунд; ждём заведомо дольше. */
const WAY_PAST_ANY_DEADLINE_MS = 60_000;

/** Сервер, который принял соединение и молчит, но уважает отмену. */
function serveSilence(): { calls: number } {
  const state = { calls: 0 };
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
    state.calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // без сигнала отменить нечем — промис висит вечно
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as unknown as typeof fetch;
  return state;
}

/** Сервер, который отвечает сразу — положительный контроль на всю оснастку. */
function serveJson(body: unknown): void {
  global.fetch = jest.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

/**
 * Ждёт ответа, отматывая поддельное время. Возвращает `PENDING`, если ответа
 * так и не случилось — тогда виден именно повисший навсегда промис, а не
 * пятисекундный предел jest.
 */
const PENDING = Symbol('pending');
async function settleWithin<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  let out: T | typeof PENDING = PENDING;
  void promise.then((v) => { out = v; });
  await Promise.resolve();
  jest.advanceTimersByTime(WAY_PAST_ANY_DEADLINE_MS);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  return out;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('поиск юзернейма', () => {
  it('молчание сервера кончается ответом «неизвестно», а не вечным ожиданием', async () => {
    const state = serveSilence();
    const out = await settleWithin(lookupSyncUsername('vasya'));
    expect(state.calls).toBe(1);
    expect(out).toEqual({ status: 'unknown' });
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: отвечающий сервер разбирается как раньше', async () => {
    serveJson({ taken: false });
    const out = await settleWithin(lookupSyncUsername('vasya'));
    expect(out).toEqual({ status: 'free' });
  });
});

describe('список входов для привязки слов', () => {
  it('молчание сервера кончается пустым списком, а не вечным ожиданием', async () => {
    const state = serveSilence();
    const out = await settleWithin(listSeedBindingProviders());
    expect(state.calls).toBe(1);
    expect(out).toEqual([]);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: отвечающий сервер разбирается как раньше', async () => {
    serveJson({ providers: ['apple', 'нет-такого', 'google'] });
    const out = await settleWithin(listSeedBindingProviders());
    expect(out).toEqual(['apple', 'google']);
  });
});
