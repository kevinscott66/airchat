/**
 * Системная строка о таймере и о запрете копирования пишется до сдвига знака
 * (v4.32.777).
 *
 * Обе настройки применяются молча: у одного собеседника переписка вдруг
 * начинает исчезать, у другого пропадают «Копировать» и «Переслать». Сказать
 * об этом человеку умеет ровно одна вещь — системная строка в переписке. Её
 * писал `saveChatMessage`, который свой отказ гасит сам и отвечает `void`,
 * причём ПОСЛЕ `commitControlTs`. Занятая на секунду база съедала объяснение
 * навсегда: знак уже сдвинут, повтор того же конверта отвергается как старый,
 * а повторной отправки у служебного конверта нет вовсе.
 *
 * Теперь строка пишется различающей формой (`saveChatMessageChecked`) и до
 * сдвига знака: отказ откладывает кадр целиком, и следующий проход кладёт и
 * строку, и знак. Дубликата это не создаёт — id строки детерминирован
 * (INSERT OR IGNORE), а сама настройка идемпотентна.
 *
 * На своей стороне решение из-за строки не отменяется: таймер уже стоит и
 * конверт уходит. Но отказ там больше не молчит — он назван в журнале.
 */
const SYS = '\x0bsys:';

/** Исход записи системной строки: как у настоящей saveChatMessageChecked. */
let mockRowWrite: 'inserted' | 'duplicate' | 'failed' = 'inserted';
/** Строки, легшие в переписку. */
const mockRows: Array<{ id: string; text: string; direction: string }> = [];
/** Порядок обращений: строка должна ложиться до сдвига знака. */
const mockOrder: string[] = [];
/** Сдвинутые знаки: тема → отметка времени. */
const mockMarks = new Map<string, number>();

let mockTimerApplies = true;
let mockGuardApplies = true;

jest.mock('../../storage/local', () => ({
  setConversationDisappearTimer: async () => {
    mockOrder.push('apply');
    return mockTimerApplies;
  },
  saveChatMessage: async (row: { id: string; text: string; direction: string }) => {
    mockOrder.push('row');
    mockRows.push(row);
  },
  saveChatMessageChecked: async (row: { id: string; text: string; direction: string }) => {
    mockOrder.push('row');
    if (mockRowWrite === 'inserted') mockRows.push(row);
    return mockRowWrite;
  },
}));

jest.mock('../copyGuard', () => ({
  setCopyGuard: async () => {
    mockOrder.push('apply');
    return mockGuardApplies;
  },
  setPeerCopyGuardFor: async () => {
    mockOrder.push('apply');
    return mockGuardApplies;
  },
}));

jest.mock('../controlWatermark', () => ({
  controlTsFresh: async (topic: string, peer: string, pid: number, ts: number) =>
    ts > (mockMarks.get(`${topic}|${peer}|${pid}`) ?? 0),
  commitControlTs: async (topic: string, peer: string, pid: number, ts: number) => {
    mockOrder.push('mark');
    mockMarks.set(`${topic}|${peer}|${pid}`, ts);
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => {
    mockOrder.push('fanout');
    return { sent: true };
  },
  fanoutReasonText: () => 'нет связи',
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  encodeDisappearEnvelope,
  handleIncomingDisappear,
  setDisappearAndSync,
} from '../disappearSync';
import {
  encodeCopyGuardEnvelope,
  handleIncomingCopyGuard,
  setCopyGuardAndSync,
} from '../copyGuardSync';

const mockLog = (jest.requireMock('../../logger') as {
  log: { warn: jest.Mock; info: jest.Mock };
}).log;

const PEER = 'P'.repeat(43);
const PID = 1;
const HOUR = 3_600_000;

/** События, ушедшие в журнал приложения. */
const warnEvents = (): string[] => mockLog.warn.mock.calls.map((c) => String(c[0]));

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const DIS = codeOnly(readFileSync(join(__dirname, '..', 'disappearSync.ts'), 'utf8'));
const CG = codeOnly(readFileSync(join(__dirname, '..', 'copyGuardSync.ts'), 'utf8'));

beforeEach(() => {
  mockRowWrite = 'inserted';
  mockTimerApplies = true;
  mockGuardApplies = true;
  mockRows.length = 0;
  mockOrder.length = 0;
  mockMarks.clear();
  jest.clearAllMocks();
});

describe('входящий таймер: без строки кадр откладывается', () => {
  it('отказ записи строки не даёт ответить «разобрано»', async () => {
    mockRowWrite = 'failed';
    const env = encodeDisappearEnvelope({ ms: HOUR, ts: 1000 });

    expect(await handleIncomingDisappear(env, PEER, PID)).toBe('deferred');
    expect(warnEvents()).toContain('disappear_sys_row_failed');
  });

  it('и не двигает знак: повтор кадра ещё считается свежим', async () => {
    mockRowWrite = 'failed';
    await handleIncomingDisappear(encodeDisappearEnvelope({ ms: HOUR, ts: 1000 }), PEER, PID);

    expect(mockOrder).not.toContain('mark');
    expect(mockMarks.size).toBe(0);
  });

  it('следующий проход кладёт и строку, и знак', async () => {
    const env = encodeDisappearEnvelope({ ms: HOUR, ts: 1000 });
    mockRowWrite = 'failed';
    await handleIncomingDisappear(env, PEER, PID);

    mockRowWrite = 'inserted';
    expect(await handleIncomingDisappear(env, PEER, PID)).toBe('consumed');
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].text).toBe(`${SYS}Собеседник включил исчезающие сообщения: 1 час`);
    expect(mockMarks.get(`disappear|${PEER}|${PID}`)).toBe(1000);
  });

  it('строка ложится раньше знака, а не после него', async () => {
    await handleIncomingDisappear(encodeDisappearEnvelope({ ms: HOUR, ts: 1000 }), PEER, PID);

    expect(mockOrder.indexOf('row')).toBeLessThan(mockOrder.indexOf('mark'));
  });

  it('повтор той же строки разобран, а не отложен', async () => {
    // Второй проход после отложенного кадра упирается в INSERT OR IGNORE:
    // строка уже есть, и это успех, а не отказ.
    mockRowWrite = 'duplicate';
    expect(
      await handleIncomingDisappear(encodeDisappearEnvelope({ ms: HOUR, ts: 1000 }), PEER, PID)
    ).toBe('consumed');
    expect(mockMarks.get(`disappear|${PEER}|${PID}`)).toBe(1000);
  });
});

describe('входящий запрет копирования: без строки кадр откладывается', () => {
  it('отказ записи строки не даёт ответить «разобрано»', async () => {
    mockRowWrite = 'failed';
    const env = encodeCopyGuardEnvelope({ on: true, ts: 1000 });

    expect(await handleIncomingCopyGuard(env, PEER, PID)).toBe('deferred');
    expect(warnEvents()).toContain('copy_guard_sys_row_failed');
  });

  it('и не двигает знак: повтор кадра ещё считается свежим', async () => {
    mockRowWrite = 'failed';
    await handleIncomingCopyGuard(encodeCopyGuardEnvelope({ on: true, ts: 1000 }), PEER, PID);

    expect(mockOrder).not.toContain('mark');
    expect(mockMarks.size).toBe(0);
  });

  it('следующий проход кладёт и строку, и знак', async () => {
    const env = encodeCopyGuardEnvelope({ on: true, ts: 1000 });
    mockRowWrite = 'failed';
    await handleIncomingCopyGuard(env, PEER, PID);

    mockRowWrite = 'inserted';
    expect(await handleIncomingCopyGuard(env, PEER, PID)).toBe('consumed');
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].text).toBe(`${SYS}Собеседник включил запрет копирования и пересылки`);
    expect(mockMarks.get(`copyguard|${PEER}|${PID}`)).toBe(1000);
  });

  it('строка ложится раньше знака, а не после него', async () => {
    await handleIncomingCopyGuard(encodeCopyGuardEnvelope({ on: true, ts: 1000 }), PEER, PID);

    expect(mockOrder.indexOf('row')).toBeLessThan(mockOrder.indexOf('mark'));
  });
});

