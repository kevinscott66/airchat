/**
 * Личное сообщение и его след в списке чатов — одной транзакцией (v4.32.776).
 *
 * Дефект. Приёмник сначала писал строку, а потом двигал список переписок — и
 * даже без `await`: `void touchConversation(...)`. Та гасит любой свой отказ
 * внутри себя (`log.warn('conversation_touch_failed')`) и отвечает `void`,
 * так что приёмник считал кадр разобранным и двигал метку «докуда прочитано»
 * у ретранслятора. Починить это было нечем: второй раз тот же конверт не
 * придёт, а если и придёт — запись ответит `'duplicate'`, и приёмник до следа
 * не дойдёт (так задумано с v4.32.477: счётчик не растёт на каждую копию
 * одного сообщения, приезжающую по сети, через ретранслятор и за push'ем).
 *
 * Итог: доля секунды занятой базы навсегда съедала единицу непрочитанного, а
 * разговор оставался в списке внизу, со вчерашним превью и вчерашним временем
 * — при том, что само сообщение внутри переписки лежало и открывалось.
 *
 * Обратный порядок не помогал: отказ записи после удавшегося следа дал бы на
 * перезапросе второй инкремент. Лечит только неделимость.
 *
 * Групповой брат этой правки — groupMessageTouchAtomic775.
 *
 * Стенд ниже ведёт себя как настоящая база: записи внутри открытой транзакции
 * становятся видимыми только после COMMIT и пропадают при ROLLBACK.
 */
type Run = { changes: number; lastInsertRowId: number };

/** Строки chat_messages по id. */
let mockRows = new Map<string, unknown[]>();
/** Строка переписки в списке чатов; null — переписки ещё нет. */
let mockConv: {
  unread_count: number;
  last_message_preview: string | null;
  last_message_direction: string | null;
} | null = null;
/** На чём база спотыкается: 'none', 'insert' или 'touch'. */
let mockFailOn: 'none' | 'insert' | 'touch' = 'none';

let mockOpen = false;
let mockStaged: (() => void)[] = [];
let mockNestedBegins = 0;
/** Порядок обращений к базе — по нему видно, что ключ достаётся до BEGIN. */
let mockTrace: string[] = [];

function mockExec(sql: string): void {
  const head = sql.trim().toUpperCase();
  if (head.startsWith('BEGIN')) {
    if (mockOpen) {
      mockNestedBegins += 1;
      throw new Error('cannot start a transaction within a transaction');
    }
    mockOpen = true;
    mockStaged = [];
    mockTrace.push('begin');
    return;
  }
  if (head.startsWith('COMMIT')) {
    if (!mockOpen) throw new Error('cannot commit - no transaction is active');
    for (const apply of mockStaged) apply();
    mockStaged = [];
    mockOpen = false;
    mockTrace.push('commit');
    return;
  }
  if (head.startsWith('ROLLBACK')) {
    if (!mockOpen) throw new Error('cannot rollback - no transaction is active');
    mockStaged = [];
    mockOpen = false;
    mockTrace.push('rollback');
  }
}

