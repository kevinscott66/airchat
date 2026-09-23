/**
 * Сообщение группы и его след в списке переписок — одной транзакцией (v4.32.775).
 *
 * Дефект. Приёмник сначала писал строку, а потом звал `touchGroupConversation`.
 * Тот гасил любой свой отказ внутри себя (`log.warn('touch_group_failed')`) и
 * отвечал `void`, так что приёмник считал кадр разобранным и двигал метку
 * «докуда прочитано» у ретранслятора. Починить это было нечем: второй раз тот
 * же конверт не придёт, а если и придёт — запись ответит `'duplicate'`, и
 * приёмник выйдет ДО следа (так задумано с v4.32.581: повтор не поднимает
 * счётчик со вчерашним текстом).
 *
 * Итог: доля секунды занятой базы навсегда съедала бейдж непрочитанного и
 * бейдж упоминания, а в списке чатов группа оставалась с позавчерашним превью
 * — при том, что само сообщение внутри неё лежало и открывалось.
 *
 * Обратный порядок не помогал: отказ записи после удавшегося следа дал бы на
 * перезапросе второй инкремент. Лечит только неделимость.
 *
 * Стенд ниже ведёт себя как настоящая база: записи внутри открытой транзакции
 * становятся видимыми только после COMMIT и пропадают при ROLLBACK.
 */
type Run = { changes: number; lastInsertRowId: number };

