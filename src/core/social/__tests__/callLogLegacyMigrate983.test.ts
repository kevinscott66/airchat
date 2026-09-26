/**
 * Перенос журнала звонков с глобального ключа доводится до конца (v4.32.983).
 *
 * До v4.32.277 журнал звонков лежал в одной строке на всё устройство —
 * `call_log`. Перенос в свой столбец профиля делается разово, при первом же
 * чтении, и в этом месте нашлись две дыры. Обе открываются в одну и ту же
 * первую секунду после запуска — ту, ради которой в v4.32.749 у записи
 * появился повтор: экран поднимается вместе с восстановлением сессии и
 * разбором очереди доставки, база занята, ключ шифрования ещё поднимается.
 *
 * Дыра первая: отказ чтения принимался за «переносить нечего». Глобальный ключ
 * читался через `kvGetSecret`, а тот сводит «строки нет» и «строка не
 * прочиталась» к одному `null`. Занятая база — и перенос молча пропускался.
 * Первая же новая запись создавала свой столбец, после чего сюда не заходили
 * больше никогда: `raw` непустой, ветка миграции закрыта. Журнал до v4.32.277
 * оставался лежать на диске непрочитанным.
 *
 * Дыра вторая, и она дороже: копия в свой столбец идёт одним заходом, а запись
 * строкой ниже — с повторами. Занятая секунда роняла первую и отпускала
 * вторую. Итог: журнал в своём столбце есть, глобальный ключ никто не убрал.
 * Следующий аккаунт на том же устройстве поднимал его как свой — кому звонили,
 * когда и чем кончилось. Это ровно та утечка между профилями, которую закрыли
 * в v4.32.278; сюда она вернулась через заднюю дверь.
 *
 * Правка. Глобальный ключ читается тремя состояниями, и «не прочиталось»
 * останавливает запись так же, как у своего столбца (v4.32.979) — иначе новая
 * запись похоронит то, что ещё открылось бы. А убирается глобальный ключ
 * тогда, когда данные заведомо легли, — после ответа `persistCallLog`, а не по
 * удаче первой попытки.
 *
 * Границы. Запрет записи снимается сам, как только строка прочиталась, и у
 * человека есть выход руками: «Очистить» в истории звонков стирает оба ключа
 * и снимает запрет (v4.32.800).
 */
import fs from 'fs';
import path from 'path';

const P1 = 4;
const P2 = 5;
const LEGACY = 'call_log';
const SCOPED1 = `p${P1}:call_log`;
const SCOPED2 = `p${P2}:call_log`;

const PEER = 'C'.repeat(43);
const LOG_JSON = JSON.stringify([
  {
    id: '1_abcdefgh',
    peerPubB64: PEER,
    peerName: 'бывший сосед',
    isVideo: false,
    direction: 'outgoing',
    outcome: 'answered',
    startedAt: 1700000000000,
    durationMs: 42_000,
  },
]);

type Cell =
  | { state: 'absent' }
  | { state: 'plain'; text: string }
  | { state: 'unreadable' };

/** Хранилище: ключ → ячейка. Три состояния, как у настоящего `local.ts`. */
const mockCells = new Map<string, Cell>();
/** Сколько ближайших записей хранилище отклонит (занятая база). */
let mockWriteRefusals = 0;
const mockDeleted: string[] = [];
/** Стирание: в настоящем `local.ts` оба входа ведут в одну и ту же строку. */
function mockWipe(key: string): void {
  mockDeleted.push(key);
  mockCells.delete(key);
}
const mockLogWarn = jest.fn();

const mockKvGetSecretCell = jest.fn(
  async (key: string): Promise<Cell> => mockCells.get(key) ?? { state: 'absent' },
);
const mockKvSetSecret = jest.fn(async (key: string, value: string): Promise<boolean> => {
  if (mockWriteRefusals > 0) { mockWriteRefusals -= 1; return false; }
  mockCells.set(key, { state: 'plain', text: value });
  return true;
});
jest.mock('../../storage/local', () => ({
  kvGetSecretCell: (key: string) => mockKvGetSecretCell(key),
  // Настоящий `kvGetSecret` написан поверх ячейки и теряет разницу между
  // «нет» и «не открылось» — мок обязан терять её так же, иначе прогон на
  // дореформенном дереве шёл бы по несуществующему коду.
  kvGetSecret: async (key: string): Promise<string | null> => {
    const cell = await mockKvGetSecretCell(key);
    return cell.state === 'plain' ? cell.text : null;
  },
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: async (key: string): Promise<void> => { mockWipe(key); },
  kvDeleteChecked: async (key: string): Promise<void> => { mockWipe(key); },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: P1 }) },
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
const caller = makePeer();

const warns = (): string[] => mockLogWarn.mock.calls.map((c) => String(c[0]));
const has = (key: string): boolean => mockCells.has(key);
const textOf = (key: string): string | null => {
  const cell = mockCells.get(key);
  return cell && cell.state === 'plain' ? cell.text : null;
};

/** Придержанный сервером звонок с настоящей распиской звонившего. */
async function held(): Promise<{ fromPeerId: string; at: number; attempts: number; e?: string }> {
  const at = Date.now() - 60_000;
  return { fromPeerId: caller.pub, at, attempts: 1, e: await sealMissed(caller, me.pub, { now: at }) };
}

/** Устройство с журналом времён до v4.32.277: глобальный ключ, свой пуст. */
function deviceWithLegacy(): void {
  mockCells.set(LEGACY, { state: 'plain', text: LOG_JSON });
}

beforeEach(async () => {
  await disposeCallService();
  mockCells.clear();
  mockDeleted.length = 0;
  mockWriteRefusals = 0;
  mockKvGetSecretCell.mockClear();
  mockKvSetSecret.mockClear();
  mockLogWarn.mockClear();
});