describe('своя сторона: строка не отменяет уже принятого решения', () => {
  it('таймер уходит собеседнику даже без строки, но отказ назван', async () => {
    mockRowWrite = 'failed';

    expect(await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR })).toEqual({ synced: true });
    expect(mockOrder).toContain('fanout');
    expect(warnEvents()).toContain('disappear_sys_row_failed');
  });

  it('запрет копирования — так же', async () => {
    mockRowWrite = 'failed';

    expect(await setCopyGuardAndSync({ peerPubB64: PEER, on: true })).toEqual({ synced: true });
    expect(mockOrder).toContain('fanout');
    expect(warnEvents()).toContain('copy_guard_sys_row_failed');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы на месте', () => {
  it('не вставший таймер по-прежнему откладывает кадр и строки не пишет', async () => {
    mockTimerApplies = false;

    expect(
      await handleIncomingDisappear(encodeDisappearEnvelope({ ms: HOUR, ts: 1000 }), PEER, PID)
    ).toBe('deferred');
    expect(mockRows).toEqual([]);
    expect(warnEvents()).toContain('disappear_apply_failed');
  });

  it('не вставший запрет — так же', async () => {
    mockGuardApplies = false;

    expect(
      await handleIncomingCopyGuard(encodeCopyGuardEnvelope({ on: true, ts: 1000 }), PEER, PID)
    ).toBe('deferred');
    expect(mockRows).toEqual([]);
    expect(warnEvents()).toContain('copy_guard_apply_failed');
  });

  it('устаревший повтор по-прежнему разобран и второй строки не кладёт', async () => {
    const env = encodeDisappearEnvelope({ ms: HOUR, ts: 1000 });
    await handleIncomingDisappear(env, PEER, PID);
    mockRows.length = 0;

    expect(await handleIncomingDisappear(env, PEER, PID)).toBe('consumed');
    expect(mockRows).toEqual([]);
  });

  it('удавшаяся запись на своей стороне журнал не засоряет', async () => {
    await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR });
    await setCopyGuardAndSync({ peerPubB64: PEER, on: true });

    expect(mockRows.map((r) => r.direction)).toEqual(['out', 'out']);
    expect(warnEvents()).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строка пишется различающей формой, а не гасящей отказ', () => {
    expect(DIS).toContain('return saveChatMessageChecked({');
    expect(CG).toContain('return saveChatMessageChecked({');
    expect(DIS).not.toContain('await saveChatMessage({');
    expect(CG).not.toContain('await saveChatMessage({');
  });

  it('в приёмниках строка стоит выше сдвига знака', () => {
    const disHandler = DIS.slice(DIS.indexOf('export async function handleIncomingDisappear'));
    expect(disHandler.indexOf('const sysRow = await insertSysRow({')).toBeLessThan(
      disHandler.indexOf("await commitControlTs('disappear'")
    );

    const cgHandler = CG.slice(CG.indexOf('export async function handleIncomingCopyGuard'));
    expect(cgHandler.indexOf('const sysRow = await insertSysRow({')).toBeLessThan(
      cgHandler.indexOf("await commitControlTs('copyguard'")
    );
  });

  it('помощник отвечает исходом записи, а не пустотой', () => {
    expect(DIS).toContain('}): Promise<ChatMessageWrite> {');
    expect(CG).toContain('}): Promise<ChatMessageWrite> {');
  });
});