/** Строки group_messages по id. */
let mockRows = new Map<string, unknown[]>();
/** Счётчики и превью группы. */
let mockGroup: {
  unread_count: number; mention_count: number;
  last_message_preview: string | null; last_message_sender_name: string | null;
} | null = null;
/** Есть ли вообще строка группы: её отсутствие — не отказ. */
let mockGroupExists = true;
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
function mockWrite(apply: () => void): void {
  if (mockOpen) mockStaged.push(apply);
  else apply();
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async (sql: string) => {
      mockExec(sql);
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []): Promise<Run> => {
      if (sql.includes('INSERT OR IGNORE INTO group_messages')) {
        mockTrace.push('insert');
        if (mockFailOn === 'insert') throw new Error('database is locked');
        const id = String(params[0] ?? '');
        if (mockRows.has(id)) return { changes: 0, lastInsertRowId: 0 };
        mockWrite(() => { mockRows.set(id, params); });
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (sql.includes('UPDATE groups SET last_message_at')) {
        mockTrace.push('touch');
        if (mockFailOn === 'touch') throw new Error('database is locked');
        const preview = (params[1] ?? null) as string | null;
        const unread = Number(params[2] ?? 0);
        const senderName = (params[3] ?? null) as string | null;
        const mention = Number(params[4] ?? 0);
        mockWrite(() => {
          if (!mockGroup) return;
          mockGroup.last_message_preview = preview;
          mockGroup.unread_count = unread;
          mockGroup.last_message_sender_name = senderName;
          mockGroup.mention_count = mention;
        });
        return { changes: 1, lastInsertRowId: 0 };
      }
      return { changes: 0, lastInsertRowId: 0 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT unread_count, mention_count FROM groups')) {
        mockTrace.push('select');
        return mockGroupExists && mockGroup
          ? { unread_count: mockGroup.unread_count, mention_count: mockGroup.mention_count }
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

import { insertGroupMessageWithTouch, type GroupMessageRow, type GroupTouch } from '../local';

const GID = 'g-775';
const PID = 1;

/** Входящее сообщение участника. */
function message(id = 'm-1'): GroupMessageRow {
  return {
    id,
    groupId: GID,
    senderPubB64: 'P'.repeat(43),
    senderName: 'Пётр',
    text: 'встречаемся в семь',
    mediaCids: null,
    replyToId: null,
    replyToPreview: null,
    reactions: null,
    createdAt: 1_700_000_000_000,
    ownerProfileId: PID,
  };
}

/** След входящего: и счётчик непрочитанного, и бейдж упоминания. */
function touch(): GroupTouch {
  return {
    groupId: GID,
    ownerProfileId: PID,
    preview: 'встречаемся в семь',
    incrementUnread: true,
    senderName: 'Пётр',
    incrementMention: true,
    senderPubB64: 'P'.repeat(43),
  };
}

beforeEach(() => {
  mockRows = new Map();
  mockGroup = {
    unread_count: 3, mention_count: 1,
    last_message_preview: 'позавчерашнее', last_message_sender_name: 'Аня',
  };
  mockGroupExists = true;
  mockFailOn = 'none';
  mockOpen = false;
  mockStaged = [];
  mockNestedBegins = 0;
  mockTrace = [];
});

describe('след не лёг — и сообщения тоже нет', () => {
  it('отказ на следе откатывает строку сообщения', async () => {
    mockFailOn = 'touch';
    expect(await insertGroupMessageWithTouch(message(), touch())).toBe('failed');
    // Главное: строки нет. Значит перезапрос кадра пройдёт целиком.
    expect(mockRows.has('m-1')).toBe(false);
    expect(mockTrace).toContain('rollback');
    expect(mockOpen).toBe(false);
  });

  it('счётчики при этом не сдвинулись ни на единицу', async () => {
    mockFailOn = 'touch';
    await insertGroupMessageWithTouch(message(), touch());
    expect(mockGroup).toEqual({
      unread_count: 3, mention_count: 1,
      last_message_preview: 'позавчерашнее', last_message_sender_name: 'Аня',
    });
  });

  it('повтор после освободившейся базы кладёт и строку, и след', async () => {
    mockFailOn = 'touch';
    expect(await insertGroupMessageWithTouch(message(), touch())).toBe('failed');

    mockFailOn = 'none';
    expect(await insertGroupMessageWithTouch(message(), touch())).toBe('inserted');
    expect(mockRows.has('m-1')).toBe(true);
    expect(mockGroup).toEqual({
      unread_count: 4, mention_count: 2,
      last_message_preview: 'встречаемся в семь', last_message_sender_name: 'Пётр',
    });
  });

  it('отказ самой записи тоже не оставляет следа', async () => {
    mockFailOn = 'insert';
    expect(await insertGroupMessageWithTouch(message(), touch())).toBe('failed');
    expect(mockGroup?.unread_count).toBe(3);
    expect(mockTrace).toContain('rollback');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Неделимость не должна была ничего сломать в двух остальных исходах: удачная
 * запись по-прежнему поднимает счётчик, а повтор конверта по-прежнему не
 * трогает ни счётчик, ни превью (v4.32.581).
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные исходы прежние', () => {
  it('удачная запись поднимает счётчик и переписывает превью', async () => {
    expect(await insertGroupMessageWithTouch(message(), touch())).toBe('inserted');
    expect(mockRows.has('m-1')).toBe(true);
    expect(mockGroup).toEqual({
      unread_count: 4, mention_count: 2,
      last_message_preview: 'встречаемся в семь', last_message_sender_name: 'Пётр',
    });
  });

  it('повтор конверта не поднимает счётчик со вчерашним текстом', async () => {
    await insertGroupMessageWithTouch(message(), touch());
    const after = { ...mockGroup! };

    expect(await insertGroupMessageWithTouch(message(), touch())).toBe('duplicate');
    expect(mockGroup).toEqual(after);
  });

  it('группы у себя уже нет — это не отказ, а некуда класть след', async () => {
    mockGroupExists = false;
    expect(await insertGroupMessageWithTouch(message(), touch())).toBe('inserted');
    expect(mockRows.has('m-1')).toBe(true);
    expect(mockTrace).toContain('commit');
  });

  it('транзакция закрывается и не вкладывается сама в себя', async () => {
    await Promise.all([
      insertGroupMessageWithTouch(message('m-a'), touch()),
      insertGroupMessageWithTouch(message('m-b'), touch()),
    ]);
    expect(mockOpen).toBe(false);
    expect(mockNestedBegins).toBe(0);
    // Оба инкремента на месте: BEGIN IMMEDIATE выстраивает писателей в очередь,
    // и второй SELECT видит уже обновлённый счётчик (v4.32.141).
    expect(mockGroup?.unread_count).toBe(5);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ключ данных достаётся до BEGIN, а не под взятой блокировкой', async () => {
    await insertGroupMessageWithTouch(message(), touch());
    expect(mockTrace.indexOf('dek')).toBeGreaterThan(-1);
    expect(mockTrace.indexOf('dek')).toBeLessThan(mockTrace.indexOf('begin'));
  });

  it('след пишется внутри той же транзакции, что и строка', async () => {
    await insertGroupMessageWithTouch(message(), touch());
    const begin = mockTrace.indexOf('begin');
    const commit = mockTrace.indexOf('commit');
    for (const step of ['insert', 'select', 'touch']) {
      expect(mockTrace.indexOf(step)).toBeGreaterThan(begin);
      expect(mockTrace.indexOf(step)).toBeLessThan(commit);
    }
  });
});
