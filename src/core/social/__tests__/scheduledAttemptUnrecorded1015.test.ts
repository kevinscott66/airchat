/**
 * Незаписанная попытка снимала предел, и сообщение уходило по кругу (v4.32.1015).
 *
 * Дефект. Номер попытки собирают из строки расписания: `(msg.attempts ?? 0) + 1`.
 * Отметку о нём кладут в базу ДО отправки — именно затем, чтобы попытка, о
 * которой никто не записал, не повторялась вечно. Но ответ `false` («база
 * отказала, отметка не легла») выбрасывали, и проход шёл отправлять дальше.
 *
 * Цена. Занятая база отказывает на запись, пока чтение идёт как шло, — а сеть
 * от неё не зависит вовсе. Значит исход такой: отметка не легла, сообщение
 * ушло получателю, а снять строку той же базе нечем — `deleteScheduledMessage`
 * идёт тем же `runAsync` и бросает. Бросок ловит нижняя ловушка, и там
 * спрашивают `attempt >= 30` — а `attempt` остался прежним, потому что
 * счётчик не сдвинулся. Предел не наступит никогда. Через полминуты тот же
 * тик отправляет то же сообщение второй раз, потом третий, и так без границы:
 * получатель видит один и тот же текст (и те же вложения) каждые полминуты.
 * С работающим счётчиком поток хотя бы кончается на тридцатой попытке.
 *
 * Правка. Не легла отметка — в этот тик не отправляем. Ничего не потеряно:
 * строка остаётся лежать, она видна в списке запланированных, а следующий тик
 * через полминуты попробует снова. Когда база освободится, отметка ляжет и
 * сообщение уйдёт — один раз.
 *
 * Границы. Ветки, где отправлять и не пробовали (строка не прочиталась,
 * выбран часовой лимит), отметку не спрашивают вовсе — их отказ базы не
 * касается, и вели они себя как вели.
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

let mockDue: Row[] = [];
/** Что ушло получателю. Главная улика: дублей тут быть не должно. */
const mockSent: string[] = [];
/** Что разослано в группу. */
const mockFanned: string[] = [];
const mockDeleted: string[] = [];
const mockBumps: Array<{ id: string; attempts: number }> = [];
const mockReports: Array<{ code: string; message: string }> = [];

/** База принимает отметку о попытке? */
let mockBumpOk = true;
/** ...и снятие строки? Занятая база отказывает на обеих записях сразу. */
let mockDeleteThrows = false;
let mockFanoutResult: unknown = { ok: true, members: 2, sent: 2, failed: 0 };
let mockOwnRow: 'ok' | 'failed' = 'ok';
let mockBlocked = false;
let mockLimitReached = false;

jest.mock('uuid', () => ({ v4: () => 'uuid-stub' }));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (_to: string, text: string) => { mockSent.push(text); return 'cid'; },
  }),
}));

jest.mock('../../storage/local', () => ({
  listDueScheduledMessages: jest.fn(async () => mockDue),
  deleteScheduledMessage: jest.fn(async (id: string) => {
    if (mockDeleteThrows) throw new Error('database is locked');
    mockDeleted.push(id);
  }),
  bumpScheduledAttemptChecked: jest.fn(async (id: string, _pid: number, attempts: number) => {
    mockBumps.push({ id, attempts });
    return mockBumpOk;
  }),
  insertScheduledMessage: jest.fn(async () => undefined),
  insertGroupMessageWithTouch: jest.fn(async () => mockOwnRow),
}));

jest.mock('../groupMessaging', () => ({
  fanoutGroupMessage: jest.fn(async (_gid: string, text: string) => {
    mockFanned.push(text);
    return mockFanoutResult;
  }),
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

import { resetScheduledHoldLog } from '../scheduledDispatch';
import { startScheduler, stopScheduler } from '../scheduledMessages';

const HOUR = 3_600_000;
const PUB = 'A'.repeat(43) + '=';

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'msg-1',
    contactPubB64: PUB,
    text: 'спокойной ночи',
    mediaCids: null,
    sendAt: Date.now() - 9 * HOUR,
    ownerProfileId: 1,
    createdAt: Date.now() - 10 * HOUR,
    attempts: 0,
    ...over,
  };
}

/** Один настоящий проход. */
async function flushOnce(): Promise<void> {
  startScheduler();
  stopScheduler();
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mockDue = [];
  mockSent.length = 0;
  mockFanned.length = 0;
  mockDeleted.length = 0;
  mockBumps.length = 0;
  mockReports.length = 0;
  mockBumpOk = true;
  mockDeleteThrows = false;
  mockFanoutResult = { ok: true, members: 2, sent: 2, failed: 0 };
  mockOwnRow = 'ok';
  mockBlocked = false;
  mockLimitReached = false;
  resetScheduledHoldLog();
});

afterEach(() => stopScheduler());

