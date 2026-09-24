/**
 * «Отметить прочитанным» в группах перестало молчать об отказе (v4.32.833).
 *
 * Дефект. Три записи — `markGroupRead`, `markAllGroupsRead`,
 * `markGroupUnread` — целиком лежали в собственном `try`. С v4.32.526 он писал
 * строку в журнал (до того был пустой `catch { }`), но наружу по-прежнему
 * возвращался как ни в чём не бывало: подпись `Promise<void>` другого способа
 * признаться не оставляла.
 *
 * Цена. Зовут их из `runRowOp` и `runGuardedOp` — оба обёрнуты в `try` с
 * готовым текстом («Не удалось отметить прочитанным», «...непрочитанным», «Не
 * удалось отметить всё прочитанным»), и текст этот был недостижим. Человек
 * жал пункт меню, список перечитывался, счётчик непрочитанного оставался на
 * месте — как будто нажатие не засчиталось. Хуже всего у «отметить
 * непрочитанным» из переписки: там за записью стоит `onBack()`, то есть уход с
 * экрана. Отказ проглатывался, `onBack` отрабатывал, и человек уходил из
 * группы в полной уверенности, что пометил её непрочитанной.
 *
 * Соседи по тому же `runRowOp` — `setGroupPinned`, `setGroupMuted`,
 * `setGroupArchived` — бросают. Эта тройка была единственным исключением.
 *
 * Правка. Журнальная строка остаётся (по ней ищут причину), но следом идёт
 * `throw e` — ровно та форма, что уже стоит в этом файле у шифрующих миграций.
 * Единственное место, где отказ гасится осознанно, — чтение переписки в
 * GroupsScreen: там жаловаться не за что (переписка открыта и показана), но и
 * отметки о прочтении участникам слать тогда не за что тоже.
 *
 * Стенд — тот же, что у `clearGroupRollback833.test.ts`: отказ включается
 * точечно, на нужном запросе.
 */
import fs from 'fs';
import path from 'path';

type Run = { changes: number; lastInsertRowId: number };

/** Отказ на любом UPDATE по таблице groups — точечно, чтобы миграции жили. */
let mockGroupUpdateFails = false;
/** Сколько строк «изменил» UPDATE: нужен для проверки сигнала подписчикам. */
let mockChanges = 1;
let mockUpdates: string[] = [];

