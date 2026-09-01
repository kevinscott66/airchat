/**
 * Восстановление переписки после импорта seed (v4.32.351).
 *
 * Проверяется главное свойство: два источника переписки — файл на устройстве и
 * релей — независимы. Провал одного не имеет права отменить второй, потому что
 * это единственный момент, когда пользователь может получить свою историю
 * обратно, и второй попытки не будет.
 */

const mockRestoreFromFile = jest.fn<Promise<number>, []>();
const mockRunSync = jest.fn<Promise<void>, []>();
const mockLogged: Array<[string, string, unknown]> = [];

jest.mock('../../storage/dialogBackup', () => ({
  tryRestoreDialogBackupFromFile: () => mockRestoreFromFile(),
}));
jest.mock('../../storage/sync', () => ({
  runSyncIfOnline: () => mockRunSync(),
}));
jest.mock('../../logger', () => ({
  log: {
    info: (msg: string, meta?: unknown) => mockLogged.push(['info', msg, meta]),
    warn: (msg: string, meta?: unknown) => mockLogged.push(['warn', msg, meta]),
    debug: (msg: string, meta?: unknown) => mockLogged.push(['debug', msg, meta]),
    error: (msg: string, meta?: unknown) => mockLogged.push(['error', msg, meta]),
  },
}));

import { restoreChatsAfterWalletImport } from '../chatRestore';

const msgs = (): string[] => mockLogged.map(([, m]) => m);
const metaOf = (msg: string): Record<string, unknown> =>
  (mockLogged.find(([, m]) => m === msg)?.[2] ?? {}) as Record<string, unknown>;

beforeEach(() => {
  mockRestoreFromFile.mockReset();
  mockRunSync.mockReset();
  mockLogged.length = 0;
  mockRestoreFromFile.mockResolvedValue(0);
  mockRunSync.mockResolvedValue(undefined);
});

describe('restoreChatsAfterWalletImport', () => {
  it('в норме проходит оба шага', async () => {
    mockRestoreFromFile.mockResolvedValue(42);

    await restoreChatsAfterWalletImport();

    expect(mockRestoreFromFile).toHaveBeenCalledTimes(1);
    expect(mockRunSync).toHaveBeenCalledTimes(1);
    expect(msgs()).toContain('chat_restore_local_file');
    expect(metaOf('chat_restore_local_file')).toEqual({ messages: 42 });
    expect(metaOf('chat_restore_after_import_done')).toEqual({
      messages: 42,
      localOk: true,
      syncOk: true,
    });
  });

  it('пустой локальный файл не считается событием', async () => {
    mockRestoreFromFile.mockResolvedValue(0);

    await restoreChatsAfterWalletImport();

    expect(msgs()).not.toContain('chat_restore_local_file');
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it('сбой локального файла НЕ отменяет сетевую синхронизацию', async () => {
    // Ровно та регрессия, ради которой раунд и делался: до правки оба шага
    // стояли под одним try, и здесь runSyncIfOnline не вызывался вовсе.
    mockRestoreFromFile.mockRejectedValue(new Error('database is locked'));

    await restoreChatsAfterWalletImport();

    expect(mockRunSync).toHaveBeenCalledTimes(1);
    expect(metaOf('chat_restore_local_file_failed')).toEqual({ err: 'database is locked' });
    expect(metaOf('chat_restore_after_import_done')).toEqual({
      messages: 0,
      localOk: false,
      syncOk: true,
    });
  });

  it('сбой синхронизации не отменяет уже восстановленное из файла', async () => {
    mockRestoreFromFile.mockResolvedValue(7);
    mockRunSync.mockRejectedValue(new Error('offline'));

    await restoreChatsAfterWalletImport();

    expect(metaOf('chat_restore_local_file')).toEqual({ messages: 7 });
    expect(metaOf('chat_restore_sync_failed')).toEqual({ err: 'offline' });
    expect(metaOf('chat_restore_after_import_done')).toEqual({
      messages: 7,
      localOk: true,
      syncOk: false,
    });
  });

  it('не бросает наружу, даже если провалились оба шага', async () => {
    // Вызывающий код стоит на пути импорта кошелька — падение там оставило бы
    // пользователя с импортированным ключом и оборванным экраном.
    mockRestoreFromFile.mockRejectedValue(new Error('keystore locked'));
    mockRunSync.mockRejectedValue(new Error('no network'));

    await expect(restoreChatsAfterWalletImport()).resolves.toBeUndefined();

    expect(metaOf('chat_restore_after_import_done')).toEqual({
      messages: 0,
      localOk: false,
      syncOk: false,
    });
  });

  it('не-Error причина попадает в журнал строкой, а не «[object Object]»', async () => {
    mockRestoreFromFile.mockRejectedValue('SQLITE_BUSY');

    await restoreChatsAfterWalletImport();

    expect(metaOf('chat_restore_local_file_failed')).toEqual({ err: 'SQLITE_BUSY' });
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });
});
