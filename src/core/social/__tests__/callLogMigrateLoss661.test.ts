/**
 * v4.32.661: `kvSetSecret` отвечает булевым — легла запись на диск или нет, — а
 * в журнале звонков этот ответ выбрасывался в двух местах.
 *
 * 1. `loadCallLog`, миграция с глобального `call_log` на профильный ключ:
 *    копию писали, ответ не смотрели, а следом БЕЗУСЛОВНО стирали legacy-ключ.
 *    Одна сорванная запись — и журнал звонков исчезал целиком: в профильный
 *    ключ он не попал, а глобальный уже стёрт. Восстановить неоткуда.
 * 2. `persistCallLog`: ответ терялся вместе с пустым `catch {}`. Сорванная
 *    запись не оставляла ни строчки в логе — записи просто пропадали к
 *    следующему запуску, и разбираться было не с чем.
 *
 * Тест сторожит оба места: пока копия не легла, legacy-ключ не трогаем, а
 * неудачную запись видно в логе.
 */
import fs from 'fs';
import path from 'path';

import {
  disposeCallService,
  getCallLog,
  loadCallLog,
} from '../callService';

const PID = 7;
const SCOPED_KEY = `p${PID}:call_log`;
const LEGACY_KEY = 'call_log';

/** Один валидный ряд журнала: peerPubB64 обязан быть 43..48 символов. */
const PEER = 'A'.repeat(43);
const LOG_JSON = JSON.stringify([
  {
    id: '1_abcdefgh',
    peerPubB64: PEER,
    peerName: 'сосед',
    isVideo: false,
    direction: 'incoming',
    outcome: 'missed',
    startedAt: 1700000000000,
    durationMs: null,
  },
]);

const mockKvGetSecret = jest.fn(async (_key: string): Promise<string | null> => null);
const mockKvSetSecret = jest.fn(async (_key: string, _value: string): Promise<boolean> => true);
const mockKvDelete = jest.fn(async (_key: string): Promise<void> => undefined);
const mockLogWarn = jest.fn();

jest.mock('../../storage/local', () => ({
  kvGetSecret: (key: string) => mockKvGetSecret(key),
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: (key: string) => mockKvDelete(key),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: PID }) },
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

// Имена берём лениво: фабрика выполняется при первом require callService,
// то есть раньше, чем инициализируются const выше, если дёрнуть их сразу.
jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
  },
}));

const keysOf = (fn: jest.Mock): string[] => fn.mock.calls.map((c) => String(c[0]));
const warnEvents = (): string[] => mockLogWarn.mock.calls.map((c) => String(c[0]));

/** Журнал лежит только в глобальном ключе — миграция обязана сработать. */
function onlyLegacyHasLog(): void {
  mockKvGetSecret.mockImplementation(async (key: string) =>
    (key === LEGACY_KEY ? LOG_JSON : null));
}

/** Журнал уже профильный — миграции нет, но перезапись (persist) есть. */
function onlyScopedHasLog(): void {
  mockKvGetSecret.mockImplementation(async (key: string) =>
    (key === SCOPED_KEY ? LOG_JSON : null));
}

describe('журнал звонков не пропадает из-за сорванной записи', () => {
  beforeEach(async () => {
    await disposeCallService();
    mockKvGetSecret.mockReset();
    mockKvGetSecret.mockImplementation(async () => null);
    mockKvSetSecret.mockReset();
    mockKvSetSecret.mockImplementation(async () => true);
    mockKvDelete.mockReset();
    mockKvDelete.mockImplementation(async () => undefined);
    mockLogWarn.mockClear();
  });

  afterEach(async () => {
    await disposeCallService();
  });

  it('копия не легла — глобальный ключ остаётся на месте', async () => {
    onlyLegacyHasLog();
    mockKvSetSecret.mockImplementation(async () => false);

    await loadCallLog(PID);

    // ПРОВЕРКА НЕ ПУСТАЯ: миграция дошла до записи, а не отвалилась раньше.
    expect(keysOf(mockKvSetSecret)).toContain(SCOPED_KEY);
    expect(keysOf(mockKvDelete)).not.toContain(LEGACY_KEY);
    expect(mockKvDelete).not.toHaveBeenCalled();
    expect(warnEvents()).toContain('call_log_migrate_failed');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: удавшаяся копия по-прежнему убирает глобальный ключ', async () => {
    onlyLegacyHasLog();
    mockKvSetSecret.mockImplementation(async () => true);

    await loadCallLog(PID);

    expect(keysOf(mockKvSetSecret)).toContain(SCOPED_KEY);
    expect(keysOf(mockKvDelete)).toContain(LEGACY_KEY);
    expect(warnEvents()).not.toContain('call_log_migrate_failed');
  });

  it('при сорванной копии журнал всё равно поднимается в память', async () => {
    onlyLegacyHasLog();
    mockKvSetSecret.mockImplementation(async () => false);

    await loadCallLog(PID);

    // Разблокировать человека от собственной истории нельзя: показать её
    // можно, потерять — нет.
    expect(getCallLog().map((e) => e.peerPubB64)).toEqual([PEER]);
  });

  it('сорванная запись журнала оставляет след в логе', async () => {
    onlyScopedHasLog();
    mockKvSetSecret.mockImplementation(async () => false);

    await loadCallLog(PID);

    // ПРОВЕРКА НЕ ПУСТАЯ: перезапись действительно шла по профильному ключу.
    expect(keysOf(mockKvSetSecret)).toEqual([SCOPED_KEY]);
    expect(warnEvents()).toContain('call_log_persist_failed');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: удавшаяся запись ничего в лог не пишет', async () => {
    onlyScopedHasLog();
    mockKvSetSecret.mockImplementation(async () => true);

    await loadCallLog(PID);

    expect(keysOf(mockKvSetSecret)).toEqual([SCOPED_KEY]);
    expect(warnEvents()).not.toContain('call_log_persist_failed');
  });

  it('исключение при записи журнала тоже не проглатывается молча', async () => {
    onlyScopedHasLog();
    mockKvSetSecret.mockImplementation(async () => { throw new Error('kv умер'); });

    await loadCallLog(PID);

    expect(warnEvents()).toContain('call_log_persist_error');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: kvSetSecret по-прежнему отвечает булевым, а журнал его читает', () => {
    const local = fs.readFileSync(path.join(__dirname, '../../storage/local.ts'), 'utf8');
    expect(local).toContain('export async function kvSetSecret(key: string, value: string): Promise<boolean> {');

    const src = fs.readFileSync(path.join(__dirname, '../callService.ts'), 'utf8');
    // Миграция: удаление legacy-ключа стоит ВНУТРИ удачной ветки.
    expect(src).toContain('        if (await kvSetSecret(callLogKey(pid), legacy)) {');
    expect(src).toContain('          await kvDelete(LEGACY_CALL_LOG_KEY);');
    expect(src).not.toContain('kvSetSecret(callLogKey(pid), legacy);');
    // Запись журнала: ответ читают, а исключение уходит в лог, а не в пустоту.
    expect(src).toContain('      if (!(await kvSetSecret(callLogKey(profileId), JSON.stringify(snapshot)))) {');
    expect(src).not.toContain('kvSetSecret(callLogKey(profileId), JSON.stringify(snapshot));');
    expect(src).toContain("      log.warn('call_log_persist_error', { err: e instanceof Error ? e.message : String(e) });");
    // Ровно два места, где журнал вообще пишется.
    expect(src.split('await kvSetSecret(callLogKey(').length - 1).toBe(2);
  });
});
