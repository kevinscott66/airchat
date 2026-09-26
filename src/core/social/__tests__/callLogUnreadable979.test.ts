/**
 * Непрочитанный журнал звонков затирался первой же новой записью (v4.32.979).
 *
 * Дефект. `loadCallLog` читал свой столбец строчной формой `kvGetSecret`, а
 * она сводит «журнала нет» и «журнал не открылся» к одному null
 * (`return cellTextOrNull(await kvGetSecretCell(key));`). Дальше по коду
 * разница между ними решающая: в памяти остаётся пустой список, и следующая
 * же запись — конец звонка (`recordCallEnd`) или придержанные сервером
 * пропущенные — уходит в тот же столбец поверх шифртекста.
 *
 * Цена. Сто последних звонков: кому звонил, когда и чем кончилось. Это
 * метаданные переписки, защищённые тем же общим ключом, что и её текст, — и
 * исчезали они необратимо, от одного входящего. Столбец не открывается чаще
 * всего в первую секунду после запуска: экран поднимается одновременно с
 * восстановлением сессии, а придержанные звонки приезжают первым же событием
 * после регистрации — ровно тогда, когда ключ ещё поднимается.
 *
 * Правило давно записано рядом, в `atRestCell` (v4.32.544): не открыв запись,
 * разрешать её перезапись нельзя. До журнала звонков оно не дошло.
 *
 * Правка. Столбец читается `kvGetSecretCell`; `'unreadable'` ставит отметку,
 * и пока она стоит, `persistCallLog` отвечает `false`, не записав ничего.
 * Отказ уходит наверх тем же путём, что и сорванная запись: за придержанные
 * сервером звонки мы не расписываемся, и он отдаст их снова. Снимается
 * отметка удачным чтением, удачной очисткой и остановкой службы.
 *
 * Границы. Отсутствующий столбец — по-прежнему пустой журнал, и писать в него
 * можно: терять там нечего.
 */
import fs from 'fs';
import path from 'path';

const PID = 11;
const SCOPED_KEY = `p${PID}:call_log`;

/** Один валидный ряд журнала: peerPubB64 обязан быть 43..48 символов. */
const PEER = 'C'.repeat(43);
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

type Cell = { state: 'absent' } | { state: 'plain'; text: string } | { state: 'unreadable' };

/** Что лежит в столбцах и открывается ли оно. */
const mockCells = new Map<string, Cell>();

const mockKvGetSecretCell = jest.fn(async (key: string): Promise<Cell> =>
  mockCells.get(key) ?? { state: 'absent' });
/**
 * Прежняя строчная форма — с той самой семантикой, из-за которой правка и
 * понадобилась: нечитаемый столбец она отдаёт как пустой. Живёт в заглушке
 * нарочно, чтобы прогон на дореформенном дереве шёл по живому коду.
 */
const mockKvGetSecret = jest.fn(async (key: string): Promise<string | null> => {
  const cell = mockCells.get(key) ?? { state: 'absent' };
  return cell.state === 'plain' ? cell.text : null;
});
const mockKvSetSecret = jest.fn(async (key: string, value: string): Promise<boolean> => {
  mockCells.set(key, { state: 'plain', text: value });
  return true;
});
const mockKvDelete = jest.fn(async (key: string): Promise<void> => { mockCells.delete(key); });
const mockKvDeleteChecked = jest.fn(async (key: string): Promise<void> => { mockCells.delete(key); });
const mockLogWarn = jest.fn();

