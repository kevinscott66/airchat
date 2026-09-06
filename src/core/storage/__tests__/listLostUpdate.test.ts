/**
 * Списки, которые правят обе стороны, больше не теряют половину (v4.32.615).
 *
 * Дефект. toggleReaction, markGroupMessageSeen и markStoryViewed читали
 * зашифрованный столбец, разбирали список, дописывали в него своё и писали
 * обратно. Между чтением и записью стоял `await` за ключом данных, а входящие
 * конверты разбираются без ожидания (`void this.handlePubsubLine(...)` в
 * messaging.ts). Две посылки по одному сообщению читали ОДИН И ТОТ ЖЕ список,
 * обе дописывали в него своё, и вторая запись стирала первую.
 *
 * Видно это было так: реакция собеседника пропадала через мгновение после
 * появления, прочитавший исчезал из списка, зритель сторис не засчитывался.
 * Ошибки при этом не показывали — обе операции сообщали об успехе.
 *
 * Стенд ниже честно разводит вызовы по микрозадачам: и чтение, и запись
 * уходят за границу `setImmediate`, поэтому без общей очереди потоки успевают
 * переплестись. Записи внутри открытой транзакции становятся видимыми только
 * после COMMIT и пропадают при ROLLBACK — как в настоящей базе.
 */
type Run = { changes: number; lastInsertRowId: number };

/** Три столбца-списка, за которые идёт спор. */
let mockReactions = new Map<string, string | null>();
let mockSeen = new Map<string, string | null>();
let mockViewed = new Map<string, string | null>();

let mockOpen = false;
let mockStaged: (() => void)[] = [];
let mockNestedBegins = 0;

function mockExec(sql: string): void {
  const head = sql.trim().toUpperCase();
  if (head.startsWith('BEGIN')) {
    if (mockOpen) {
      mockNestedBegins += 1;
      throw new Error('cannot start a transaction within a transaction');
    }
    mockOpen = true;
    mockStaged = [];
    return;
  }
  if (head.startsWith('COMMIT')) {
    if (!mockOpen) throw new Error('cannot commit - no transaction is active');
    for (const apply of mockStaged) apply();
    mockStaged = [];
    mockOpen = false;
    return;
  }
  if (head.startsWith('ROLLBACK')) {
    if (!mockOpen) throw new Error('cannot rollback - no transaction is active');
    mockStaged = [];
    mockOpen = false;
  }
}

/** Запись видна сразу вне транзакции и только после COMMIT внутри неё. */
function mockWrite(apply: () => void): void {
  if (mockOpen) mockStaged.push(apply);
  else apply();
}

/** Уступка планировщику: без неё потоки не переплелись бы и стенд был бы пуст. */
function mockYield(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async (sql: string) => {
      mockExec(sql);
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []): Promise<Run> => {
      await mockYield();
      const value = (params[0] ?? null) as string | null;
      const id = String(params[1] ?? '');
      if (sql.includes('SET reactions =')) mockWrite(() => { mockReactions.set(id, value); });
      else if (sql.includes('SET seen_by =')) mockWrite(() => { mockSeen.set(id, value); });
      else if (sql.includes('SET viewed_by =')) mockWrite(() => { mockViewed.set(id, value); });
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      await mockYield();
      const id = String(params[0] ?? '');
      if (sql.includes('SELECT reactions FROM')) {
        return mockReactions.has(id) ? { reactions: mockReactions.get(id) ?? null } : null;
      }
      if (sql.includes('SELECT seen_by FROM')) {
        return mockSeen.has(id) ? { seen_by: mockSeen.get(id) ?? null } : null;
      }
      if (sql.includes('SELECT viewed_by FROM')) {
        return mockViewed.has(id) ? { viewed_by: mockViewed.get(id) ?? null } : null;
      }
      return null;
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    return new Uint8Array(32);
  }),
  encryptAtRestString: jest.fn((v: string) => v),
  encryptAtRestNullable: jest.fn((v: string | null) => v),
  decryptAtRestString: jest.fn((v: string) => v),
  decryptAtRestNullable: jest.fn((v: string | null) => v),
  isAtRestCiphertext: jest.fn(() => false),
  resetDataEncryptionKeyCache: jest.fn(),
  readAtRestCell: jest.fn((stored: string | null) =>
    stored === null || stored === undefined ? { state: 'absent' } : { state: 'plain', text: stored }
  ),
}));

import * as fs from 'fs';
import * as path from 'path';

import { markGroupMessageSeen, markStoryViewed, toggleReaction } from '../local';
import type { ReactionScope } from '../reactionScope';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

const MSG = 'm1';
const GROUP = 'g1';
const PID = 1;
const CHAT: ReactionScope = { group: false, contactPubB64: 'peerAAA', ownerProfileId: PID };

/** Кто именно поставил эти эмодзи, в отсортированном виде. */
function actorsOf(stored: string | null | undefined): Record<string, string[]> {
  const map = JSON.parse(stored ?? '{}') as Record<string, string[]>;
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(map).sort()) out[key] = [...map[key]].sort();
  return out;
}

