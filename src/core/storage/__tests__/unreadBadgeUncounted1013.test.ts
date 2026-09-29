/**
 * Отказ базы означал «непрочитанного нет» (v4.32.1013).
 *
 * Дефект. `getTotalUnreadCount` и `getTotalGroupUnreadCount` отвечали нулём и
 * на пустоту, и на отказ базы. Для кружка это одно и то же: ноль — значит
 * кружка нет. То есть сбой чтения выглядел как «всё прочитано».
 *
 * Цена. Первый счёт идёт на маунте — в ту самую занятую секунду, когда база
 * и отказывает (восстановление сессии, разбор очереди доставки). Следующий
 * счёт бывает только при записи в чаты, поэтому кому в этот час не пишут, тот
 * до перезапуска и не узнал бы, что его ждут. Жирные строки в списке чатов
 * остаются, но в нижний ряд человек смотрит чаще, чем открывает список.
 *
 * Правка. Оба счётчика отвечают `null` — «не сосчитали», — и шапка на `null`
 * оставляет прежнее число: оно устарело на одно обращение, но не врёт про
 * пустоту. Обнуление уехало туда, где оно и правда нужно, — в смену профиля:
 * прежде чужой кружок стирался случайно, первым же отказом.
 *
 * Границы. Настоящий ноль (всё прочитано, всё заглушено, профиль пуст) —
 * по-прежнему ноль, и кружок с него снимается.
 */
type Row = { n: number | null } | null;

/** Отказ именно на счётчиках: миграции и всё прочее должны жить. */
let mockCountFails = false;
let mockConvRow: Row = { n: 0 };
let mockGroupRow: Row = { n: 0 };

function mockIsCount(sql: string): 'conv' | 'group' | null {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (!flat.includes('SUM(unread_count) as n')) return null;
  if (flat.includes('FROM conversations')) return 'conv';
  if (flat.includes('FROM groups')) return 'group';
  return null;
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string): Promise<Row> => {
      const which = mockIsCount(sql);
      if (which === null) return null;
      if (mockCountFails) throw new Error('SQLITE_BUSY: database is locked');
      return which === 'conv' ? mockConvRow : mockGroupRow;
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

const mockLogWarn = jest.fn();
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: (...a: unknown[]) => mockLogWarn(...a) },
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

import fs from 'fs';
import path from 'path';

import { badgeText } from '../../../ui/utils/badgeCount';
import { getTotalGroupUnreadCount, getTotalUnreadCount } from '../local';

const PID = 1;
const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

beforeEach(() => {
  mockCountFails = false;
  mockConvRow = { n: 0 };
  mockGroupRow = { n: 0 };
  mockLogWarn.mockClear();
});

describe('«не сосчитали» — это не ноль', () => {
  it('отказ базы в диалогах отвечает null, а не нулём', async () => {
    mockCountFails = true;

    expect(await getTotalUnreadCount(PID)).toBeNull();
  });

  it('отказ базы в группах отвечает null, а не нулём', async () => {
    mockCountFails = true;

    expect(await getTotalGroupUnreadCount(PID)).toBeNull();
  });

  it('отказ виден в логе — иначе кружок пропадал бы молча', async () => {
    // Держалось и до правки: строку писали, просто наружу отдавали ноль.
    // Здесь она закреплена, чтобы `null` не заменил её молчанием.
    mockCountFails = true;
    await getTotalUnreadCount(PID);
    await getTotalGroupUnreadCount(PID);

    expect(mockLogWarn.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining(['total_unread_failed', 'total_group_unread_failed']),
    );
  });

  it('шапка на null оставляет прежнее число, а не стирает кружок', () => {
    const body = codeOnly(read('App.tsx'));
    expect(body).toContain('if (chat !== null) setChatUnread(chat);');
    expect(body).toContain('if (groups !== null) setGroupUnread(groups);');
  });

  it('смена профиля обнуляет кружок сама — чужое число не висит', () => {
    // Раз отказ больше не затирает счётчик, обнулить его при переключении
    // обязано это место: иначе в шапке остался бы кружок прежней личности.
    const body = codeOnly(read('App.tsx'));
    const at = body.indexOf('const pidAtCall = profileManager.getActiveProfile()?.id ?? 1;');
    expect(at).toBeGreaterThan(-1);
    const before = body.slice(0, at);
    expect(before).toContain('setChatUnread(0);');
    expect(before).toContain('setGroupUnread(0);');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: счёт идёт как шёл', () => {
  it('настоящий ноль остаётся нулём — кружка нет', async () => {
    expect(await getTotalUnreadCount(PID)).toBe(0);
    expect(await getTotalGroupUnreadCount(PID)).toBe(0);
    expect(badgeText(0)).toBe('');
  });

  it('пустая таблица (SUM по нулю строк) — тоже ноль, а не отказ', async () => {
    mockConvRow = { n: null };
    mockGroupRow = null;

    expect(await getTotalUnreadCount(PID)).toBe(0);
    expect(await getTotalGroupUnreadCount(PID)).toBe(0);
  });

  it('число доходит до кружка как есть', async () => {
    mockConvRow = { n: 7 };
    mockGroupRow = { n: 128 };

    expect(await getTotalUnreadCount(PID)).toBe(7);
    expect(await getTotalGroupUnreadCount(PID)).toBe(128);
    expect(badgeText(7)).toBe('7');
    expect(badgeText(128)).toBe('99+');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ноль в кружке по-прежнему значит «кружка нет»', () => {
    // На этом и держится цена: отличить «нечего показать» от «не сосчитали»
    // кружок не умеет и уметь не должен.
    expect(badgeText(0)).toBe('');
  });

  it('второй счёт бывает только при записи в чаты', () => {
    // Поэтому один неудачный счёт и жил до перезапуска: своего повтора у
    // шапки нет, она ждёт чужой записи.
    const body = codeOnly(read('App.tsx'));
    expect(body).toContain('const unsub = subscribeChatWrites(refresh);');
  });

  it('счётчики по-прежнему единственный источник числа в кружке', () => {
    const body = codeOnly(read('App.tsx'));
    expect(body).toContain('getTotalUnreadCount(pidAtCall),');
    expect(body).toContain('getTotalGroupUnreadCount(pidAtCall),');
  });
});
