/**
 * Не легшая запись таймера больше не выдаёт себя за включённое автоудаление
 * (v4.32.750).
 *
 * `setConversationDisappearTimer` ловила исключение базы, писала строчку в
 * журнал приложения и возвращала `void`. Вызывающий отличить отказ от успеха
 * не мог — и не пытался. На исходящей стороне из одного молчаливого «нет»
 * получались сразу три неправды:
 *
 *  - системная строка «Вы включили исчезающие сообщения» ложилась в переписку;
 *  - конверт уходил собеседнику, и у НЕГО таймер вставал. Он стирает, мы
 *    копим — то есть ровно наоборот тому, ради чего это включают;
 *  - экран показывал выбранное значение, а модалка над кнопкой обещает
 *    дословно: «Выбранное время действует у обоих собеседников».
 *
 * Теперь отказ записи виден вызывающему: рассылки нет, системной строки нет,
 * ответ — `applied: false` с текстом про своё устройство, а экран оставляет
 * прежнее значение.
 *
 * Входящая сторона той же правки (водяной знак двигается только после
 * удавшейся записи) проверяется в controlEnvelopeReplay.
 */
const mockTimerCalls: Array<{ peer: string; pid: number; ms: number }> = [];
let mockTimerFails = false;
const mockRows: Array<{ id: string; text: string }> = [];
const mockFanout = jest.fn(async () => ({ sent: true }));
const mockWarn = jest.fn();

jest.mock('../../storage/local', () => ({
  setConversationDisappearTimer: async (peer: string, pid: number, ms: number) => {
    if (mockTimerFails) return false;
    mockTimerCalls.push({ peer, pid, ms });
    return true;
  },
  saveChatMessage: async (row: { id: string; text: string }) => {
    mockRows.push(row);
  },
  saveChatMessageChecked: async (row: { id: string; text: string }) => {
    mockRows.push(row);
    return 'inserted';
  },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: (...a: unknown[]) => mockFanout(...(a as [])),
  fanoutReasonText: () => 'нет связи',
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 3 }) },
}));

jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { setDisappearAndSync } from '../disappearSync';

const PEER = 'P'.repeat(43);
const HOUR = 3_600_000;

/** События, ушедшие в журнал приложения. */
const warnEvents = (): string[] => mockWarn.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  mockTimerCalls.length = 0;
  mockRows.length = 0;
  mockTimerFails = false;
  mockFanout.mockClear();
  mockFanout.mockImplementation(async () => ({ sent: true }));
  mockWarn.mockClear();
});

describe('запись таймера не легла', () => {
  it('ответ называет отказ и говорит, что таймера нет и у себя', async () => {
    mockTimerFails = true;

    const res = await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR });

    expect(res).toEqual({
      synced: false,
      applied: false,
      warning: expect.stringContaining('на этом устройстве'),
    });
    expect(warnEvents()).toContain('disappear_local_write_failed');
  });

  it('собеседнику при этом ничего не уходит', async () => {
    mockTimerFails = true;

    await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR });

    // Конверт объявлял бы состояние, которого у нас нет: он стирает, мы копим.
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('и системной строки о непроизошедшем в переписке не появляется', async () => {
    mockTimerFails = true;

    await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR });

    expect(mockRows).toEqual([]);
  });

  it('текст отказа разный для включения и выключения', async () => {
    mockTimerFails = true;

    const on = await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR });
    const off = await setDisappearAndSync({ peerPubB64: PEER, ms: 0 });

    expect(on.synced).toBe(false);
    expect(off.synced).toBe(false);
    if (on.synced || off.synced) throw new Error('оба ответа обязаны быть отказами');
    expect(on.warning).toContain('не включилось');
    expect(off.warning).toContain('не выключилось');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удавшаяся запись работает как прежде', () => {
  it('таймер встал, строка легла, конверт ушёл', async () => {
    const res = await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR });

    expect(res).toEqual({ synced: true });
    expect(mockTimerCalls).toEqual([{ peer: PEER, pid: 3, ms: HOUR }]);
    expect(mockRows).toHaveLength(1);
    expect(mockFanout).toHaveBeenCalledTimes(1);
    expect(warnEvents()).not.toContain('disappear_local_write_failed');
  });

  it('отказ рассылки — по-прежнему отдельная беда, и таймер у себя остаётся', async () => {
    mockFanout.mockImplementation(async () => ({ sent: false, reason: 'offline' }));

    const res = await setDisappearAndSync({ peerPubB64: PEER, ms: HOUR });

    // v4.32.750: `applied: true` — здесь у себя таймер как раз стоит, и экран
    // обязан показать новое значение, несмотря на предупреждение.
    expect(res).toEqual({
      synced: false,
      applied: true,
      warning: expect.stringContaining('собеседник об этом не узнал'),
    });
    expect(mockTimerCalls).toHaveLength(1);
    expect(mockRows).toHaveLength(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('запись таймера отвечает булевым, а отказ приходит из настоящего catch', () => {
    const local = readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
    expect(local).toContain('  disappearAfterMs: number | null\n): Promise<boolean> {');
    // Ответ — не украшение: он считается от того самого catch, который раньше
    // был единственным следом отказа.
    const at = local.indexOf('export async function setConversationDisappearTimer(');
    const body = local.slice(at, local.indexOf('\n}\n', at));
    expect(body).toContain('    return true;');
    expect(body).toContain("    log.warn('conversation_disappear_timer_failed'");
    expect(body).toContain('    return false;');
    expect(body.indexOf('return true;')).toBeLessThan(body.indexOf('return false;'));
  });

  it('оба экрана читают `applied`, а не обновляются вслепую', () => {
    const ui = join(__dirname, '..', '..', '..', 'ui');
    const chat = readFileSync(join(ui, 'screens', 'ChatScreen.tsx'), 'utf8');
    const peek = readFileSync(join(ui, 'components', 'UserProfilePeek.tsx'), 'utf8');
    expect(chat).toContain('if (res.synced || res.applied) setDisappearMs(ms);');
    expect(peek).toContain('if (res.synced || res.applied) setDisappearMs(ms);');
  });
});
