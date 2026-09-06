/**
 * Две записи разом больше не отменяют друг друга (v4.32.615).
 *
 * Дефект. Соединение с базой одно на весь процесс, ручных `BEGIN IMMEDIATE` в
 * local.ts было девятнадцать, очереди между ними не было. Транзакции одного
 * соединения в SQLite не вкладываются: пока открыта первая, второй `BEGIN`
 * отвечает «cannot start a transaction within a transaction». Открытие стоит
 * перед `try` во всех девятнадцати местах, поэтому отказ уносил вызов целиком,
 * не дойдя ни до одной записи: saveChatMessage и import* пробрасывали ошибку
 * наверх, touchConversation и миграции гасили её в log.warn.
 *
 * Сойтись этим вызовам есть где: saveChatMessage и touchConversation идут
 * парой на каждое входящее сообщение, а сообщения приходят пачками — при
 * переигрывании накопленного за двенадцать часов, при доставке двумя
 * транспортами сразу, при разборе облачного снимка.
 *
 * Стенд ниже повторяет правило вложенности честно: мок бросает ту же ошибку,
 * что и настоящий SQLite, а строки, записанные при открытой транзакции,
 * становятся видимыми только после COMMIT и пропадают при ROLLBACK.
 */
type Run = { changes: number; lastInsertRowId: number };

let mockOpen = false;
let mockStaged: string[] = [];
let mockCommitted: string[] = [];
let mockNestedBegins = 0;
/** Идентификатор, на записи которого база «падает» — для проверки отката. */
let mockPoison: string | null = null;

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
    mockCommitted = mockCommitted.concat(mockStaged);
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

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async (sql: string) => {
      mockExec(sql);
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []): Promise<Run> => {
      // Настоящая запись тоже уходит за границу микрозадачи; без этой уступки
      // потоки не успели бы переплестись и стенд ничего бы не проверял.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      const id = String(params[1] ?? '');
      if (id && id === mockPoison) throw new Error('SQLITE_FULL: database or disk is full');
      if (sql.includes('sync_entity_heads')) {
        if (mockOpen) mockStaged.push(id);
        else mockCommitted.push(id);
      }
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
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
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => v),
  encryptAtRestNullable: jest.fn((v: string | null) => v),
  decryptAtRestString: jest.fn((v: string) => v),
  decryptAtRestNullable: jest.fn((v: string | null) => v),
  isAtRestCiphertext: jest.fn(() => false),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { saveSyncEntityHeads } from '../local';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

/** Голова синхронизации с заданным идентификатором. */
function head(entityId: string): Parameters<typeof saveSyncEntityHeads>[0][number] {
  return {
    entityKind: 'message',
    entityId,
    ownerProfileId: 1,
    revision: 1,
    fingerprint: null,
    deleted: false,
    updatedAt: 1,
  };
}

beforeEach(() => {
  mockOpen = false;
  mockStaged = [];
  mockCommitted = [];
  mockNestedBegins = 0;
  mockPoison = null;
});

