/**
 * Отложенное сообщение стирали, не попробовав отправить ни разу (v4.32.835).
 *
 * Дефект. Планировщик бросал попытки «по старости»: `Date.now() - msg.sendAt`
 * больше пятнадцати минут — строку снимаем. Возраст этот рос по часам на
 * стене, а пробовали отправить только когда приложение открыто. Сообщение,
 * назначенное на ночь, к утру было «старым» на девять часов — и первая же его
 * попытка, та самая, что случается через полминуты после запуска, когда
 * служба обмена ещё поднимается, а сеть ещё в режиме только-из-кэша и
 * `requireOnlineWrite` бросает, сразу перешагивала срок.
 *
 * Цена. Строка расписания — единственное место, где живёт текст: своей копии у
 * отложенного сообщения нет нигде (личную пишет sendMessage, но до записи дело
 * не доходит; групповую пишет сам проход, но только после удачной рассылки).
 * Снимали её вместе с текстом и говорили «связи не было слишком долго» — про
 * попытку, которой не было ни одной. Чем дальше человек откладывал сообщение и
 * чем реже открывал приложение, тем вернее оно пропадало: то есть ломалось
 * ровно то, ради чего откладывают.
 *
 * Правка. В таблице появился столбец `attempts`, которого не было в v4.32.440,
 * когда правило выводили. Считаются попытки, а не часы: тридцать попыток по
 * тику раз в полминуты — те же пятнадцать минут для приложения, которое всё
 * это время работает, и ровно тридцать честных попыток для того, которое
 * открывают дважды в день. Отметка о попытке ложится ДО отправки — упасть
 * может как раз отправка, и попытка, о которой никто не записал, повторялась
 * бы вечно. Ветки, где отправлять не пробовали (строка не прочиталась, выбран
 * часовой лимит), попытку не тратят.
 *
 * Стенд гоняет настоящий проход `flushDueOnce` через `startScheduler`, который
 * зовёт первый тик сразу; наружу проход не экспортирован.
 */
import fs from 'fs';
import path from 'path';

type Row = {
  id: string;
  contactPubB64: string;
  text: string;
  mediaCids: string | null;
  sendAt: number;
  ownerProfileId: number;
  createdAt: number;
  attempts?: number;
  groupId?: string | null;
  senderName?: string | null;
  readState?: 'ok' | 'text_unreadable' | 'media_unreadable';
};

/** Что лежит в расписании на этот проход. */
let mockDue: Row[] = [];
/** Снятые строки: главная улика — их тут быть не должно. */
const mockDeleted: string[] = [];
/** Отметки о потраченных попытках: {id, attempts}. */
const mockBumps: Array<{ id: string; attempts: number }> = [];
/** Отчёты о потере — то, что человек увидит вместо сообщения. */
const mockReports: Array<{ code: string; message: string }> = [];

let mockSend: (to: string, text: string) => Promise<string | null> = async () => 'cid';
let mockFanoutResult: unknown = { ok: true, members: 2, sent: 2, failed: 0 };
let mockOwnRow: 'ok' | 'failed' = 'ok';
let mockBlocked = false;
let mockLimitReached = false;
let mockActivePid: number | null = 1;

// uuid поставляется как ESM и до стенда не доходит; проходу он не нужен.
jest.mock('uuid', () => ({ v4: () => 'uuid-stub' }));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => (mockActivePid === null ? null : { id: mockActivePid }) },
}));

jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: (to: string, text: string) => mockSend(to, text) }),
}));

jest.mock('../../storage/local', () => ({
  listDueScheduledMessages: jest.fn(async () => mockDue),
  deleteScheduledMessage: jest.fn(async (id: string) => { mockDeleted.push(id); }),
  bumpScheduledAttemptChecked: jest.fn(async (id: string, _pid: number, attempts: number) => {
    mockBumps.push({ id, attempts });
    return true;
  }),
  insertScheduledMessage: jest.fn(async () => undefined),
  insertGroupMessageWithTouch: jest.fn(async () => mockOwnRow),
}));

jest.mock('../groupMessaging', () => ({
  fanoutGroupMessage: jest.fn(async () => mockFanoutResult),
}));

jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: jest.fn(async () => 'Я'),
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: jest.fn(async () => undefined),
    isBlocked: () => mockBlocked,
    messageLimitReached: () => mockLimitReached,
  },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../errorHandler', () => ({
  ErrorSeverity: { ERROR: 'error' },
  ErrorHandler: {
    getInstance: () => ({
      handle: async (r: { code: string; message: string }) => { mockReports.push(r); },
    }),
  },
}));

import { startScheduler, stopScheduler } from '../scheduledMessages';

const HOUR = 3_600_000;
const PUB = 'A'.repeat(43) + '=';

