/**
 * Отказ базы стирал журнал звонков (v4.32.1012).
 *
 * Дефект. Весь разбор в `loadCallLog` стоял в `try { … } catch { }` с пустым
 * телом. Занятая база отвечает на чтение не «пусто», а отказом — обращение
 * срывается, — и этот срыв улетал в пустой `catch`: `callLog` оставался
 * пустым, отметка «не открылось» не ставилась. Первый же звонок после этого
 * записывал одну строку поверх сотни.
 *
 * Проверка v4.32.979 здесь не срабатывала: она смотрит состояние прочитанной
 * ячейки — `'unreadable'`, — а ячейки не было вовсе.
 *
 * Цена. Сто последних звонков: кому звонил, когда и чем кончилось. Отказ
 * приходит чаще всего в первую секунду после запуска — тогда же, когда
 * приезжают придержанные сервером пропущенные, то есть запись случается
 * немедленно. Восстановить нечем: на диске уже новый журнал из одной строки.
 *
 * Правка. Столбец читается через `readCallLogCell`: он повторяет обращение
 * теми же паузами, что и запись (v4.32.749), и на окончательный отказ
 * отвечает `'failed'` — отдельным значением, а не пустым столбцом. Отказ
 * ставит ту же отметку, что и нечитаемый шифртекст.
 *
 * Границы. Журнал, чей текст не разобрался как JSON, тоже больше не
 * переписывается: прочитать его не вышло, а «Очистить» стирает столбец и
 * снимает запрет — выход из этого состояния есть.
 */
import fs from 'fs';
import path from 'path';

const PID = 11;
const SCOPED_KEY = `p${PID}:call_log`;
const LEGACY_KEY = 'call_log';

const PEER = 'C'.repeat(43);
const row = (startedAt: number) => ({
  id: `${startedAt}_abcdefgh`,
  peerPubB64: PEER,
  peerName: 'сосед',
  isVideo: false,
  direction: 'incoming' as const,
  outcome: 'missed' as const,
  startedAt,
  durationMs: null,
});
const LOG_JSON = JSON.stringify([row(1700000000000), row(1699999000000)]);

type Cell = { state: 'absent' } | { state: 'plain'; text: string } | { state: 'unreadable' };

const mockCells = new Map<string, Cell>();
/** База занята: чтение не отвечает «пусто», а срывается. */
let mockReadThrows = false;

const mockKvGetSecretCell = jest.fn(async (key: string): Promise<Cell> => {
  if (mockReadThrows) throw new Error('database is locked');
  return mockCells.get(key) ?? { state: 'absent' };
});
const mockKvSetSecret = jest.fn(async (key: string, value: string): Promise<boolean> => {
  mockCells.set(key, { state: 'plain', text: value });
  return true;
});
const mockKvDelete = jest.fn(async (key: string): Promise<void> => { mockCells.delete(key); });
const mockKvDeleteChecked = jest.fn(async (key: string): Promise<void> => { mockCells.delete(key); });
const mockLogWarn = jest.fn();

jest.mock('../../storage/local', () => ({
  kvGetSecret: async (key: string): Promise<string | null> => {
    const cell = await mockKvGetSecretCell(key);
    return cell.state === 'plain' ? cell.text : null;
  },
  kvGetSecretCell: (key: string) => mockKvGetSecretCell(key),
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: (key: string) => mockKvDelete(key),
  kvDeleteChecked: (key: string) => mockKvDeleteChecked(key),
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

jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
  },
}));

import {
  clearCallLog,
  disposeCallService,
  getCallLog,
  initCallService,
  loadCallLog,
  recordMissedCalls,
} from '../callService';
import { makePeer, sealMissed } from './callTestPeers';

const me = makePeer();
const peer = makePeer();

/** Что сейчас лежит в столбце журнала. */
function onDisk(key = SCOPED_KEY): unknown {
  const cell = mockCells.get(key);
  return cell && cell.state === 'plain' ? JSON.parse(cell.text) : cell;
}

const warnEvents = (): string[] => mockLogWarn.mock.calls.map((c) => String(c[0]));

/** Придержанный сервером звонок с настоящей распиской звонившего. */
async function held(at = Date.now() - 60_000): Promise<{
  fromPeerId: string; at: number; attempts: number; e?: string;
}> {
  return { fromPeerId: peer.pub, at, attempts: 3, e: await sealMissed(peer, me.pub, { now: at }) };
}

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

beforeEach(async () => {
  await disposeCallService();
  mockCells.clear();
  mockReadThrows = false;
  mockKvGetSecretCell.mockClear();
  mockKvSetSecret.mockClear();
  mockKvDelete.mockClear();
  mockKvDeleteChecked.mockClear();
  mockLogWarn.mockClear();
});

