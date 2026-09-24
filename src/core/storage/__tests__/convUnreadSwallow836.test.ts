/**
 * «Отметить прочитанным» в личных чатах перестало молчать об отказе (v4.32.836).
 *
 * Дефект. Ровно та же тройка, что в группах починили в v4.32.833, только для
 * диалогов: `markConversationRead`, `markAllConversationsRead`,
 * `markConversationUnread`. Каждая целиком лежит в своём `try`, в ловушке с
 * v4.32.526 стоит `log.warn` — и на этом всё: подпись `Promise<void>` другого
 * способа признаться не оставляет, наружу отказ уходит успехом.
 *
 * Цена. Зовут их из ChatListScreen и ChatScreen, и там не было ни одного
 * `.catch`: все пять мест записаны как `void mark…(…).then(loadData)`.
 * `loadData` при отказе не наступает, список остаётся с прежним счётчиком, и
 * человек видит ровно то же, что до нажатия, — пункт меню выглядит кнопкой,
 * которая иногда просто не срабатывает. Отличить отказ от нормального исхода
 * нельзя в принципе: «ничего не изменилось» — это и успешная пометка строки,
 * которая и так была прочитана.
 *
 * Хуже всего «отметить непрочитанным» из самой переписки: за записью там
 * стоит `onBack()`, то есть уход с экрана. Отказ проглатывался, `onBack`
 * отрабатывал, и человек уходил в список в уверенности, что пометил диалог, —
 * а жирной строки там не было. В группах это же место починили в v4.32.833;
 * диалоги остались как были.
 *
 * Правка. Журнальная строка остаётся (по ней ищут причину), следом `throw e`.
 * Все пять вызовов обёрнуты `runGuardedOp` с готовым текстом, `onBack` уехал
 * внутрь — за запись. Единственное осознанное молчание — снятие непрочитанных
 * на открытии чата: этой работы никто не просил, окно с ошибкой поверх только
 * что открытой переписки мешало бы больше самого промаха.
 *
 * Стенд — тот же, что у `groupUnreadSwallow833.test.ts`.
 */
import fs from 'fs';
import path from 'path';

type Run = { changes: number; lastInsertRowId: number };

/** Отказ на UPDATE счётчика диалогов — точечно, чтобы миграции жили. */
let mockConvUpdateFails = false;
/** Сколько строк «изменил» UPDATE: нужен для проверки сигнала подписчикам. */
let mockChanges = 1;
let mockUpdates: string[] = [];

