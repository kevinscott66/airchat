/**
 * v4.32.1004: плашка запланированных исчезала, когда их не смогли прочитать.
 *
 * Дефект. `listAllScheduledMessages` и `listGroupScheduledMessages` бросают —
 * и это верно. Но на обоих экранах их звали через `void ... .then(...)` без
 * `.catch` (в переписке был ещё и `try/catch`, глушивший отказ в журнал), а
 * плашка «N запланированных сообщений» нарисована по `length > 0`. Отказ
 * чтения оставлял список прежним — на первом заходе пустым, — и плашка не
 * появлялась вовсе.
 *
 * Цена. Плашка — единственный путь к списку, а список — единственный способ
 * отменить отправку. Рассылает же строки не экран: планировщик читает их сам,
 * своим `listDueScheduledMessages`, и по своему таймеру. То есть сообщение
 * уходило в срок от имени человека, который в это время смотрел на переписку
 * без единого признака того, что оно существует. Хуже прочих умолчаний про
 * пустой список именно тем, что молчание тут ничего не откладывает.
 *
 * Правка. `listAllScheduledMessagesRead` и `listGroupScheduledMessagesRead`:
 * список либо `null`. Плашка видна и в этом случае, вместо числа — «Запланированные
 * не удалось прочитать», та же строка стоит и в самом списке.
 *
 * Границы. Прочитанная пустота по-прежнему пустота: плашки нет, и это правда.
 * Прежние бросающие имена остались — по ним ходит отправка, которой пустой
 * список не годится.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Строки scheduled_messages, какими их видит запрос. */
let mockRows: Array<Record<string, unknown>> = [];
/** Чтение отказывает. */
let mockFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async (sql: string) => {
      if (/FROM scheduled_messages/i.test(sql)) {
        if (mockFails) throw new Error('disk i/o error');
        return mockRows;
      }
      return [];
    }),
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

jest.mock('../localEncryption', () => {
  const { classifyAtRestCell } = jest.requireActual('../atRestCell');
  const decode = (v: string): string | null => (v.startsWith('enc2:') ? v.slice('enc2:'.length) : v);
  return {
    AT_REST_PREFIX: 'enc2:',
    AT_REST_COLUMNS: [],
    DEK_KEY: 'dek',
    getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
    encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
    encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
    encryptAtRestIfPlain: jest.fn((v: string | null) => v),
    decryptAtRestString: jest.fn((v: string) => decode(v) ?? ''),
    decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : decode(v) ?? '')),
    tryDecryptAtRest: jest.fn((v: string) => decode(v)),
    readAtRestCell: jest.fn((v: string | null) =>
      v === null ? classifyAtRestCell(null, null) : classifyAtRestCell(v, decode(v))
    ),
    canaryOpensWith: jest.fn(async () => true),
    persistDek: jest.fn(async () => undefined),
    isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
    resetDataEncryptionKeyCache: jest.fn(),
  };
});

/** Строка расписания, как её отдаёт запрос. */
function schedRow(id: string, text: string, groupId: string | null): Record<string, unknown> {
  return {
    id, contact_pub_b64: 'peerAAAAAAAA', text: `enc2:${text}`, media_cids: null,
    send_at: 1700000000000, owner_profile_id: 1, created_at: 1699000000000,
    group_id: groupId, sender_name: null, attempts: 0,
  };
}

const src = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

/** Только код: закомментированное объяснение не должно закрывать собой пин. */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** Одно место файла — чтобы совпадение не прилетело от соседа. */
function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

