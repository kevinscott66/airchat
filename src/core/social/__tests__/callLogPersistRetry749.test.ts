/**
 * Занятая секунда после запуска не стирает звонок из истории (v4.32.749).
 *
 * Запись журнала звонков спрашивала хранилище ровно один раз и по первому же
 * «нет» признавала запись потерянной. А «нет» здесь приходит буднично и почти
 * всегда в одну и ту же минуту: экран открывается одновременно с
 * восстановлением сессии, синхронизацией аккаунта и разбором очереди доставки,
 * ключ шифрования ещё поднимается, а придержанные сервером звонки приезжают
 * первым же событием после регистрации. Одиночное «database is locked» — не
 * потеря данных, оно проходит само за долю секунды.
 *
 * Цена этого «нет» несимметрична и до правки была невозвратной:
 *
 *  - `recordCallEnd` ответа не читает — сказать о нём некому, журнал ведётся
 *    сам собой. Только что закончившийся звонок оставался жить в памяти: до
 *    перезапуска человек видел его в истории, после — уже нет.
 *  - за придержанный сервером звонок мы по этому же слову не расписываемся, и
 *    он приезжал снова — лишним заходом, хотя мешала лишь занятая база.
 *
 * Теперь запись повторяется теми же паузами, что и чтение (`readRetry`):
 * причина у обоих обращений одна и та же занятая секунда, а не направление.
 * Тест сторожит и то, что повтор есть, и то, что он не бесконечный: после
 * условленного числа попыток отказ по-прежнему остаётся отказом и уходит в лог.
 */
import fs from 'fs';
import path from 'path';

const PID = 9;
const SCOPED_KEY = `p${PID}:call_log`;

/** Один валидный ряд журнала: peerPubB64 обязан быть 43..48 символов. */
const PEER = 'B'.repeat(43);
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
  // v4.32.979: свой столбец журнал читает тремя состояниями. Обе формы
  // стоят поверх одного мока — как в `local.ts`, где строчная написана
  // поверх ячейки; строчная оставлена, чтобы прогон на дореформенном
  // дереве шёл по живому коду.
  kvGetSecretCell: async (key: string) => {
    const text = await mockKvGetSecret(key);
    return text == null ? { state: 'absent' } : { state: 'plain', text };
  },
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

// Имена берём лениво: фабрика выполняется при первом require callService.
jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
  },
}));

import {
  disposeCallService,
  initCallService,
  loadCallLog,
  recordMissedCalls,
} from '../callService';
import { READ_RETRY_ATTEMPTS, readRetryDelayMs } from '../../storage/readRetry';
import { makePeer, sealMissed } from './callTestPeers';

const me = makePeer();
const peer = makePeer();

/** Сколько раз журнал пытались записать. */
const writes = (): number =>
  mockKvSetSecret.mock.calls.filter((c) => c[0] === SCOPED_KEY).length;

const warnEvents = (): string[] => mockLogWarn.mock.calls.map((c) => String(c[0]));

/** Журнал уже лежит по профильному ключу — чтение ведёт прямо к перезаписи. */
function scopedHasLog(): void {
  mockKvGetSecret.mockImplementation(async (key: string) =>
    (key === SCOPED_KEY ? LOG_JSON : null));
}

/** Хранилище отвечает «не смог» первые `times` раз, дальше соглашается. */
function busyForFirst(times: number): void {
  let left = times;
  mockKvSetSecret.mockImplementation(async () => {
    if (left > 0) { left -= 1; return false; }
    return true;
  });
}

/** Придержанный сервером звонок с настоящей распиской звонившего. */
async function held(at = Date.now() - 60_000): Promise<{
  fromPeerId: string; at: number; attempts: number; e?: string;
}> {
  return { fromPeerId: peer.pub, at, attempts: 3, e: await sealMissed(peer, me.pub, { now: at }) };
}

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

describe('запись журнала переживает одиночный отказ хранилища', () => {
  it('со второй попытки журнал ложится, и потерей это не считается', async () => {
    scopedHasLog();
    busyForFirst(1);

    await loadCallLog(PID);

    expect(writes()).toBe(2);
    expect(warnEvents()).not.toContain('call_log_persist_failed');
  });

  it('повторная попытка пишет тот же журнал, а не пустой', async () => {
    scopedHasLog();
    busyForFirst(1);

    await loadCallLog(PID);

    const bodies = mockKvSetSecret.mock.calls
      .filter((c) => c[0] === SCOPED_KEY)
      .map((c) => String(c[1]));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain(PEER);
    // Повтор — это та же запись ещё раз, а не новый снимок: между попытками
    // журнал в памяти никто не трогал, и разойтись им не с чего.
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: удавшаяся сразу запись повторов не делает', async () => {
    scopedHasLog();

    await loadCallLog(PID);

    expect(writes()).toBe(1);
    expect(warnEvents()).not.toContain('call_log_persist_failed');
  });
});

describe('повтор не бесконечный: отказ остаётся отказом', () => {
  it('попыток ровно столько, сколько условлено, и не больше', async () => {
    scopedHasLog();
    mockKvSetSecret.mockImplementation(async () => false);

    await loadCallLog(PID);

    expect(writes()).toBe(1 + READ_RETRY_ATTEMPTS);
    expect(warnEvents()).toContain('call_log_persist_failed');
  });

  it('перед повтором ждут, а не долбят базу в тот же тик', async () => {
    scopedHasLog();
    mockKvSetSecret.mockImplementation(async () => false);

    const started = Date.now();
    await loadCallLog(PID);

    // Нижняя граница: одна пауза заведомо была. Точное время в тесте не
    // сторожим — оно про планировщик, а не про правило.
    expect(Date.now() - started).toBeGreaterThanOrEqual(readRetryDelayMs(1));
  });
});

describe('за придержанный сервером звонок расписываются и после заминки', () => {
  it('первая попытка не прошла — расписка всё равно уходит', async () => {
    await initCallService(me.pair, PID);
    mockKvSetSecret.mockClear();
    busyForFirst(1);

    const res = await recordMissedCalls([await held()], me.pub);

    // Прежде это был `stored: false`, и сервер отдавал бы тот же звонок снова.
    expect(res).toEqual({ added: 1, stored: true });
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: наглухо занятое хранилище расписки не даёт', async () => {
    await initCallService(me.pair, PID);
    mockKvSetSecret.mockClear();
    mockKvSetSecret.mockImplementation(async () => false);

    const res = await recordMissedCalls([await held()], me.pub);

    expect(res).toEqual({ added: 1, stored: false });
  });
});

describe('паузы берут общие, а не заводят свои', () => {
  it('журнал звонков ссылается на readRetry', () => {
    const src = fs.readFileSync(path.join(__dirname, '../callService.ts'), 'utf8');
    expect(src).toContain(
      "import { READ_RETRY_ATTEMPTS, readRetryDelayMs } from '../storage/readRetry';");
    expect(src).toContain(
      '      for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {');
    expect(src).toContain(
      '        await new Promise<void>((resolve) => { setTimeout(resolve, readRetryDelayMs(attempt)); });');
  });
});