jest.mock('../../storage/local', () => ({
  kvGetSecret: (key: string) => mockKvGetSecret(key),
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

/** Сколько раз журнал пытались записать. */
const writes = (): number =>
  mockKvSetSecret.mock.calls.filter((c) => c[0] === SCOPED_KEY).length;

const warnEvents = (): string[] => mockLogWarn.mock.calls.map((c) => String(c[0]));

/** Придержанный сервером звонок с настоящей распиской звонившего. */
async function held(at = Date.now() - 60_000): Promise<{
  fromPeerId: string; at: number; attempts: number; e?: string;
}> {
  return { fromPeerId: peer.pub, at, attempts: 3, e: await sealMissed(peer, me.pub, { now: at }) };
}

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeEach(async () => {
  await disposeCallService();
  mockCells.clear();
  mockKvGetSecret.mockClear();
  mockKvGetSecretCell.mockClear();
  mockKvSetSecret.mockClear();
  mockKvDelete.mockClear();
  mockKvDeleteChecked.mockClear();
  mockLogWarn.mockClear();
});

afterEach(async () => {
  await disposeCallService();
});

describe('журнал не открылся', () => {
  it('новая запись не ложится поверх непрочитанного', async () => {
    mockCells.set(SCOPED_KEY, { state: 'unreadable' });
    await initCallService(me.pair, PID);
    mockKvSetSecret.mockClear();

    const res = await recordMissedCalls([await held()], me.pub);

    expect(res.stored).toBe(false);
    expect(writes()).toBe(0);
    expect(mockCells.get(SCOPED_KEY)).toEqual({ state: 'unreadable' });
  });

  it('за придержанный звонок серверу не расписываются — он отдаст его снова', async () => {
    mockCells.set(SCOPED_KEY, { state: 'unreadable' });
    await initCallService(me.pair, PID);

    expect(await recordMissedCalls([await held()], me.pub)).toEqual({ added: 1, stored: false });
  });

  it('отказ виден в логе — иначе журнал пропадал бы молча', async () => {
    mockCells.set(SCOPED_KEY, { state: 'unreadable' });
    await loadCallLog(PID);
    await recordMissedCalls([await held()], me.pub);

    expect(warnEvents()).toContain('call_log_unreadable');
  });

  it('удачное чтение снимает отметку: журнал снова пишется', async () => {
    mockCells.set(SCOPED_KEY, { state: 'unreadable' });
    await loadCallLog(PID);
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    await loadCallLog(PID);
    await initCallService(me.pair, PID);
    mockKvSetSecret.mockClear();

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
    expect(writes()).toBeGreaterThan(0);
  });

  it('удачная очистка снимает отметку: столбца больше нет, терять нечего', async () => {
    mockCells.set(SCOPED_KEY, { state: 'unreadable' });
    await initCallService(me.pair, PID);

    expect(await clearCallLog()).toBe(true);
    mockKvSetSecret.mockClear();

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('столбца нет — журнал пуст, и писать в него можно', async () => {
    await initCallService(me.pair, PID);
    mockKvSetSecret.mockClear();

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
    expect(writes()).toBeGreaterThan(0);
  });

  it('столбец прочитался — журнал поднимается и дополняется', async () => {
    mockCells.set(SCOPED_KEY, { state: 'plain', text: LOG_JSON });
    await initCallService(me.pair, PID);
    expect(getCallLog()).toHaveLength(1);

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
    expect(getCallLog()).toHaveLength(2);
  });

  it('ГРАНИЦА: нечитаемый журнал чужого профиля своему не мешает', async () => {
    mockCells.set('p12:call_log', { state: 'unreadable' });
    await loadCallLog(12);
    await initCallService(me.pair, PID);
    mockKvSetSecret.mockClear();

    expect((await recordMissedCalls([await held()], me.pub)).stored).toBe(true);
  });

  it('ГРАНИЦА: непрочитанный журнал не показывают пустым списком с диска', async () => {
    mockCells.set(SCOPED_KEY, { state: 'unreadable' });
    await initCallService(me.pair, PID);

    expect(getCallLog()).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строчная форма по-прежнему складывает три состояния в два', () => {
    expect(codeOnly(read('core/storage/local.ts'))).toContain(
      'return cellTextOrNull(await kvGetSecretCell(key));',
    );
  });

  it('правило «не открыв запись, не переписывай» записано рядом', () => {
    expect(read('core/storage/atRestCell.ts')).toContain('unreadable');
    expect(codeOnly(read('core/storage/atRestCell.ts'))).toContain(
      "if (decoded === null) return { state: 'unreadable' };",
    );
  });

  it('конец звонка кладёт запись в тот же столбец, не спрашивая ни о чём', () => {
    const body = codeOnly(read('core/social/callService.ts'));
    expect(body).toContain('callLog = [entry, ...callLog].slice(0, MAX_LOG);');
    expect(body).toContain('if (profileId !== null) void persistCallLog(profileId, callLog);');
  });
});

describe('ЗАКРЕПКА', () => {
  it('столбец читается формой с тремя состояниями, а запись поверх запрещена', () => {
    const body = codeOnly(read('core/social/callService.ts'));
    expect(body).toContain('const own = await kvGetSecretCell(callLogKey(pid));');
    expect(body).toContain("if (own.state === 'unreadable') {");
    expect(body).toContain('if (callLogUnreadableFor === profileId) {');
  });
});