beforeEach(() => {
  mockReactions = new Map([[MSG, null]]);
  mockSeen = new Map([[MSG, null]]);
  mockViewed = new Map([['s1', null]]);
  mockOpen = false;
  mockStaged = [];
  mockNestedBegins = 0;
});

describe('реакции: одновременные не стирают друг друга', () => {
  it('две реакции разом — обе на месте', async () => {
    const [a, b] = await Promise.all([
      toggleReaction(MSG, '👍', 'alice', true, CHAT),
      toggleReaction(MSG, '🔥', 'bob', true, CHAT),
    ]);
    expect(a).toEqual({ ok: true, on: true });
    expect(b).toEqual({ ok: true, on: true });
    expect(actorsOf(mockReactions.get(MSG))).toEqual({ '👍': ['alice'], '🔥': ['bob'] });
    expect(mockOpen).toBe(false);
    expect(mockNestedBegins).toBe(0);
  });

  it('один эмодзи от двух человек — оба в списке', async () => {
    await Promise.all([
      toggleReaction(MSG, '👍', 'alice', true, CHAT),
      toggleReaction(MSG, '👍', 'bob', true, CHAT),
    ]);
    expect(actorsOf(mockReactions.get(MSG))).toEqual({ '👍': ['alice', 'bob'] });
  });

  it('пять разом — не теряется ни одна', async () => {
    const actors = ['a1', 'a2', 'a3', 'a4', 'a5'];
    await Promise.all(actors.map((who) => toggleReaction(MSG, '👍', who, true, CHAT)));
    expect(actorsOf(mockReactions.get(MSG))).toEqual({ '👍': actors });
  });

  it('чужой строки нет — записи не появляется', async () => {
    const res = await toggleReaction('нет-такого', '👍', 'alice', true, CHAT);
    expect(res).toEqual({ ok: false, reason: 'missing' });
    expect(mockReactions.get(MSG)).toBeNull();
  });
});

describe('прочитавшие и посмотревшие: то же самое', () => {
  it('два читателя в группе разом — оба записаны', async () => {
    await Promise.all([
      markGroupMessageSeen(MSG, GROUP, PID, 'alice'),
      markGroupMessageSeen(MSG, GROUP, PID, 'bob'),
    ]);
    expect(JSON.parse(mockSeen.get(MSG) ?? '[]').sort()).toEqual(['alice', 'bob']);
  });

  it('два зрителя сторис разом — оба засчитаны', async () => {
    await Promise.all([
      markStoryViewed('s1', 'alice', PID),
      markStoryViewed('s1', 'bob', PID),
    ]);
    expect(JSON.parse(mockViewed.get('s1') ?? '[]').sort()).toEqual(['alice', 'bob']);
  });

  it('повтор того же читателя ничего не добавляет', async () => {
    await markGroupMessageSeen(MSG, GROUP, PID, 'alice');
    await markGroupMessageSeen(MSG, GROUP, PID, 'alice');
    expect(JSON.parse(mockSeen.get(MSG) ?? '[]')).toEqual(['alice']);
  });

  it('стенд не пустой: последовательные вызовы дают тот же итог', async () => {
    await markStoryViewed('s1', 'alice', PID);
    await markStoryViewed('s1', 'bob', PID);
    expect(JSON.parse(mockViewed.get('s1') ?? '[]').sort()).toEqual(['alice', 'bob']);
  });
});

describe('храповик: чтение и запись списка идут внутри транзакции', () => {
  /** Строки кода без комментариев — доки цитируют сам дефект. */
  const CODE = SOURCE.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');

  /** Тело функции от её объявления до закрывающей скобки первого уровня. */
  function bodyOf(head: string): string {
    const start = CODE.indexOf(head);
    expect(start).toBeGreaterThan(-1);
    return CODE.slice(start, CODE.indexOf('\n}', start));
  }

  it.each([
    ['export async function toggleReaction(', 'applyReactionInTx('],
    ['export async function markGroupMessageSeen(', 'recordGroupSeenInTx('],
    ['export async function markStoryViewed(', 'recordStoryViewInTx('],
  ])('%s открывает транзакцию до чтения', (head, helper) => {
    const body = bodyOf(head);
    const begin = body.indexOf('await beginImmediate(');
    const call = body.indexOf(helper);
    expect(begin).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(begin);
    expect(body).toContain('await txn.commit()');
    expect(body).toContain('await txn.rollback()');
  });

  it.each([
    ['async function applyReactionInTx(', 'SELECT reactions FROM'],
    ['async function recordGroupSeenInTx(', 'SELECT seen_by FROM'],
    ['async function recordStoryViewInTx(', 'SELECT viewed_by FROM'],
  ])('%s держит и чтение, и запись', (head, select) => {
    const body = bodyOf(head);
    expect(body).toContain(select);
    expect(body).toContain('await d.runAsync(');
    // Помощник не открывает транзакцию сам — иначе она вложилась бы в чужую.
    expect(body).not.toContain('beginImmediate(');
  });
});