/** Запись видна сразу вне транзакции и только после COMMIT внутри неё. */
function mockApply(apply: () => void): void {
  if (mockOpen) mockStaged.push(apply);
  else apply();
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async (sql: string) => {
      mockExec(sql);
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []): Promise<Run> => {
      if (sql.includes('INSERT OR IGNORE INTO chat_messages')) {
        mockTrace.push('insert');
        if (mockFailOn === 'insert') throw new Error('database is locked');
        const id = String(params[0] ?? '');
        if (mockRows.has(id)) return { changes: 0, lastInsertRowId: 0 };
        mockApply(() => { mockRows.set(id, params); });
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (sql.includes('UPDATE conversations SET last_message_at = ?, last_message_preview')) {
        mockTrace.push('touch');
        if (mockFailOn === 'touch') throw new Error('database is locked');
        const preview = (params[1] ?? null) as string | null;
        const direction = (params[2] ?? null) as string | null;
        const unread = Number(params[3] ?? 0);
        mockApply(() => {
          if (!mockConv) return;
          mockConv.last_message_preview = preview;
          mockConv.last_message_direction = direction;
          mockConv.unread_count = unread;
        });
        return { changes: 1, lastInsertRowId: 0 };
      }
      if (sql.includes('INSERT OR IGNORE INTO conversations (contact_pub_b64, owner_profile_id, unread_count')) {
        mockTrace.push('touch');
        if (mockFailOn === 'touch') throw new Error('database is locked');
        const unread = Number(params[2] ?? 0);
        const preview = (params[4] ?? null) as string | null;
        const direction = (params[5] ?? null) as string | null;
        mockApply(() => {
          mockConv = { unread_count: unread, last_message_preview: preview, last_message_direction: direction };
        });
        return { changes: 1, lastInsertRowId: 1 };
      }
      return { changes: 0, lastInsertRowId: 0 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT unread_count, disappear_after_ms, last_message_at FROM conversations')) {
        mockTrace.push('select');
        return mockConv
          ? { unread_count: mockConv.unread_count, disappear_after_ms: null, last_message_at: 1 }
          : null;
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

// Настройка «автоудаление новых чатов» читается из kv и к неделимости
// отношения не имеет — важно лишь, что читается она ДО BEGIN.
jest.mock('../defaultDisappear', () => ({
  getDefaultDisappearMsFor: jest.fn(async () => { mockTrace.push('default'); return null; }),
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => {
    // Ключ достаётся из Keystore — то есть с ожиданием. Держать на нём уже
    // взятую блокировку записи нельзя (v4.32.224), и порядок в mockTrace это
    // проверяет.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    mockTrace.push('dek');
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

import { saveChatMessageWithTouch, type ChatMessageRow, type ConvTouch } from '../local';

const PEER = 'P'.repeat(43);
const PID = 1;

/** Входящее сообщение собеседника. */
function message(id = 'm-1'): ChatMessageRow {
  return {
    id,
    contactPubB64: PEER,
    cid: 'cid-' + id,
    text: 'встречаемся в семь',
    direction: 'in',
    status: 'delivered',
    mediaCids: null,
    createdAt: 1_700_000_000_000,
    ownerProfileId: PID,
    replyToId: null,
    replyToPreview: null,
  };
}

/** След входящего: превью и единица непрочитанного. */
function touch(): ConvTouch {
  return {
    contactPubB64: PEER,
    ownerProfileId: PID,
    preview: 'встречаемся в семь',
    direction: 'in',
    incrementUnread: true,
  };
}

beforeEach(() => {
  mockRows = new Map();
  mockConv = { unread_count: 3, last_message_preview: 'позавчерашнее', last_message_direction: 'out' };
  mockFailOn = 'none';
  mockOpen = false;
  mockStaged = [];
  mockNestedBegins = 0;
  mockTrace = [];
});

describe('след не лёг — и сообщения тоже нет', () => {
  it('отказ на следе откатывает строку сообщения', async () => {
    mockFailOn = 'touch';
    expect(await saveChatMessageWithTouch(message(), touch())).toBe('failed');
    // Главное: строки нет. Значит перезапрос кадра пройдёт целиком.
    expect(mockRows.has('m-1')).toBe(false);
    expect(mockTrace).toContain('rollback');
    expect(mockOpen).toBe(false);
  });

  it('счётчик и превью при этом остались вчерашними', async () => {
    mockFailOn = 'touch';
    await saveChatMessageWithTouch(message(), touch());
    expect(mockConv).toEqual({
      unread_count: 3, last_message_preview: 'позавчерашнее', last_message_direction: 'out',
    });
  });

  it('повтор после освободившейся базы кладёт и строку, и след', async () => {
    mockFailOn = 'touch';
    expect(await saveChatMessageWithTouch(message(), touch())).toBe('failed');

    mockFailOn = 'none';
    expect(await saveChatMessageWithTouch(message(), touch())).toBe('inserted');
    expect(mockRows.has('m-1')).toBe(true);
    expect(mockConv).toEqual({
      unread_count: 4, last_message_preview: 'встречаемся в семь', last_message_direction: 'in',
    });
  });

  it('отказ самой записи тоже не оставляет следа', async () => {
    mockFailOn = 'insert';
    expect(await saveChatMessageWithTouch(message(), touch())).toBe('failed');
    expect(mockConv?.unread_count).toBe(3);
    expect(mockTrace).toContain('rollback');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Неделимость не должна была ничего сломать в двух остальных исходах: удачная
 * запись по-прежнему поднимает счётчик, а повтор конверта по-прежнему не
 * трогает ни счётчик, ни превью (v4.32.477).
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные исходы прежние', () => {
  it('удачная запись поднимает счётчик и переписывает превью', async () => {
    expect(await saveChatMessageWithTouch(message(), touch())).toBe('inserted');
    expect(mockRows.has('m-1')).toBe(true);
    expect(mockConv).toEqual({
      unread_count: 4, last_message_preview: 'встречаемся в семь', last_message_direction: 'in',
    });
  });

  it('повтор конверта не поднимает счётчик со вчерашним текстом', async () => {
    await saveChatMessageWithTouch(message(), touch());
    const after = { ...mockConv! };

    expect(await saveChatMessageWithTouch(message(), touch())).toBe('duplicate');
    expect(mockConv).toEqual(after);
  });

  it('первое сообщение от нового собеседника заводит строку списка тут же', async () => {
    mockConv = null;
    expect(await saveChatMessageWithTouch(message(), touch())).toBe('inserted');
    expect(mockConv).toEqual({
      unread_count: 1, last_message_preview: 'встречаемся в семь', last_message_direction: 'in',
    });
    expect(mockTrace).toContain('commit');
  });

  it('транзакция закрывается и не вкладывается сама в себя', async () => {
    await Promise.all([
      saveChatMessageWithTouch(message('m-a'), touch()),
      saveChatMessageWithTouch(message('m-b'), touch()),
    ]);
    expect(mockOpen).toBe(false);
    expect(mockNestedBegins).toBe(0);
    // Оба инкремента на месте: BEGIN IMMEDIATE выстраивает писателей в очередь,
    // и второй SELECT видит уже обновлённый счётчик (v4.32.134).
    expect(mockConv?.unread_count).toBe(5);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ключ данных и настройка достаются до BEGIN, а не под блокировкой', async () => {
    await saveChatMessageWithTouch(message(), touch());
    const begin = mockTrace.indexOf('begin');
    expect(begin).toBeGreaterThan(-1);
    for (const step of ['dek', 'default']) {
      expect(mockTrace.indexOf(step)).toBeGreaterThan(-1);
      expect(mockTrace.indexOf(step)).toBeLessThan(begin);
    }
  });

  it('след пишется внутри той же транзакции, что и строка', async () => {
    await saveChatMessageWithTouch(message(), touch());
    const begin = mockTrace.indexOf('begin');
    const commit = mockTrace.indexOf('commit');
    for (const step of ['insert', 'select', 'touch']) {
      expect(mockTrace.indexOf(step)).toBeGreaterThan(begin);
      expect(mockTrace.indexOf(step)).toBeLessThan(commit);
    }
  });
});