afterEach(async () => {
  await disposeCallService();
});

describe('база отказала — журнал не переписываем', () => {
  it('придержанный звонок не ложится поверх непрочитанной сотни', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    mockReadThrows = true;
    await initCallService(me.pair, PID);

    const res = await recordMissedCalls([await held()], me.pub);

    expect(res.stored).toBe(false);
    expect(onDisk()).toEqual(JSON.parse(LOG_JSON));
  });

  it('за него серверу не расписываются — он отдаст его снова', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    mockReadThrows = true;
    await initCallService(me.pair, PID);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(false);
  });

  it('отказ виден в логе — иначе журнал пропадал бы молча', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    mockReadThrows = true;
    await loadCallLog(PID);

    expect(warnEvents()).toContain('call_log_read_threw');
    expect(warnEvents()).toContain('call_log_unreadable');
  });

  it('база отпустила: журнал поднимается целиком и дополняется', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    mockReadThrows = true;
    await loadCallLog(PID);

    mockReadThrows = false;
    await initCallService(me.pair, PID);
    expect(getCallLog()).toHaveLength(2);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
    expect(getCallLog()).toHaveLength(3);
    expect(onDisk()).toHaveLength(3);
  });

  it('старый глобальный ключ при отказе тоже не теряется', async () => {
    // Миграция читает его вторым обращением: сорвись оно — журнал до
    // v4.32.277 стёрли бы, не прочитав.
    mockCells.set(LEGACY_KEY, { state: 'plain', text: LOG_JSON });
    mockReadThrows = true;
    await initCallService(me.pair, PID);

    await recordMissedCalls([await held()], me.pub);

    expect(onDisk(LEGACY_KEY)).toEqual(JSON.parse(LOG_JSON));
    expect(mockCells.has(SCOPED_KEY)).toBe(false);
  });

  it('одиночный отказ переживается повтором: журнал всё-таки поднят', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    mockKvGetSecretCell.mockImplementationOnce(async () => { throw new Error('database is locked'); });
    await initCallService(me.pair, PID);

    expect(getCallLog()).toHaveLength(2);
    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный день', () => {
  it('столбца нет — журнал пуст, и писать в него можно', async () => {
    await initCallService(me.pair, PID);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
    expect(onDisk()).toHaveLength(1);
  });

  it('столбец прочитался — журнал поднимается и дополняется', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    await initCallService(me.pair, PID);
    expect(getCallLog()).toHaveLength(2);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
    expect(getCallLog()).toHaveLength(3);
  });

  it('нечитаемый шифртекст по-прежнему не переписывается (v4.32.979)', async () => {
    mockCells.set(SCOPED_KEY, { state: 'unreadable' });
    await initCallService(me.pair, PID);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(false);
    expect(mockCells.get(SCOPED_KEY)).toEqual({ state: 'unreadable' });
  });

  it('миграция со старого ключа идёт как шла', async () => {
    mockCells.set(LEGACY_KEY, { state: 'plain', text: LOG_JSON });
    await initCallService(me.pair, PID);

    expect(getCallLog()).toHaveLength(2);
    expect(onDisk()).toHaveLength(2);
    expect(mockCells.has(LEGACY_KEY)).toBe(false);
  });
});

describe('ГРАНИЦА', () => {
  it('«Очистить» снимает запрет: столбца больше нет, терять нечего', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    mockReadThrows = true;
    await initCallService(me.pair, PID);
    mockReadThrows = false;

    expect(await clearCallLog()).toBe(true);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
  });

  it('неразобравшийся текст тоже не переписывается', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: 'не json' });
    await initCallService(me.pair, PID);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(false);
    expect(mockCells.get(SCOPED_KEY)).toEqual({ state: 'plain', text: 'не json' });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('журнал по-прежнему записывается целиком, а не по строке', () => {
    // Из-за этого непрочитанный журнал и стоит сотни звонков: запись — это
    // замена столбца, а не добавление.
    expect(read('core/social/callService.ts')).toContain('const body = JSON.stringify(snapshot);');
  });

  it('придержанные звонки по-прежнему приезжают сразу после регистрации', () => {
    // Та самая первая секунда, когда база занята: если бы запись случалась
    // позже, отказ чтения успевал бы пройти сам.
    expect(read('core/social/callService.ts')).toContain('onMissedCalls');
  });

  it('история звонков по-прежнему показывает то, что в памяти', () => {
    // Пустая память — это и есть «звонков не было» на экране: сказать
    // «не прочитали» ему нечем, поэтому запись поверх и опасна.
    const src = read('ui/screens/ProfileScreen.tsx');
    expect(src).toContain('useState<CallLogEntry[]>(() => getCallLog())');
    expect(src).toContain('subscribeCallLog((log) => {');
  });
});