afterEach(async () => {
  await disposeCallService();
});

describe('глобальный ключ убирают по факту записи, а не по удаче первой попытки', () => {
  it('копия сорвалась, повтор лёг — глобального ключа больше нет', async () => {
    deviceWithLegacy();
    mockWriteRefusals = 1; // ровно одна занятая секунда: падает копия

    await loadCallLog(P1);

    expect(textOf(SCOPED1)).toContain(PEER);
    expect(has(LEGACY)).toBe(false);
  });

  it('и следующий аккаунт не поднимает чужую историю как свою', async () => {
    deviceWithLegacy();
    mockWriteRefusals = 1;

    await loadCallLog(P1);
    await disposeCallService();
    await loadCallLog(P2);

    // Прежде здесь оказывался журнал первого аккаунта: кому звонил, когда и
    // чем кончилось.
    expect(getCallLog()).toEqual([]);
    expect(has(SCOPED2)).toBe(false);
  });

  it('ГРАНИЦА: наглухо занятая база глобальный ключ не трогает', async () => {
    deviceWithLegacy();
    mockWriteRefusals = 99;

    await loadCallLog(P1);

    // v4.32.661: не легло никуда — стирать нечего и незачем.
    expect(has(LEGACY)).toBe(true);
    expect(warns()).toContain('call_log_migrate_failed');
  });
});

describe('нечитаемый глобальный ключ не принимают за пустой', () => {
  it('перенос откладывается, а не отменяется', async () => {
    mockCells.set(LEGACY, { state: 'unreadable' });

    await loadCallLog(P1);

    expect(warns()).toContain('call_log_legacy_unreadable');
    expect(has(LEGACY)).toBe(true);
  });

  it('и новая запись поверх него не ложится', async () => {
    mockCells.set(LEGACY, { state: 'unreadable' });
    await initCallService(me.pair, P1);

    const res = await recordMissedCalls([await held()], me.pub);

    // Расписываться за придержанный звонок нельзя: он существует в одном
    // экземпляре, а лечь ему сейчас некуда.
    expect(res.stored).toBe(false);
    expect(has(SCOPED1)).toBe(false);
    expect(has(LEGACY)).toBe(true);
  });

  it('строка прочиталась — запрет снимается сам', async () => {
    mockCells.set(LEGACY, { state: 'unreadable' });
    await initCallService(me.pair, P1);
    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(false);

    mockCells.set(LEGACY, { state: 'plain', text: LOG_JSON });
    await loadCallLog(P1);

    expect(textOf(SCOPED1)).toContain(PEER);
    expect(has(LEGACY)).toBe(false);
  });

  it('ГРАНИЦА: «Очистить» — выход руками, если строка не прочитается никогда', async () => {
    mockCells.set(LEGACY, { state: 'unreadable' });
    await initCallService(me.pair, P1);

    expect(await clearCallLog()).toBe(true);
    expect(mockDeleted).toContain(LEGACY);
    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный перенос как был', () => {
  it('спокойная база: журнал переехал, глобальный ключ убран', async () => {
    deviceWithLegacy();

    await loadCallLog(P1);

    expect(getCallLog()).toHaveLength(1);
    expect(textOf(SCOPED1)).toContain(PEER);
    expect(has(LEGACY)).toBe(false);
    expect(warns()).not.toContain('call_log_migrate_failed');
  });

  it('переносить нечего — хранилище не трогают вовсе', async () => {
    await loadCallLog(P1);

    expect(mockKvSetSecret).not.toHaveBeenCalled();
    expect(mockDeleted).toEqual([]);
    expect(warns()).not.toContain('call_log_legacy_unreadable');
  });

  it('свой столбец уже есть — за глобальным вообще не ходят', async () => {
    mockCells.set(SCOPED1, { state: 'plain', text: LOG_JSON });
    mockCells.set(LEGACY, { state: 'unreadable' });

    await loadCallLog(P1);

    expect(getCallLog()).toHaveLength(1);
    expect(has(LEGACY)).toBe(true);
    expect(warns()).not.toContain('call_log_legacy_unreadable');
  });

  it('свой столбец не открылся — это по-прежнему своя причина отказа', async () => {
    mockCells.set(SCOPED1, { state: 'unreadable' });

    await loadCallLog(P1);

    // v4.32.979: у своего столбца свой повод в журнале приложения.
    expect(warns()).toContain('call_log_unreadable');
    expect(warns()).not.toContain('call_log_legacy_unreadable');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '../callService.ts'), 'utf8');

  it('запись строкой ниже и правда идёт с повторами, а копия — одним заходом', () => {
    // Вся несимметрия отсюда: одна попытка против трёх в ту же занятую секунду.
    expect(SRC).toContain('for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {');
    const at = SRC.indexOf('if (await kvSetSecret(callLogKey(pid), legacy)) {');
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(at - 400, at)).not.toContain('READ_RETRY_ATTEMPTS');
  });

  it('«Очистить» стирает оба ключа и снимает запрет — выход руками есть', () => {
    const at = SRC.indexOf('export async function clearCallLog(): Promise<boolean> {');
    expect(at).toBeGreaterThan(0);
    const tail = SRC.slice(at, at + 2400);
    expect(tail).toContain('await kvDeleteChecked(LEGACY_CALL_LOG_KEY);');
    expect(tail).toContain('if (callLogUnreadableFor === pid) callLogUnreadableFor = null;');
  });

  it('глобальный ключ и правда один на всё устройство', () => {
    expect(SRC).toContain("const LEGACY_CALL_LOG_KEY = 'call_log';");
    expect(SRC).toContain('const callLogKey = (pid: number): string => `p${pid}:${LEGACY_CALL_LOG_KEY}`;');
  });
});