function mockIsGroupUpdate(sql: string): boolean {
  return sql.replace(/\s+/g, ' ').trim().startsWith('UPDATE groups SET unread_count');
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string): Promise<Run> => {
      if (mockIsGroupUpdate(sql)) {
        if (mockGroupUpdateFails) throw new Error('SQLITE_BUSY: database is locked');
        mockUpdates.push(sql.replace(/\s+/g, ' ').trim());
        return { changes: mockChanges, lastInsertRowId: 1 };
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

const mockShowError = jest.fn();
jest.mock('../../../ui/components/userFeedback', () => ({
  showError: (m: string) => mockShowError(m),
  showSuccess: jest.fn(),
}));

import { kvDelete, markAllGroupsRead, markGroupRead, markGroupUnread } from '../local';
import { runGuardedOp } from '../../../ui/components/runGuardedOp';

/** База поднимается лениво; открываем её до того, как включён отказ. */
beforeAll(async () => {
  await kvDelete('warmup');
});

beforeEach(() => {
  mockGroupUpdateFails = false;
  mockChanges = 1;
  mockUpdates = [];
  mockShowError.mockClear();
});

describe('отказ записи доходит до вызывающего', () => {
  it('снятие непрочитанных с группы сообщает о провале', async () => {
    mockGroupUpdateFails = true;
    await expect(markGroupRead('g1', 1)).rejects.toThrow('SQLITE_BUSY');
  });

  it('«отметить всё прочитанным» — тоже', async () => {
    mockGroupUpdateFails = true;
    await expect(markAllGroupsRead(1)).rejects.toThrow('SQLITE_BUSY');
  });

  it('пометка «непрочитано» — тоже', async () => {
    mockGroupUpdateFails = true;
    await expect(markGroupUnread('g1', 1)).rejects.toThrow('SQLITE_BUSY');
  });
});

describe('цена дефекта: уход с экрана по несостоявшейся пометке', () => {
  /** Точно тот же состав, что у `markUnreadAndLeave` в GroupsScreen. */
  const markUnreadAndLeave = (onBack: () => void): void =>
    runGuardedOp(async () => {
      await markGroupUnread('g1', 1);
      onBack();
    }, 'Не удалось отметить непрочитанным');

  it('запись не легла — с экрана не уводит и говорит об этом', async () => {
    mockGroupUpdateFails = true;
    const onBack = jest.fn();
    markUnreadAndLeave(onBack);
    await new Promise((r) => setImmediate(r));
    expect(onBack).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith('Не удалось отметить непрочитанным');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: запись легла — уводит молча, как и обещано', async () => {
    const onBack = jest.fn();
    markUnreadAndLeave(onBack);
    await new Promise((r) => setImmediate(r));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(mockShowError).not.toHaveBeenCalled();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: на целой базе всё как было', () => {
  it('все три записи проходят и доходят до запроса', async () => {
    await markGroupRead('g1', 1);
    await markAllGroupsRead(1);
    await markGroupUnread('g1', 1);
    expect(mockUpdates).toHaveLength(3);
  });

  it('отказ включается только на записи счётчиков', async () => {
    mockGroupUpdateFails = true;
    // Соседняя запись по той же базе идёт как ни в чём не бывало.
    await expect(kvDelete('anything')).resolves.toBeUndefined();
    await expect(markGroupRead('g1', 1)).rejects.toThrow();
  });

  it('условие из v4.32.526 на месте: менять нечего — запрос это и говорит', async () => {
    mockChanges = 0;
    await markGroupRead('g1', 1);
    expect(mockUpdates[0]).toContain('(unread_count != 0 OR mention_count != 0)');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const read = (...p: string[]): string => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  /** Только код: свой же разбор не должен себя подтверждать. */
  const codeOnly = (src: string): string =>
    src
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  it('экран групп держит ловушку и готовый текст — теперь достижимые', () => {
    const screen = codeOnly(read('..', '..', 'ui', 'screens', 'GroupsScreen.tsx'));
    for (const text of [
      "markGroupRead(g.id, pid), 'Не удалось отметить прочитанным'",
      "markGroupUnread(g.id, pid), 'Не удалось отметить непрочитанным'",
      "markAllGroupsRead(pid), 'Не удалось отметить всё прочитанным'",
    ]) {
      expect(screen).toContain(text);
    }
    const op = screen.indexOf('const runRowOp = useCallback(');
    expect(op).toBeGreaterThan(0);
    const body = screen.slice(op, op + 700);
    expect(body).toContain('showError(userErrorText(e, fallback));');
  });

  it('уход с экрана стоит именно за записью, а не рядом с ней', () => {
    const screen = codeOnly(read('..', '..', 'ui', 'screens', 'GroupsScreen.tsx'));
    const at = screen.indexOf('const markUnreadAndLeave = (): void => runGuardedOp(async () => {');
    expect(at).toBeGreaterThan(0);
    const body = screen.slice(at, at + 260);
    const write = body.indexOf('await markGroupUnread(group.id, pid);');
    const back = body.indexOf('onBack();');
    expect(write).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(write);
  });

  it('соседи по тому же runRowOp бросают — образец', () => {
    const local = codeOnly(read('local.ts'));
    for (const name of ['setGroupPinned', 'setGroupMuted', 'setGroupArchived']) {
      const at = local.indexOf(`export async function ${name}(`);
      expect(at).toBeGreaterThan(0);
      expect(local.slice(at, local.indexOf('\n}\n', at))).not.toContain('} catch');
    }
  });
});

describe('форма исходников', () => {
  const local = (): string => fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

  it('журнальная строка осталась, но отказ идёт дальше', () => {
    const src = local();
    for (const name of ['markGroupRead', 'markAllGroupsRead', 'markGroupUnread']) {
      const at = src.indexOf(`export async function ${name}(`);
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf('\n}\n', at));
      expect(body).toContain('log.warn(');
      expect(body).toContain('throw e;');
    }
  });

  it('единственное осознанное глушение названо вслух — чтение переписки', () => {
    const screen = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
      'utf8',
    );
    const at = screen.indexOf('await markGroupRead(group.id, pid);');
    expect(at).toBeGreaterThan(0);
    const tail = screen.slice(at, at + 300);
    expect(tail).toContain("log.warn('ui_group_mark_read_failed'");
    // Квитанции участникам оправданы тем же, чем и отметка: мы правда прочитали.
    const back = tail.indexOf('return;');
    expect(back).toBeGreaterThan(0);
    expect(screen.indexOf('void sendGroupReadReceipt(')).toBeGreaterThan(at);
  });
});
