/**
 * Беззвучный режим диалога сознаётся, когда база отказала (v4.32.630).
 *
 * `setConversationMuted` и `setConversationMutedUntil` ловили исключение в
 * журнал и не возвращали ничего. Экран чата и список переписок переключали
 * строку меню сразу после вызова — а значит показывали не то, что в базе:
 * «Включить звук» там, где muted=1 никуда не делось, и обещание тишины там,
 * где уведомления продолжали приходить. Ни повторить, ни узнать о расхождении
 * человеку было нечем.
 *
 * Близнец в глушении — {@link setMuted} (см. muteSetChecked630).
 */
let mockFail = false;
const mockRun: string[] = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string) => {
      if (mockFail) throw new Error('database is locked');
      mockRun.push(sql);
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

import { setConversationMuted, setConversationMutedUntil } from '../local';

const PEER = 'Q'.repeat(43);

beforeEach(() => {
  mockFail = false;
  mockRun.length = 0;
});

describe('флаг беззвучного режима диалога', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: при исправной базе флаг пишется и признаётся', async () => {
    await expect(setConversationMuted(PEER, 1, true)).resolves.toBe(true);
    expect(mockRun.some((s) => /conversations/.test(s))).toBe(true);
  });

  it('отказ базы не выдаётся за поставленный флаг', async () => {
    mockFail = true;
    await expect(setConversationMuted(PEER, 1, true)).resolves.toBe(false);
  });

  it('включение звука тоже сознаётся', async () => {
    mockFail = true;
    await expect(setConversationMuted(PEER, 1, false)).resolves.toBe(false);
  });
});

describe('срок беззвучного режима диалога', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: срок пишется и признаётся', async () => {
    await expect(setConversationMutedUntil(PEER, 1, Date.now() + 3600_000)).resolves.toBe(true);
  });

  it('отказ базы не выдаётся за поставленный срок', async () => {
    mockFail = true;
    await expect(setConversationMutedUntil(PEER, 1, Date.now() + 3600_000)).resolves.toBe(false);
  });

  it('бессрочная тишина при отказе — тоже false', async () => {
    mockFail = true;
    await expect(setConversationMutedUntil(PEER, 1, null)).resolves.toBe(false);
  });
});