describe('попытку не записали — значит и не пробуем', () => {
  it('личное: отметка не легла — отправки в этот тик нет', async () => {
    mockDue = [row()];
    mockBumpOk = false;
    await flushOnce();

    expect(mockSent).toEqual([]);
  });

  it('строка при этом остаётся лежать: терять нечего', async () => {
    mockDue = [row()];
    mockBumpOk = false;
    await flushOnce();

    expect(mockDeleted).toEqual([]);
    expect(mockReports).toEqual([]);
  });

  it('групповое: рассылки тоже нет', async () => {
    mockDue = [row({ id: 'g-1', groupId: 'grp', senderName: 'Я' })];
    mockBumpOk = false;
    await flushOnce();

    expect(mockFanned).toEqual([]);
    expect(mockDeleted).toEqual([]);
  });

  it('база освободилась к следующему тику — сообщение уходит один раз', async () => {
    mockDue = [row()];
    mockBumpOk = false;
    await flushOnce();
    mockBumpOk = true;
    await flushOnce();

    expect(mockSent).toEqual(['спокойной ночи']);
    expect(mockDeleted).toEqual(['msg-1']);
  });
});

describe('занятая база больше не отправляет одно и то же по кругу', () => {
  /**
   * Тот самый исход целиком: записи не принимаются, сеть работает. Отметка не
   * легла, снять строку нечем — `deleteScheduledMessage` бросает, — а предел в
   * тридцать попыток не наступит, потому что счётчик стоит на месте.
   */
  it('два тика подряд — получатель не получает сообщение дважды', async () => {
    mockDue = [row()];
    mockBumpOk = false;
    mockDeleteThrows = true;
    await flushOnce();
    await flushOnce();

    expect(mockSent).toEqual([]);
  });

  it('и в группу не рассылают дважды', async () => {
    mockDue = [row({ id: 'g-1', groupId: 'grp', senderName: 'Я' })];
    mockBumpOk = false;
    mockDeleteThrows = true;
    await flushOnce();
    await flushOnce();

    expect(mockFanned).toEqual([]);
  });

  it('о потере не рапортуют: сообщение никуда не делось', async () => {
    mockDue = [row({ attempts: 29 })];
    mockBumpOk = false;
    mockDeleteThrows = true;
    await flushOnce();

    expect(mockReports).toEqual([]);
    expect(mockSent).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: отметка легла — всё как было', () => {
  it('личное уходит и строка снимается', async () => {
    mockDue = [row()];
    await flushOnce();

    expect(mockSent).toEqual(['спокойной ночи']);
    expect(mockDeleted).toEqual(['msg-1']);
  });

  it('групповое рассылается', async () => {
    mockDue = [row({ id: 'g-1', groupId: 'grp', senderName: 'Я' })];
    await flushOnce();

    expect(mockFanned).toEqual(['спокойной ночи']);
    expect(mockDeleted).toEqual(['g-1']);
  });

  it('номер попытки собирают из строки и кладут до отправки', async () => {
    mockDue = [row({ attempts: 7 })];
    await flushOnce();

    expect(mockBumps).toEqual([{ id: 'msg-1', attempts: 8 }]);
    expect(mockSent).toEqual(['спокойной ночи']);
  });
});

describe('ГРАНИЦА: где не пробовали отправить — отметку и не спрашивают', () => {
  it('часовой лимит выбран: отказ базы этой ветки не касается', async () => {
    mockDue = [row({ attempts: 29 })];
    mockLimitReached = true;
    mockBumpOk = false;
    await flushOnce();

    expect(mockBumps).toEqual([]);
    expect(mockDeleted).toEqual([]);
  });

  it('строка не прочиталась: тоже без отметки и без снятия', async () => {
    mockDue = [row({ readState: 'text_unreadable' })];
    mockBumpOk = false;
    await flushOnce();

    expect(mockBumps).toEqual([]);
    expect(mockSent).toEqual([]);
  });

  it('заблокированный получатель: строку снимают, попытку не тратят', async () => {
    mockDue = [row()];
    mockBlocked = true;
    mockBumpOk = false;
    await flushOnce();

    expect(mockBumps).toEqual([]);
    expect(mockDeleted).toEqual(['msg-1']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const read = (...p: string[]): string => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const local = (): string => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  it('снятие строки по-прежнему не ловит свою ошибку: та же база — тот же отказ', () => {
    const src = local();
    const at = src.indexOf('export async function deleteScheduledMessage(');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toContain("d.runAsync('DELETE FROM scheduled_messages");
    expect(body).not.toContain('catch');
  });

  it('номер попытки по-прежнему собирают из строки, а не хранят в памяти прохода', () => {
    expect(read('scheduledMessages.ts')).toContain('const attempt = (msg.attempts ?? 0) + 1;');
  });

  it('предел по-прежнему сравнивают с этим номером — стоячий счётчик его снимает', () => {
    const src = read('scheduledMessages.ts');
    expect(src).toContain('const ABANDON_AFTER_ATTEMPTS = 30;');
    expect(src).toContain('if (attempt >= ABANDON_AFTER_ATTEMPTS) {');
  });

  it('тик по-прежнему раз в полминуты: круг был бы частым', () => {
    expect(read('scheduledMessages.ts')).toContain('const POLL_INTERVAL_MS = 30_000;');
  });
});