function mockIsConvUpdate(sql: string): boolean {
  return sql.replace(/\s+/g, ' ').trim().startsWith('UPDATE conversations SET unread_count');
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string): Promise<Run> => {
      if (mockIsConvUpdate(sql)) {
        if (mockConvUpdateFails) throw new Error('SQLITE_BUSY: database is locked');
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

import {
  kvDelete,
  markAllConversationsRead,
  markConversationRead,
  markConversationUnread,
} from '../local';
import { runGuardedOp } from '../../../ui/components/runGuardedOp';

const PEER = 'peer-pub-b64';

/** База поднимается лениво; открываем её до того, как включён отказ. */
beforeAll(async () => {
  await kvDelete('warmup');
});

beforeEach(() => {
  mockConvUpdateFails = false;
  mockChanges = 1;
  mockUpdates = [];
  mockShowError.mockClear();
});

describe('отказ записи доходит до вызывающего', () => {
  it('снятие непрочитанных с диалога сообщает о провале', async () => {
    mockConvUpdateFails = true;
    await expect(markConversationRead(PEER, 1)).rejects.toThrow('SQLITE_BUSY');
  });

  it('«отметить всё прочитанным» — тоже', async () => {
    mockConvUpdateFails = true;
    await expect(markAllConversationsRead(1)).rejects.toThrow('SQLITE_BUSY');
  });

  it('пометка «непрочитано» — тоже', async () => {
    mockConvUpdateFails = true;
    await expect(markConversationUnread(PEER, 1)).rejects.toThrow('SQLITE_BUSY');
  });
});

describe('цена дефекта: уход с экрана по несостоявшейся пометке', () => {
  /** Точно тот же состав, что у `onMarkUnread` в ChatScreen. */
  const markUnreadAndLeave = (onBack: () => void): void =>
    runGuardedOp(async () => {
      await markConversationUnread(PEER, 1);
      onBack();
    }, 'Не удалось отметить непрочитанным');

  it('запись не легла — с экрана не уводит и говорит об этом', async () => {
    mockConvUpdateFails = true;
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

describe('цена дефекта: перерисовка списка по несостоявшейся пометке', () => {
  /** Точно тот же состав, что у пункта меню в ChatListScreen. */
  const markReadAndReload = (loadData: () => void): void =>
    runGuardedOp(async () => {
      await markConversationRead(PEER, 1);
      loadData();
    }, 'Не удалось отметить прочитанным');

  it('запись не легла — список не перечитывают впустую, человеку говорят', async () => {
    mockConvUpdateFails = true;
    const loadData = jest.fn();
    markReadAndReload(loadData);
    await new Promise((r) => setImmediate(r));
    expect(loadData).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith('Не удалось отметить прочитанным');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: запись легла — перечитывают и молчат', async () => {
    const loadData = jest.fn();
    markReadAndReload(loadData);
    await new Promise((r) => setImmediate(r));
    expect(loadData).toHaveBeenCalledTimes(1);
    expect(mockShowError).not.toHaveBeenCalled();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: на целой базе всё как было', () => {
  it('все три записи проходят и доходят до запроса', async () => {
    await markConversationRead(PEER, 1);
    await markAllConversationsRead(1);
    await markConversationUnread(PEER, 1);
    expect(mockUpdates).toHaveLength(3);
  });

  it('отказ включается только на записи счётчиков', async () => {
    mockConvUpdateFails = true;
    // Соседняя запись по той же базе идёт как ни в чём не бывало.
    await expect(kvDelete('anything')).resolves.toBeUndefined();
    await expect(markConversationRead(PEER, 1)).rejects.toThrow();
  });

  it('условие из v4.32.526 на месте: менять нечего — запрос это и говорит', async () => {
    mockChanges = 0;
    await markConversationRead(PEER, 1);
    expect(mockUpdates[0]).toContain('unread_count != 0');
    mockUpdates = [];
    await markConversationUnread(PEER, 1);
    expect(mockUpdates[0]).toContain('unread_count = 0');
  });
});

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
const screens = (name: string): string => read('..', '..', 'ui', 'screens', name);

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('групповая тройка бросает — образец, мимо которого прошли диалоги', () => {
    const local = codeOnly(read('local.ts'));
    for (const name of ['markGroupRead', 'markAllGroupsRead', 'markGroupUnread']) {
      const at = local.indexOf(`export async function ${name}(`);
      expect(at).toBeGreaterThan(0);
      expect(local.slice(at, local.indexOf('\n}\n', at))).toContain('throw e;');
    }
  });

  it('готовый способ показать отказ был всё это время', () => {
    const guard = codeOnly(read('..', '..', 'ui', 'components', 'runGuardedOp.ts'));
    expect(guard).toContain('export function runGuardedOp(');
    expect(guard).toContain('showError(userErrorText(e, fallback));');
  });

  it('пометка «непрочитано» из переписки по-прежнему обещает уход с экрана', () => {
    const screen = codeOnly(screens('ChatScreen.tsx'));
    const at = screen.indexOf('onMarkUnread={');
    expect(at).toBeGreaterThan(0);
    const body = screen.slice(at, at + 500);
    expect(body).toContain('markConversationUnread(peerB64, activeProfileId)');
    expect(body).toContain('onBack');
  });

  it('снятие непрочитанных на открытии чата — фоновое, его никто не просил', () => {
    const screen = codeOnly(screens('ChatScreen.tsx'));
    const at = screen.indexOf("if (tabRef.current === 'chat') {");
    expect(at).toBeGreaterThan(0);
    expect(screen.slice(at, at + 400)).toContain('markConversationRead(peerB64, activeProfileId)');
  });
});

describe('форма исходников', () => {
  it('журнальная строка осталась, но отказ идёт дальше', () => {
    const src = read('local.ts');
    for (const name of ['markConversationRead', 'markAllConversationsRead', 'markConversationUnread']) {
      const at = src.indexOf(`export async function ${name}(`);
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf('\n}\n', at));
      expect(body).toContain('log.warn(');
      expect(body).toContain('throw e;');
    }
  });

  it('список закрыт со всех трёх сторон, и тексты — человеческие', () => {
    const screen = codeOnly(screens('ChatListScreen.tsx'));
    expect(screen).toContain("import { runGuardedOp } from '../components/runGuardedOp';");
    for (const text of [
      "'Не удалось отметить прочитанным'",
      "'Не удалось отметить непрочитанным'",
      "'Не удалось отметить всё прочитанным'",
    ]) {
      expect(screen).toContain(text);
    }
    // Голых `void mark…().then(loadData)` не осталось ни одного.
    expect(screen).not.toContain('void markConversationRead(');
    expect(screen).not.toContain('void markConversationUnread(');
    expect(screen).not.toContain('void markAllConversationsRead(');
  });

  it('уход с экрана стоит именно за записью, а не рядом с ней', () => {
    const screen = codeOnly(screens('ChatScreen.tsx'));
    const at = screen.indexOf('onMarkUnread={');
    expect(at).toBeGreaterThan(0);
    const body = screen.slice(at, at + 500);
    expect(body).toContain('runGuardedOp(async () => {');
    const write = body.indexOf('await m.markConversationUnread(peerB64, activeProfileId);');
    const back = body.indexOf('onBack();');
    expect(write).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(write);
  });

  it('единственное осознанное глушение названо вслух — открытие чата', () => {
    const screen = screens('ChatScreen.tsx');
    const at = screen.indexOf('void markConversationRead(peerB64, activeProfileId)');
    expect(at).toBeGreaterThan(0);
    const tail = screen.slice(at, at + 300);
    expect(tail).toContain(".catch(");
    expect(tail).toContain("log.warn('chat_open_mark_read_failed'");
  });
});