/** Строка расписания, назначенная `hoursAgo` часов назад. */
function row(over: Partial<Row> = {}, hoursAgo = 9): Row {
  return {
    id: 'msg-1',
    contactPubB64: PUB,
    text: 'спокойной ночи',
    mediaCids: null,
    sendAt: Date.now() - hoursAgo * HOUR,
    ownerProfileId: 1,
    createdAt: Date.now() - (hoursAgo + 1) * HOUR,
    attempts: 0,
    ...over,
  };
}

/**
 * Один настоящий проход. `startScheduler` зовёт первый тик синхронно, дальше
 * внутри прохода лежит динамический импорт и цепочка await — поэтому ждём
 * несколько оборотов очереди, а не один.
 */
async function flushOnce(): Promise<void> {
  startScheduler();
  stopScheduler();
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mockDue = [];
  mockDeleted.length = 0;
  mockBumps.length = 0;
  mockReports.length = 0;
  mockSend = async () => 'cid';
  mockFanoutResult = { ok: true, members: 2, sent: 2, failed: 0 };
  mockOwnRow = 'ok';
  mockBlocked = false;
  mockLimitReached = false;
  mockActivePid = 1;
});

afterEach(() => stopScheduler());

describe('назначенное давно не стирают с первой же неудачи', () => {
  it('личное: сеть не поднялась — строка остаётся, и текст с ней', async () => {
    mockDue = [row()];
    mockSend = async () => { throw new Error('CACHE_ONLY_MODE'); };
    await flushOnce();
    expect(mockDeleted).toEqual([]);
    expect(mockBumps).toEqual([{ id: 'msg-1', attempts: 1 }]);
  });

  it('и о потере не рапортуют: терять пока нечего', async () => {
    mockDue = [row()];
    mockSend = async () => { throw new Error('CACHE_ONLY_MODE'); };
    await flushOnce();
    expect(mockReports).toEqual([]);
  });

  it('групповое: никто не получил — строка остаётся', async () => {
    mockDue = [row({ id: 'g-1', groupId: 'grp', senderName: 'Я' })];
    mockFanoutResult = { ok: true, members: 3, sent: 0, failed: 3 };
    await flushOnce();
    expect(mockDeleted).toEqual([]);
    expect(mockBumps).toEqual([{ id: 'g-1', attempts: 1 }]);
  });

  it('групповое: своя копия не легла — строка остаётся', async () => {
    mockDue = [row({ id: 'g-2', groupId: 'grp', senderName: 'Я' })];
    mockOwnRow = 'failed';
    await flushOnce();
    expect(mockDeleted).toEqual([]);
  });

  it('и на двадцать девятой попытке ещё держим', async () => {
    mockDue = [row({ attempts: 28 })];
    mockSend = async () => { throw new Error('CACHE_ONLY_MODE'); };
    await flushOnce();
    expect(mockBumps).toEqual([{ id: 'msg-1', attempts: 29 }]);
    expect(mockDeleted).toEqual([]);
  });
});

describe('запас попыток кончается, и тогда говорят вслух', () => {
  it('личное: тридцатая неудача снимает строку и рапортует', async () => {
    mockDue = [row({ attempts: 29 })];
    mockSend = async () => { throw new Error('CACHE_ONLY_MODE'); };
    await flushOnce();
    expect(mockDeleted).toEqual(['msg-1']);
    expect(mockReports).toHaveLength(1);
    expect(mockReports[0].code).toBe('SCHEDULED_NOT_SENT');
  });

  it('групповое «никто не получил» — то же и теми же словами', async () => {
    mockDue = [row({ id: 'g-1', attempts: 29, groupId: 'grp', senderName: 'Я' })];
    mockFanoutResult = { ok: true, members: 3, sent: 0, failed: 3 };
    await flushOnce();
    expect(mockDeleted).toEqual(['g-1']);
    expect(mockReports[0].code).toBe('SCHEDULED_NOT_SENT');
  });

  it('групповое «своя копия не легла» — своими словами: заново не набирать', async () => {
    mockDue = [row({ id: 'g-2', attempts: 29, groupId: 'grp', senderName: 'Я' })];
    mockOwnRow = 'failed';
    await flushOnce();
    expect(mockDeleted).toEqual(['g-2']);
    expect(mockReports[0].code).toBe('SCHEDULED_SENT_NOT_SAVED');
    expect(mockReports[0].message).not.toContain('заново');
  });
});