describe('транзакции одного соединения выстраиваются в очередь', () => {
  it('два одновременных писателя доходят оба', async () => {
    await Promise.all([
      saveSyncEntityHeads([head('a1'), head('a2')]),
      saveSyncEntityHeads([head('b1'), head('b2')]),
    ]);
    expect(mockNestedBegins).toBe(0);
    expect([...mockCommitted].sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(mockOpen).toBe(false);
  });

  it('пять писателей разом — ни одна пачка не теряется', async () => {
    const packs = ['p1', 'p2', 'p3', 'p4', 'p5'];
    await Promise.all(packs.map((id) => saveSyncEntityHeads([head(id)])));
    expect(mockNestedBegins).toBe(0);
    expect([...mockCommitted].sort()).toEqual(packs);
  });

  it('пачки не перемешиваются: каждая ложится целиком', async () => {
    await Promise.all([
      saveSyncEntityHeads([head('a1'), head('a2'), head('a3')]),
      saveSyncEntityHeads([head('b1'), head('b2'), head('b3')]),
    ]);
    const letters = mockCommitted.map((id) => id[0]).join('');
    expect(['aaabbb', 'bbbaaa']).toContain(letters);
  });

  it('упавший посередине откатывается один и очередь не запирает', async () => {
    mockPoison = 'b2';
    const results = await Promise.allSettled([
      saveSyncEntityHeads([head('a1')]),
      saveSyncEntityHeads([head('b1'), head('b2')]),
      saveSyncEntityHeads([head('c1')]),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    // b1 записался, но лёг вместе с b2 в откате — половины пачки не остаётся.
    expect([...mockCommitted].sort()).toEqual(['a1', 'c1']);
    expect(mockOpen).toBe(false);
    expect(mockNestedBegins).toBe(0);
  });

  it('после отката очередь работает дальше', async () => {
    mockPoison = 'bad';
    await expect(saveSyncEntityHeads([head('bad')])).rejects.toThrow('SQLITE_FULL');
    mockPoison = null;
    await saveSyncEntityHeads([head('after')]);
    expect(mockCommitted).toEqual(['after']);
  });

  it('стенд не пустой: вложенный BEGIN на этом моке падает так же, как в SQLite', () => {
    mockExec('BEGIN IMMEDIATE;');
    expect(() => mockExec('BEGIN IMMEDIATE;')).toThrow(
      'cannot start a transaction within a transaction'
    );
    expect(mockNestedBegins).toBe(1);
    mockExec('ROLLBACK;');
  });
});

describe('храповик: транзакцию открывает только помощник', () => {
  /** Строки кода без комментариев — доки цитируют сам дефект. */
  const CODE = SOURCE.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');

  /** Код за вычетом самого помощника: внутри него BEGIN/COMMIT законны. */
  const OUTSIDE = ((): string => {
    const start = CODE.indexOf('async function beginImmediate(');
    const end = CODE.indexOf('\n}', start) + 2;
    return CODE.slice(0, start) + CODE.slice(end);
  })();

  it('ручных BEGIN IMMEDIATE вне помощника не осталось', () => {
    expect(OUTSIDE).not.toMatch(/execAsync\(\s*'BEGIN/);
    expect(OUTSIDE).not.toMatch(/execAsync\(\s*'COMMIT/);
    expect(OUTSIDE).not.toMatch(/execAsync\(\s*'ROLLBACK/);
    // Проверка не пустая: у помощника эти строки на месте.
    expect(CODE).toMatch(/execAsync\('BEGIN IMMEDIATE;'\)/);
  });

  it('все двадцать два места зовут помощника и все закрывают транзакцию', () => {
    expect((OUTSIDE.match(/await beginImmediate\(/g) ?? []).length).toBe(22);
    expect((OUTSIDE.match(/await txn\.rollback\(\)/g) ?? []).length).toBe(22);
    // Фиксаций двадцать три: touchGroupConversation фиксирует ещё и на раннем
    // выходе, иначе транзакция уехала бы за пределы вызова.
    expect((OUTSIDE.match(/await txn\.commit\(\)/g) ?? []).length).toBe(23);
  });

  it('помощник ждёт предшественника до BEGIN, а не после', () => {
    const start = CODE.indexOf('async function beginImmediate(');
    expect(start).toBeGreaterThan(-1);
    const body = CODE.slice(start, CODE.indexOf('\n}', start));
    const wait = body.indexOf('await previous;');
    const begin = body.indexOf("execAsync('BEGIN IMMEDIATE;')");
    expect(wait).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(wait);
  });

  it('место в очереди отпускается и при провале самого COMMIT', () => {
    const start = CODE.indexOf('async function beginImmediate(');
    const body = CODE.slice(start, CODE.indexOf('\n}', start));
    expect((body.match(/} finally \{\n\s+close\(\);\n\s+\}/g) ?? []).length).toBe(2);
  });
});
