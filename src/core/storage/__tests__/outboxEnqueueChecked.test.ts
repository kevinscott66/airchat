/**
 * Очередь отправки обязана сознаваться, что не приняла конверт (v4.32.476).
 *
 * `outboxEnqueue` был объявлен как `Promise<void>`, и снаружи три разных
 * исхода выглядели одинаково: строка записана, payload отброшен как слишком
 * большой, запись упала на ошибке базы. Отправка сообщения без связи после
 * этого ставила статус `sent`, а «удалить у всех» и «изменить у всех»
 * отвечали `queued` — то есть «собеседник получит, когда появится связь».
 * Ни то, ни другое не было правдой при полном диске: в очереди не лежало
 * ничего, повторить отправку человек не мог (кнопка повтора есть только у
 * `failed`), и о потере никто не узнавал.
 */
let mockWriteFails = false;
const mockRuns: Array<{ sql: string; params: unknown[] }> = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      mockRuns.push({ sql, params });
      if (mockWriteFails) throw new Error('SQLITE_FULL: database or disk is full');
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
  encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
  encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
  decryptAtRestString: jest.fn((v: string) => v.replace('enc2:', '')),
  decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : v.replace('enc2:', ''))),
  isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { kvSetChecked, outboxEnqueue } from '../local';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const MESSAGING = fs.readFileSync(
  path.join(__dirname, '..', '..', 'social', 'messaging.ts'),
  'utf8'
);

/** Сколько строк реально ушло в таблицу очереди. */
function insertsIntoOutbox(): number {
  return mockRuns.filter((r) => r.sql.includes('INSERT INTO outbox')).length;
}

beforeEach(() => {
  mockWriteFails = false;
  mockRuns.length = 0;
});

describe('outboxEnqueue отвечает, легла ли строка', () => {
  it('обычная постановка — true, и строка действительно вставлена', async () => {
    await expect(outboxEnqueue('dm', 'payload', 1, 7)).resolves.toBe(true);
    expect(insertsIntoOutbox()).toBe(1);
  });

  it('база не приняла запись — false, а не молчаливое «поставлено»', async () => {
    // Прогреваем соединение на исправной базе, чтобы упала именно вставка.
    await outboxEnqueue('dm', 'warmup', 1, 7);
    mockRuns.length = 0;
    mockWriteFails = true;
    await expect(outboxEnqueue('dm', 'payload', 1, 7)).resolves.toBe(false);
  });

  it('payload сверх лимита — false, и в базу ничего не идёт', async () => {
    await outboxEnqueue('dm', 'warmup', 1, 7);
    mockRuns.length = 0;
    const huge = 'x'.repeat(256 * 1024 + 1);
    await expect(outboxEnqueue('dm', huge, 1, 7)).resolves.toBe(false);
    expect(insertsIntoOutbox()).toBe(0);
  });

  it('ровно лимит — это ещё «поместилось»', async () => {
    const atLimit = 'x'.repeat(256 * 1024);
    await expect(outboxEnqueue('dm', atLimit, 1, 7)).resolves.toBe(true);
  });

  it('ответ — булев, а не undefined: его можно проверить через if', async () => {
    const ok = await outboxEnqueue('ctl', 'payload', 1, 7);
    expect(typeof ok).toBe('boolean');
  });
});

describe('отправка без онлайн-пути не маскируется под успешную', () => {
  it('не создаёт новую offline-очередь', () => {
    expect(MESSAGING).not.toContain('outboxEnqueue(');
  });

  it('сообщение помечается failed при отсутствии маршрута', () => {
    expect(MESSAGING).toContain("log.info('dm_send_no_online_route', { peerDid, messageId });");
    expect(MESSAGING).toContain("await saveRow({ ...pending, status: 'failed' });");
  });

  it('кнопка повтора в чате живёт именно на статусе failed', () => {
    const chat = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'),
      'utf8'
    );
    expect(chat).toContain("row.status !== 'failed'");
  });
});

describe('«удалить у всех» и «изменить у всех» не обещают лишнего', () => {
  it('без онлайн-доставки не выполняется только половина у собеседника', () => {
    // v4.32.550 ставил проверку связи в начало обеих операций и отменял ею
    // локальную половину. v4.32.555 вернул порядок: сеть спрашивают уже после
    // собственной строки и только ради конверта собеседнику.
    expect(MESSAGING).not.toContain("try { await requireOnlineWrite(await localPathTo(contactPubB64)); } catch { return 'unreachable'; }");
    expect((MESSAGING.match(/shouldTryPeerHalf\(localDone, online\.ok\)/g) ?? []).length).toBe(2);
    expect((MESSAGING.match(/combineHalves\(localDone, 'unreachable'\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('unreachable описан как отказ доставки, а не как отмена всей операции', () => {
    const policy = fs.readFileSync(
      path.join(__dirname, '..', '..', 'social', 'twoSidedEdit.ts'),
      'utf8'
    );
    expect(policy).toContain('нет канала, нет сети');
    expect(policy).toContain("'your-side-only'");
  });

  it('человеку в этом случае не говорят «получит, когда появится связь»', () => {
    const feedback = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'components', 'userFeedback.ts'),
      'utf8'
    );
    expect(feedback).toContain('собеседнику отправить не удалось');
  });
});

describe('проверка не пустая', () => {
  it('подпись очереди объявляет булев ответ', () => {
    const at = LOCAL.indexOf('export async function outboxEnqueue(');
    expect(at).toBeGreaterThan(0);
    const head = LOCAL.slice(at, at + 200);
    expect(head).toContain('): Promise<boolean> {');
  });

  it('тот же стенд валит и обычную проверенную запись', async () => {
    await kvSetChecked('k', 'v');
    mockWriteFails = true;
    await expect(kvSetChecked('k', 'v')).resolves.toBe(false);
  });
});
