/**
 * Отказ подсчёта очереди выглядел как «всё отправлено» (v4.32.1042).
 *
 * ДЕФЕКТ. `outboxCount` на любой сбой SQLite возвращал `0` — ровно то же
 * число, что и пустая очередь.
 *
 * ЦЕНА. Тройная, и вся в одном месте — в полоске «В очереди на отправку».
 * Первое: полоска пропадала. Это единственный признак того, что письмо ещё
 * лежит неотправленным, и из её отсутствия человек делает ровно один вывод —
 * закрывает приложение, считая сказанное доставленным. Второе: опрос
 * останавливался — интервал заводится только на непустой очереди. Третье:
 * `runSyncIfOnline` отсюда звался под `n > 0`, то есть переставал зваться
 * тоже. Одна занятая база — и очередь не разбирается и не показывается до
 * следующей записи в чат, смены сети или возврата в приложение.
 *
 * ПРАВКА. `outboxCountTry`: `null` — не сосчитали, `{ n }` — сосчитали.
 * Прежнее прочитанное число остаётся на месте; если его не было вовсе,
 * полоска говорит, что выяснить не удалось, вместо того чтобы молчать.
 * Опрос живёт, отправку подталкиваем в обоих исходах.
 *
 * ГРАНИЦЫ. Пустая очередь — прочитанный ответ: полоски нет, опрос стоит, и
 * шестисекундного опроса сети на ровном месте не появляется (v4.32.522).
 * Короткая форма `outboxCount` осталась: тем, кто просто хочет число,
 * различать исходы незачем.
 */
type Run = { sql: string; params: unknown[] };
const mockQueries: Run[] = [];
let mockQueueSize = 0;
/** База не отвечает — не то же самое, что «в очереди пусто». */
let mockCountFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      mockQueries.push({ sql, params });
      if (sql.includes('FROM outbox')) {
        if (mockCountFails) throw new Error('database is locked');
        return { n: mockQueueSize };
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
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
  encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
  decryptAtRestString: jest.fn((v: string) => v.replace('enc2:', '')),
  decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : v.replace('enc2:', ''))),
  isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { outboxCount, outboxCountTry } from '../local';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const BANNER = codeOnly(
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'components', 'OfflineStatus.tsx'),
    'utf8'
  )
);

/** Тело ветки отказа — от её начала до собственного `return`. */
function refusalBranch(): string {
  const at = BANNER.indexOf('if (read === null) {');
  expect(at).toBeGreaterThan(0);
  const end = BANNER.indexOf('return;', at);
  expect(end).toBeGreaterThan(at);
  return BANNER.slice(at, end);
}

beforeEach(() => {
  mockQueries.length = 0;
  mockQueueSize = 0;
  mockCountFails = false;
});

describe('подсчёт очереди исходом', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: подставная база и вправду получает запрос', async () => {
    await outboxCountTry(null);
    expect(mockQueries.some((q) => q.sql.includes('COUNT(*)'))).toBe(true);
  });

  it('сосчитали — отдаём число', async () => {
    mockQueueSize = 3;
    await expect(outboxCountTry(2)).resolves.toEqual({ n: 3 });
  });

  it('ГРАНИЦА: пустая очередь — это прочитанный ответ, а не отказ', async () => {
    mockQueueSize = 0;
    await expect(outboxCountTry(2)).resolves.toEqual({ n: 0 });
  });

  it('база занята — «не знаем», а не «пусто»', async () => {
    mockQueueSize = 5;
    mockCountFails = true;
    await expect(outboxCountTry(2)).resolves.toBeNull();
  });

  it('короткая форма осталась и по-прежнему сводит оба ответа к нулю', async () => {
    mockQueueSize = 5;
    expect(await outboxCount(2)).toBe(5);
    mockCountFails = true;
    expect(await outboxCount(2)).toBe(0);
  });
});

describe('форма полоски', () => {
  it('полоска спрашивает исходом', () => {
    expect(BANNER).toContain(
      'const read = await outboxCountTry(profileManager.getActiveProfile()?.id ?? null);'
    );
    // Собирающей формы здесь не осталось: с ней третий ответ негде взять.
    expect(BANNER).not.toContain('await outboxCount(');
  });

  it('прочитанное число отказ подсчёта не стирает', () => {
    const branch = refusalBranch();
    // В ветке отказа нет ни одной записи в queueSize: она хранит прочитанное.
    expect(branch).not.toContain('setQueueSize');
    // Именно присваивание: сравнение `=== 0` в этой ветке как раз уместно.
    expect(branch).not.toMatch(/queueSizeRef\.current\s*=[^=]/);
    expect(branch).toContain('const unknown = queueSizeRef.current === 0;');
  });

  it('отправку подталкиваем и когда сосчитать не вышло', () => {
    expect(refusalBranch()).toContain(
      "if (AppState.currentState === 'active') await runSyncIfOnline();"
    );
  });

  it('опрос не останавливается на непрочитанном подсчёте', () => {
    expect(BANNER).toContain('if (queueSize === 0 && !countUnknown) return undefined;');
    expect(BANNER).toContain('(queueSizeRef.current > 0 || countUnknownRef.current)');
  });

  it('вместо молчания — что выяснить не удалось', () => {
    expect(BANNER).toContain('if (queueSize === 0 && !countUnknown) return null;');
    const at = BANNER.indexOf('Сколько сообщений ждёт отправки, выяснить не удалось');
    expect(at).toBeGreaterThan(0);
    expect(BANNER.slice(at, at + 200)).toContain('Отправку продолжаем');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: непустая очередь так и зовёт синхронизацию', () => {
    expect(BANNER).toContain("if (n > 0 && AppState.currentState === 'active') {");
    expect(BANNER).toContain('В очереди на отправку: ${queueSize}');
  });
});
