/**
 * v4.32.500 — рэтчет: очередь отправки разбирается окном, а не целиком.
 *
 * Дефект: outboxDrain выбирал из таблицы ВСЕ живые строки без LIMIT и прогонял
 * каждую через decryptAtRestString. Потолки очереди — 10 000 строк по 256 КБ, —
 * то есть один вызов был вправе поднять в память примерно два с половиной
 * гигабайта расшифрованных конвертов. Неделя офлайна кончалась падением по
 * памяти ровно в ту секунду, когда телефон наконец ловил сеть; при следующем
 * подключении всё повторялось, потому что ни одна строка не успевала уйти.
 *
 * Тест держит две вещи сразу: пик порции ограничен, и при этом вся очередь
 * по-прежнему достижима за один вызов синхронизации — включая строки, лежащие
 * ЗА окном, целиком занятым чужим профилем.
 */
import * as fs from 'fs';
import * as path from 'path';

type Row = {
  id: number;
  kind: string;
  payload: string;
  createdAt: number;
  priority: number;
  ownerProfileId: number | null;
  attempts: number;
};

/** Значение потолка продублировано: фабрики jest.mock не видят внешних имён. */
const mockDrainLimit = 200;
const mockMaxAttempts = 20;

let mockRows: Row[] = [];
let mockCalls: Array<{ limit: number; offset: number }> = [];
let mockPeak = 0;
let mockOnline = true;
let mockActivePid: number | null = 1;
let mockService: { ownerProfileId: () => Promise<number | null>; retrySendDm: (p: unknown) => Promise<boolean> } | null =
  null;

const mockLive = (): Row[] =>
  mockRows
    .filter((r) => r.attempts < mockMaxAttempts)
    .sort((a, b) => b.priority - a.priority || a.id - b.id);

const mockDrain = async (limit: number, offset: number): Promise<Row[]> => {
  mockCalls.push({ limit, offset });
  const page = mockLive().slice(offset, offset + limit);
  mockPeak = Math.max(mockPeak, page.length);
  return page.map((r) => ({ ...r }));
};

jest.mock('../local', () => ({
  OUTBOX_DRAIN_LIMIT: 200,
  outboxDrain: (limit: number, offset: number) => mockDrain(limit, offset),
  outboxDeleteById: async (id: number) => {
    mockRows = mockRows.filter((r) => r.id !== id);
  },
  // Возвращает то же, что и настоящая: останется ли строка в следующей выборке.
  outboxIncrementAttempts: async (id: number) => {
    const row = mockRows.find((r) => r.id === id);
    if (!row) return false;
    row.attempts += 1;
    return row.attempts < mockMaxAttempts;
  },
  outboxPurgeDead: async () => undefined,
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: mockOnline }),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => (mockActivePid === null ? null : { id: mockActivePid }) },
}));

jest.mock('../../social/messaging', () => ({
  getMessagingService: () => mockService,
}));

jest.mock('../../social/dmRetryPayload', () => ({
  parseDmRetryPayload: (raw: string) => JSON.parse(raw) as unknown,
}));

jest.mock('../../social/ctlRetryPayload', () => ({
  parseCtlRetryPayload: (raw: string) => JSON.parse(raw) as unknown,
}));

jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => true }));
jest.mock('../../transport/ipfs/node', () => ({ addToIpfs: async () => 'cid' }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => true }));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runSyncIfOnline } from '../sync';

/** n строк вида 'dm', подряд по id, с указанным владельцем. */
function seed(n: number, ownerProfileId: number | null, firstId = 1, priority = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    kind: 'dm',
    payload: JSON.stringify({ messageId: `m${firstId + i}` }),
    createdAt: Date.now(),
    priority,
    ownerProfileId,
    attempts: 0,
  }));
}

beforeEach(() => {
  mockRows = [];
  mockCalls = [];
  mockPeak = 0;
  mockOnline = true;
  mockActivePid = 1;
  mockService = {
    ownerProfileId: async () => mockActivePid,
    retrySendDm: async () => true,
  };
});

