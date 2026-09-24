/**
 * Сорванная очистка истории группы больше не выдаёт себя за выполненную
 * (v4.32.833).
 *
 * Дефект. `clearGroupMessages` целиком лежала в собственном `try`, который
 * писал `clear_group_messages_failed` в журнал и возвращался как ни в чём не
 * бывало. Подпись `Promise<void>` другого способа признаться не оставляла.
 * Внутри при этом стоит `eraseAtomically` — помощник, заведённый ровно затем,
 * чтобы о сорванном стирании узнали: он откатывает транзакцию и бросает
 * дальше. Бросок упирался в эту ловушку и умирал в ней.
 *
 * Цена. Экран групп ловушку на этот случай держит с v4.32.531 и говорит «Не
 * удалось очистить историю» — попасть в неё было нельзя. Человек видел
 * «История очищена», список перечитывался, и все сообщения оставались на
 * месте. Вопрос перед очисткой обещает «это действие нельзя отменить», то есть
 * звучит как «переписки больше нет»; повторить нажатие в голову уже не придёт,
 * а именно повтор и нужен — откат оставляет базу пригодной к следующей
 * попытке. Занятая или полная база на телефоне — дело обычное.
 *
 * Правка. Ловушки больше нет, отказ идёт наружу. Из четырёх стираний в этом
 * файле молчало одно: `clearChatHistory` и `deleteGroup` своей ловушки не
 * имеют вовсе, `clearAllMessageHistory` отвечает `false`.
 *
 * Стенд — тот же, что у `eraseKvRollback.test.ts`: записи под открытым BEGIN
 * видны только после COMMIT и пропадают при ROLLBACK, а «диск полон» бросается
 * ровно на удалении kv-строки, как и было бы у настоящего SQLite.
 */
import fs from 'fs';
import path from 'path';

type Run = { changes: number; lastInsertRowId: number };

let mockOpen = false;
let mockStaged: string[] = [];
let mockCommitted: string[] = [];
/** Включает отказ на любом удалении kv-строки — точечно, чтобы миграции жили. */
let mockKvDeleteFails = false;

function mockExec(sql: string): void {
  const head = sql.trim().toUpperCase();
  if (head.startsWith('BEGIN')) {
    mockOpen = true;
    mockStaged = [];
    return;
  }
  if (head.startsWith('COMMIT')) {
    mockCommitted = mockCommitted.concat(mockStaged);
    mockStaged = [];
    mockOpen = false;
    return;
  }
  if (head.startsWith('ROLLBACK')) {
    mockStaged = [];
    mockOpen = false;
  }
}

/** Что именно стирает запрос — только следы, за которыми следит тест. */
function mockTagOf(sql: string): string | null {
  const one = sql.replace(/\s+/g, ' ').trim();
  if (one.startsWith('DELETE FROM group_messages')) return 'group_messages';
  if (one.startsWith('DELETE FROM chat_messages')) return 'messages';
  if (one.startsWith('UPDATE groups')) return 'group_row';
  if (one.startsWith('DELETE FROM kv WHERE k = ?')) return 'bin';
  return null;
}

