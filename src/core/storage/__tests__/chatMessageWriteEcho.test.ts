/**
 * Правка и удаление сообщения сознаются, когда строки не оказалось (v4.32.615).
 *
 * `updateChatMessageText` и `deleteChatMessage` объявлены как «возвращает,
 * получилось ли», и на этом слове стоят обещания, которые видит человек:
 * `editMessage` и `sendDeleteTombstone` строят из него ответ «изменено у вас,
 * но собеседнику отправить не удалось» / «удалено у вас». Результат запроса при
 * этом не смотрели, и «ни одной строки не подошло» возвращалось как успех —
 * человеку показывали, что у него всё изменилось, когда не изменилось ничего.
 *
 * Групповой близнец `updateGroupMessageText` считает строки с v4.32.371; здесь
 * та же проверка появилась только сейчас.
 */
let mockChanges = 1;
const mockRun: string[] = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string) => {
      mockRun.push(sql);
      return { changes: mockChanges, lastInsertRowId: 1 };
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

import { deleteChatMessage, updateChatMessageText, updateGroupMessageText } from '../local';

beforeEach(() => {
  mockChanges = 1;
  mockRun.length = 0;
});

describe('правка сообщения', () => {
  it('строка нашлась — true', async () => {
    await expect(updateChatMessageText('m1', 'новый текст', 1)).resolves.toBe(true);
  });

  it('чужой профиль или несуществующий id — false, а не «изменено»', async () => {
    mockChanges = 0;
    await expect(updateChatMessageText('m1', 'новый текст', 9)).resolves.toBe(false);
  });

  it('стенд не пустой: групповой близнец ведёт себя так же', async () => {
    mockChanges = 0;
    await expect(updateGroupMessageText('g1', 'новый текст', 1)).resolves.toBe(false);
    mockChanges = 1;
    await expect(updateGroupMessageText('g1', 'новый текст', 1)).resolves.toBe(true);
  });
});

describe('удаление сообщения', () => {
  it('строка нашлась — true', async () => {
    await expect(deleteChatMessage('m1', 1)).resolves.toBe(true);
  });

  it('удалять было нечего — false', async () => {
    mockChanges = 0;
    await expect(deleteChatMessage('m1', 9)).resolves.toBe(false);
  });

  it('после пустого DELETE следы опроса не подчищаются', async () => {
    mockChanges = 0;
    await deleteChatMessage('m1', 9);
    const after = mockRun.slice(mockRun.findIndex((s) => s.includes('DELETE FROM chat_messages')) + 1);
    expect(after.some((s) => /DELETE FROM poll/i.test(s))).toBe(false);
  });
});