describe('попытку тратят только там, где правда пробовали отправить', () => {
  it('строка не прочиталась — ни попытки, ни снятия, сколько бы ни лежала', async () => {
    mockDue = [row({ readState: 'text_unreadable', attempts: 29 })];
    await flushOnce();
    expect(mockBumps).toEqual([]);
    expect(mockDeleted).toEqual([]);
  });

  it('часовой лимит выбран — попытка не тратится', async () => {
    mockDue = [row({ attempts: 29 })];
    mockLimitReached = true;
    await flushOnce();
    expect(mockBumps).toEqual([]);
    expect(mockDeleted).toEqual([]);
  });

  it('отметка ложится ДО отправки: упала отправка — попытка всё равно сочтена', async () => {
    const order: string[] = [];
    mockDue = [row()];
    mockSend = async () => { order.push('send'); throw new Error('boom'); };
    const local = jest.requireMock('../../storage/local') as {
      bumpScheduledAttemptChecked: jest.Mock;
    };
    local.bumpScheduledAttemptChecked.mockImplementationOnce(async (id: string, _p: number, a: number) => {
      order.push('bump');
      mockBumps.push({ id, attempts: a });
      return true;
    });
    await flushOnce();
    expect(order).toEqual(['bump', 'send']);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('удачная личная отправка снимает строку и молчит', async () => {
    mockDue = [row()];
    await flushOnce();
    expect(mockDeleted).toEqual(['msg-1']);
    expect(mockReports).toEqual([]);
  });

  it('отказ отправки (null) снимает строку сразу, не тратя запас', async () => {
    mockDue = [row()];
    mockSend = async () => null;
    await flushOnce();
    expect(mockDeleted).toEqual(['msg-1']);
    expect(mockReports[0].code).toBe('SCHEDULED_REFUSED');
  });

  it('отзыв прав в группе снимает строку сразу, сколько бы попыток ни осталось', async () => {
    mockDue = [row({ id: 'g-3', attempts: 0, groupId: 'grp', senderName: 'Я' })];
    mockFanoutResult = { ok: false, reason: 'denied', code: 'read_only' };
    await flushOnce();
    expect(mockDeleted).toEqual(['g-3']);
    expect(mockReports[0].code).toBe('SCHEDULED_DENIED');
  });

  it('заблокированный получатель — строка снимается молча, как и была', async () => {
    mockDue = [row()];
    mockBlocked = true;
    await flushOnce();
    expect(mockDeleted).toEqual(['msg-1']);
    expect(mockBumps).toEqual([]);
  });

  it('нет активного профиля — проход не трогает ничего', async () => {
    mockDue = [row()];
    mockActivePid = null;
    await flushOnce();
    expect(mockDeleted).toEqual([]);
    expect(mockBumps).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const read = (...p: string[]): string => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('строка расписания — единственное место, где живёт текст', () => {
    // Своя копия личного сообщения пишется внутри sendMessage, то есть после
    // того, как отправка удалась; групповая — после удачной рассылки. Снять
    // строку до этого значит потерять написанное.
    const flush = read('scheduledMessages.ts');
    const del = flush.indexOf('await deleteScheduledMessage(msg.id, pid);\n    } catch (e) {');
    expect(flush).toContain('await insertGroupMessageWithTouch(');
    expect(del).toBeGreaterThan(flush.indexOf('const cid = await svc.sendMessage('));
  });

  it('тик по-прежнему раз в полминуты: тридцать попыток — те же пятнадцать минут', () => {
    expect(read('scheduledMessages.ts')).toContain('const POLL_INTERVAL_MS = 30_000;');
  });

  it('первый тик случается сразу при запуске — в самое неподходящее время', () => {
    const src = read('scheduledMessages.ts');
    const at = src.indexOf('export function startScheduler(');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toContain('tick();');
    expect(body).toContain('setInterval(tick, POLL_INTERVAL_MS)');
  });

  it('нижней границы у выборки нет: сколько бы ни пролежало — попадёт в проход', () => {
    const local = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
    expect(local).toContain(
      "'SELECT * FROM scheduled_messages WHERE owner_profile_id = ? AND send_at <= ? ORDER BY send_at ASC'"
    );
  });
});

describe('форма исходников', () => {
  const local = (): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  it('столбец есть и в новой базе, и в миграции старой', () => {
    const src = local();
    expect(src).toContain('attempts INTEGER NOT NULL DEFAULT 0');
    expect(src).toContain(
      "await database.execAsync('ALTER TABLE scheduled_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');"
    );
  });

  it('строка, пережившая миграцию, приходит с нулём попыток, а не с undefined', () => {
    // Искать по всему файлу нельзя: та же строка есть у очереди отправки,
    // где счётчик попыток свой и давно.
    const src = local();
    const at = src.indexOf('function rowToScheduled(');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, src.indexOf('\n}\n', at))).toContain('attempts: r.attempts ?? 0,');
  });

  it('счёт попыток не бросает: отменять отправку из-за бухгалтерии нельзя', () => {
    const src = local();
    const at = src.indexOf('export async function bumpScheduledAttemptChecked(');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toContain('return false;');
    expect(body).not.toContain('throw');
  });
});