describe('порция ограничена, очередь — нет', () => {
  it('пятьсот конвертов уходят, но в памяти зараз не больше окна', async () => {
    mockRows = seed(500, 1);
    await runSyncIfOnline();
    expect(mockPeak).toBeLessThanOrEqual(mockDrainLimit);
    expect(mockRows).toHaveLength(0);
    expect(mockCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('каждый заход просит именно окно, а не «сколько есть»', async () => {
    mockRows = seed(450, 1);
    await runSyncIfOnline();
    for (const c of mockCalls) expect(c.limit).toBe(mockDrainLimit);
  });

  it('пустая очередь — один заход и ни одного лишнего', async () => {
    await runSyncIfOnline();
    expect(mockCalls).toEqual([{ limit: mockDrainLimit, offset: 0 }]);
  });

  it('офлайн не трогает очередь вовсе', async () => {
    mockOnline = false;
    mockRows = seed(10, 1);
    await runSyncIfOnline();
    expect(mockCalls).toHaveLength(0);
    expect(mockRows).toHaveLength(10);
  });

  it('очередь ровно в одно окно разбирается за один заход', async () => {
    mockRows = seed(mockDrainLimit, 1);
    await runSyncIfOnline();
    expect(mockRows).toHaveLength(0);
    // Окно вернулось полным, поэтому второй заход обязателен — он и пустой.
    expect(mockCalls).toHaveLength(2);
  });
});

describe('сдвиг окна не теряет строки', () => {
  it('первое окно целиком чужое — свои конверты за ним всё равно уходят', async () => {
    mockRows = [...seed(mockDrainLimit, 2), ...seed(50, 1, mockDrainLimit + 1)];
    await runSyncIfOnline();
    // Чужие остались лежать, свои ушли.
    expect(mockRows.map((r) => r.ownerProfileId)).toEqual(Array(mockDrainLimit).fill(2));
  });

  it('сдвиг считает оставшиеся строки, а не размер окна', async () => {
    // Половина первого окна чужая, половина уходит: сдвиг обязан быть 100.
    const mixed: Row[] = [];
    for (let i = 0; i < mockDrainLimit; i++) {
      mixed.push(...seed(1, i % 2 === 0 ? 2 : 1, i + 1));
    }
    mockRows = [...mixed, ...seed(100, 1, mockDrainLimit + 1)];
    await runSyncIfOnline();
    expect(mockCalls[1]).toEqual({ limit: mockDrainLimit, offset: mockDrainLimit / 2 });
    expect(mockRows.every((r) => r.ownerProfileId === 2)).toBe(true);
    expect(mockRows).toHaveLength(mockDrainLimit / 2);
  });

  it('приоритет соблюдается через границу окна', async () => {
    const sentOrder: string[] = [];
    mockService = {
      ownerProfileId: async () => mockActivePid,
      retrySendDm: async (p) => {
        sentOrder.push((p as { messageId: string }).messageId);
        return true;
      },
    };
    mockRows = [...seed(300, 1), ...seed(1, 1, 9001, 5)];
    await runSyncIfOnline();
    expect(sentOrder[0]).toBe('m9001');
    expect(sentOrder).toHaveLength(301);
  });
});

describe('цикл обязан кончиться', () => {
  it('очередь, которую нечем отправить, не крутится вечно и не тратит попытки', async () => {
    mockService = null;
    mockRows = seed(500, 1);
    await runSyncIfOnline();
    expect(mockCalls.length).toBeLessThanOrEqual(4);
    expect(mockRows).toHaveLength(500);
    expect(mockRows.every((r) => r.attempts === 0)).toBe(true);
    // Сдвиг рос, а не топтался на месте.
    expect(mockCalls.map((c) => c.offset)).toEqual([0, mockDrainLimit, mockDrainLimit * 2]);
  });

  it('неудачная отправка тратит ровно одну попытку на строку за вызов', async () => {
    mockService = {
      ownerProfileId: async () => mockActivePid,
      retrySendDm: async () => false,
    };
    mockRows = seed(250, 1);
    await runSyncIfOnline();
    expect(mockRows).toHaveLength(250);
    expect(mockRows.every((r) => r.attempts === 1)).toBe(true);
  });

  /**
   * v4.32.581. Сдвиг окна считался по числу разобранных строк, а не по числу
   * оставшихся лежать на месте. Строка, которой последняя попытка довела
   * счётчик до потолка, из следующей выборки исключается самим запросом
   * (`WHERE COALESCE(attempts, 0) < ?`) — значит окно, сдвинутое на неё тоже,
   * перепрыгивало ровно один живой конверт на каждую «умершую» строку.
   */
  it('умершая строка не уносит с собой живую из следующего окна', async () => {
    mockService = {
      ownerProfileId: async () => mockActivePid,
      retrySendDm: async () => false,
    };
    mockRows = seed(250, 1);
    // Первые 50 доживают до потолка ровно на этом проходе.
    for (const r of mockRows.slice(0, 50)) r.attempts = mockMaxAttempts - 1;
    await runSyncIfOnline();
    const dead = mockRows.filter((r) => r.id <= 50);
    const alive = mockRows.filter((r) => r.id > 50);
    expect(dead.every((r) => r.attempts === mockMaxAttempts)).toBe(true);
    // Ни одна из 200 оставшихся не пропущена — включая хвост за первым окном.
    expect(alive).toHaveLength(200);
    expect(alive.every((r) => r.attempts === 1)).toBe(true);
  });

  it('строки, выбравшие все попытки, из выборки уходят сами', async () => {
    mockRows = seed(10, 1);
    for (const r of mockRows) r.attempts = mockMaxAttempts;
    await runSyncIfOnline();
    expect(mockRows).toHaveLength(10);
    expect(mockCalls).toHaveLength(1);
  });
});

describe('исходники', () => {
  const local = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
  const sync = fs.readFileSync(path.join(__dirname, '..', 'sync.ts'), 'utf8');

  it('запрос выбирает окно, а не всю таблицу', () => {
    expect(local).toContain('LIMIT ? OFFSET ?');
    expect(local).toMatch(/export const OUTBOX_DRAIN_LIMIT = (\d+);/);
    const declared = Number(/export const OUTBOX_DRAIN_LIMIT = (\d+);/.exec(local)?.[1]);
    // Мок повторяет константу — если её поменяют, тест обязан это заметить.
    expect(declared).toBe(mockDrainLimit);
  });

  it('мусор в аргументах не снимает потолок', () => {
    expect(local).toContain('Number.isFinite(limit) && limit > 0');
    expect(local).toContain('Math.min(Math.floor(limit), OUTBOX_MAX_ROWS)');
    expect(local).toContain('Number.isFinite(offset) && offset > 0');
  });

  it('синхронизация ходит окном и сдвигает его на оставшиеся строки', () => {
    // v4.32.522: третьим аргументом — активный профиль. Чужие строки теперь
    // отсеиваются запросом, а не после расшифровки, иначе очередь соседнего
    // аккаунта занимала места в окне и до своих конвертов дело не доходило.
    expect(sync).toContain('await outboxDrain(OUTBOX_DRAIN_LIMIT, offset, activePid)');
    expect(sync.match(/outboxDrain\(/g)).toHaveLength(1);
    expect(sync).toContain('offset += kept;');
    expect(sync).toContain('for (let pass = 0; pass < OUTBOX_DRAIN_PASSES; pass++)');
  });

  it('окон хватает на всю очередь целиком', () => {
    const passes = Number(/const OUTBOX_DRAIN_PASSES = (\d+);/.exec(sync)?.[1]);
    const maxRows = Number(/const OUTBOX_MAX_ROWS = ([\d_]+);/.exec(local)?.[1].replace(/_/g, ''));
    expect(passes * mockDrainLimit).toBeGreaterThanOrEqual(maxRows);
  });

  it('каждая ветка, оставляющая строку на месте, учтена в сдвиге', () => {
    // Чужой профиль, отложенная отправка, неудачная попытка и её же catch.
    expect(sync.match(/kept \+= 1;/g)).toHaveLength(4);
  });
});

describe('фикстура до-фиксного кода', () => {
  const OUTBOX_MAX_ROWS = 10_000;
  const OUTBOX_MAX_PAYLOAD_BYTES = 256 * 1024;
  const legacySelect = (rows: number): number => rows;
  const windowSelect = (rows: number, limit: number): number => Math.min(rows, limit);

  it('без окна один вызов был вправе расшифровать гигабайты', () => {
    const peak = legacySelect(OUTBOX_MAX_ROWS) * OUTBOX_MAX_PAYLOAD_BYTES;
    expect(peak).toBeGreaterThan(2 * 1024 * 1024 * 1024);
  });

  it('с окном пик держится в десятках мегабайт', () => {
    const peak = windowSelect(OUTBOX_MAX_ROWS, mockDrainLimit) * OUTBOX_MAX_PAYLOAD_BYTES;
    expect(peak).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