function mockIsKvDelete(sql: string): boolean {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.startsWith('DELETE FROM kv WHERE k = ?') || one.startsWith('DELETE FROM kv WHERE k LIKE ?');
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async (sql: string) => {
      mockExec(sql);
    }),
    runAsync: jest.fn(async (sql: string): Promise<Run> => {
      if (mockKvDeleteFails && mockIsKvDelete(sql)) {
        throw new Error('SQLITE_FULL: database or disk is full');
      }
      const tag = mockTagOf(sql);
      if (tag) {
        if (mockOpen) mockStaged.push(tag);
        else mockCommitted.push(tag);
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

import { clearChatHistory, clearGroupMessages, kvDelete } from '../local';

/** База поднимается лениво; открываем её до того, как включён отказ. */
beforeAll(async () => {
  await kvDelete('warmup');
});

beforeEach(() => {
  mockOpen = false;
  mockStaged = [];
  mockCommitted = [];
  mockKvDeleteFails = false;
});

describe('очистка истории группы: не удалилось — так и сказано', () => {
  it('вызов сообщает о провале, а не молчит', async () => {
    mockKvDeleteFails = true;
    await expect(clearGroupMessages('g1', 1)).rejects.toThrow('SQLITE_FULL');
  });

  it('сообщения остаются на месте: транзакция откатилась', async () => {
    mockKvDeleteFails = true;
    await expect(clearGroupMessages('g1', 1)).rejects.toThrow();
    expect(mockCommitted).not.toContain('group_messages');
    expect(mockCommitted).toEqual([]);
    expect(mockOpen).toBe(false);
  });

  it('после отката повтор проходит целиком', async () => {
    mockKvDeleteFails = true;
    await expect(clearGroupMessages('g1', 1)).rejects.toThrow();
    mockKvDeleteFails = false;
    await clearGroupMessages('g1', 1);
    expect(mockCommitted).toContain('group_messages');
    expect(mockCommitted).toContain('bin');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: стенд доводит очистку до конца, когда база цела', () => {
  it('без отказа очистка группы доходит до COMMIT', async () => {
    await clearGroupMessages('g1', 1);
    expect(mockCommitted).toContain('group_messages');
    expect(mockCommitted).toContain('bin');
    expect(mockOpen).toBe(false);
  });

  it('следы самой группы стираются той же транзакцией', async () => {
    await clearGroupMessages('g1', 1);
    expect(mockCommitted).toContain('group_row');
  });

  it('отказ включается только на удалении kv-строки', async () => {
    mockKvDeleteFails = true;
    // Прочие запросы проходят: сюда стенд доходит и пишет тег.
    await expect(clearGroupMessages('g1', 1)).rejects.toThrow('SQLITE_FULL');
    expect(mockStaged).toEqual([]);
  });

  it('соседняя очистка переписки ведёт себя ровно так же — образец', async () => {
    mockKvDeleteFails = true;
    await expect(clearChatHistory('peer-pub-b64', 1)).rejects.toThrow('SQLITE_FULL');
    expect(mockCommitted).toEqual([]);
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

  it('экран групп держит ловушку и умеет назвать отказ вслух', () => {
    const screen = codeOnly(read('..', '..', 'ui', 'screens', 'GroupsScreen.tsx'));
    const at = screen.indexOf('await clearGroupMessages(');
    expect(at).toBeGreaterThan(0);
    const tail = screen.slice(at, at + 400);
    const fail = tail.indexOf("showError(userErrorText(e, 'Не удалось очистить историю'));");
    expect(fail).toBeGreaterThan(0);
    // Успех объявляется только после ловушки, и до него — return по отказу.
    expect(tail.indexOf('return;', fail)).toBeGreaterThan(fail);
    expect(tail.indexOf("showSuccess('История очищена');")).toBeGreaterThan(fail);
  });

  it('помощник стирания заведён именно ради броска наверх', () => {
    const local = codeOnly(read('local.ts'));
    const at = local.indexOf('async function eraseAtomically(');
    expect(at).toBeGreaterThan(0);
    const body = local.slice(at, at + 900);
    const rollback = body.indexOf('await txn.rollback();');
    expect(rollback).toBeGreaterThan(0);
    expect(body.indexOf('throw e;', rollback)).toBeGreaterThan(rollback);
  });
});

describe('форма исходников: своей ловушки у очистки группы нет', () => {
  it('прежнего глушителя не осталось', () => {
    const local = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
    expect(local).not.toContain("log.warn('clear_group_messages_failed'");
  });

  it('тело очистки идёт без try — как у соседней очистки переписки', () => {
    const local = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
    const at = local.indexOf(
      'export async function clearGroupMessages(groupId: string, ownerProfileId: number): Promise<void> {',
    );
    expect(at).toBeGreaterThan(0);
    const end = local.indexOf('\n}\n', at);
    expect(end).toBeGreaterThan(at);
    const body = local.slice(at, end);
    expect(body).not.toContain('} catch');
    expect(body).toContain('await eraseAtomically(');
    expect(body).toContain('emitChatWrites();');
  });
});