beforeEach(() => {
  mockRows = [];
  mockFails = false;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: расписание читается', () => {
  it('личное расписание читается', async () => {
    const { listAllScheduledMessages } = await import('../local');
    mockRows = [schedRow('s1', 'привет', null)];
    const list = await listAllScheduledMessages(1);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('привет');
  });

  it('групповое расписание читается', async () => {
    const { listGroupScheduledMessages } = await import('../local');
    mockRows = [schedRow('s1', 'всем привет', 'grp-12345678')];
    const list = await listGroupScheduledMessages('grp-12345678', 1);
    expect(list).toHaveLength(1);
    expect(list[0].groupId).toBe('grp-12345678');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежние имена по-прежнему бросают', () => {
  it('личный список бросает, а не отдаёт пустоту', async () => {
    const { listAllScheduledMessages } = await import('../local');
    mockFails = true;
    await expect(listAllScheduledMessages(1)).rejects.toThrow();
  });

  it('групповой список бросает, а не отдаёт пустоту', async () => {
    const { listGroupScheduledMessages } = await import('../local');
    mockFails = true;
    await expect(listGroupScheduledMessages('grp-12345678', 1)).rejects.toThrow();
  });

  it('плашка по-прежнему называет число, когда оно известно', () => {
    expect(codeOnly(src('ui/screens/ChatScreen.tsx'))).toContain('scheduledLabel(scheduledMsgs.length)');
    expect(codeOnly(src('ui/screens/GroupsScreen.tsx'))).toContain('scheduledLabel(grpScheduledMsgs.length)');
  });
});

describe('третий исход у обоих чтений', () => {
  it('личный список не прочитался — null, а не пустой массив', async () => {
    const { listAllScheduledMessagesRead } = await import('../local');
    mockFails = true;
    expect(await listAllScheduledMessagesRead(1)).toBeNull();
  });

  it('групповой список не прочитался — тоже null', async () => {
    const { listGroupScheduledMessagesRead } = await import('../local');
    mockFails = true;
    expect(await listGroupScheduledMessagesRead('grp-12345678', 1)).toBeNull();
  });
});

describe('ГРАНИЦА: честная пустота осталась пустотой', () => {
  it('ничего не запланировано — пустой список, а не null', async () => {
    const { listAllScheduledMessagesRead, listGroupScheduledMessagesRead } = await import('../local');
    expect(await listAllScheduledMessagesRead(1)).toEqual([]);
    expect(await listGroupScheduledMessagesRead('grp-12345678', 1)).toEqual([]);
  });

  it('запланировано — те же строки, что у прежнего имени', async () => {
    const { listAllScheduledMessagesRead } = await import('../local');
    mockRows = [schedRow('s1', 'раз', null), schedRow('s2', 'два', null)];
    const list = await listAllScheduledMessagesRead(1);
    expect(list?.map((m) => m.text)).toEqual(['раз', 'два']);
  });
});

describe('переписка: плашку больше не прячет отказ чтения', () => {
  const screen = (): string => codeOnly(src('ui/screens/ChatScreen.tsx'));

  it('читает через трёхсостоятельное имя', () => {
    const s = screen();
    expect(s).toContain('await listAllScheduledMessagesRead(activeProfileId)');
    expect(s).not.toContain('await listAllScheduledMessages(activeProfileId)');
  });

  it('непрочитанный список не затирает показанный', () => {
    const body = slice(screen(), 'const reloadScheduled = useCallback', '}, [peerB64, activeProfileId]);');
    expect(body).toContain('setScheduledUnreadable(all === null);');
    expect(body).toContain('if (all !== null) setScheduledMsgs(');
  });

  it('плашка видна и при непрочитанном списке', () => {
    expect(screen()).toContain('scheduledUnreadable || scheduledMsgs.length > 0');
  });

  it('вместо числа стоит пометка', () => {
    expect(screen()).toContain('scheduledUnreadable ? UNREADABLE_SCHEDULED_TEXT : scheduledLabel(scheduledMsgs.length)');
  });

  it('отказ перечитывания после планирования больше не глушится в журнал', () => {
    expect(screen()).not.toContain("log.warn('schedule_dm_reload_failed'");
  });

  it('признак уходит в окно списка', () => {
    expect(screen()).toContain('unreadable={scheduledUnreadable}');
  });
});

describe('группа: то же самое', () => {
  const screen = (): string => codeOnly(src('ui/screens/GroupsScreen.tsx'));

  it('читает через трёхсостоятельное имя', () => {
    const s = screen();
    expect(s).toContain('await listGroupScheduledMessagesRead(group.id, pid)');
    expect(s).not.toContain('await listGroupScheduledMessages(group.id, pid)');
  });

  it('непрочитанный список не затирает показанный', () => {
    const body = slice(screen(), 'const reloadGrpScheduled = useCallback', '}, [group.id, pid]);');
    expect(body).toContain('setGrpScheduledUnreadable(list === null);');
    expect(body).toContain('if (list !== null) setGrpScheduledMsgs(list);');
  });

  it('плашка видна и при непрочитанном списке, и говорит об этом', () => {
    const s = screen();
    expect(s).toContain('grpScheduledUnreadable || grpScheduledMsgs.length > 0');
    expect(s).toContain('grpScheduledUnreadable ? UNREADABLE_SCHEDULED_TEXT : scheduledLabel(grpScheduledMsgs.length)');
    expect(s).toContain('unreadable={grpScheduledUnreadable}');
  });
});

describe('окно списка отличает пустоту от непрочитанного', () => {
  it('знает признак и рисует пометку', () => {
    const m = codeOnly(src('ui/components/modals/shared/ScheduledListModal.tsx'));
    expect(m).toContain('unreadable?: boolean;');
    expect(m).toContain('scheduled, unreadable, onDelete }: ScheduledListModalProps');
    expect(m).toContain('UNREADABLE_SCHEDULED_TEXT');
  });

  it('пометка стоит внутри самого списка, а не рядом с ним', () => {
    const m = codeOnly(src('ui/components/modals/shared/ScheduledListModal.tsx'));
    const body = slice(m, '<ScrollView contentContainerStyle={styles.scrollContent}>', '</ScrollView>');
    expect(body).toContain('unreadable ?');
    expect(body).toContain('UNREADABLE_SCHEDULED_TEXT');
  });
});

describe('пометка живёт рядом с остальными', () => {
  it('строка заведена в unreadableText', () => {
    expect(src('core/storage/unreadableText.ts')).toContain(
      "export const UNREADABLE_SCHEDULED_TEXT = 'Запланированные не удалось прочитать';"
    );
  });
});
