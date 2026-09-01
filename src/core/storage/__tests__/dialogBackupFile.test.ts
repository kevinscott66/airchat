/**
 * Адрес файла резервной копии (v4.32.307).
 *
 * Копия переехала на имя с номером профиля в v4.32.280, но экран настроек
 * продолжал собирать имя сам и по-старому. Экспорт из интерфейса поэтому либо
 * не находил только что записанный файл, либо — на устройстве, обновлённом с
 * версии до v4.32.280, — находил общую копию и отдавал в «Поделиться»
 * переписку ПЕРВОГО профиля из любого профиля.
 *
 * Отсюда и требование к функции: она возвращает адрес, который записала, и
 * вызывающему не из чего вывести другой.
 *
 * expo-file-system — фейк в памяти, диск не трогается.
 */
jest.mock('expo-file-system/legacy', () => {
  const files: Record<string, string> = {};
  return {
    __files: files,
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8' },
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: uri in files })),
    readAsStringAsync: jest.fn(async (uri: string) => files[uri] ?? ''),
    writeAsStringAsync: jest.fn(async (uri: string, data: string) => { files[uri] = data; }),
    deleteAsync: jest.fn(async (uri: string) => { delete files[uri]; }),
  };
});
jest.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: (cb: () => void) => cb() },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

let mockMnemonic: string | null = 'test mnemonic phrase';
jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(async () => mockMnemonic),
  deriveKeyPairFromMnemonicForProfile: jest.fn(() => ({
    publicKey: new Uint8Array(32).fill(7),
    secretKey: new Uint8Array(64),
  })),
}));

let mockActiveProfileId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveProfileId }) },
}));

// v4.32.370: сколько строк импортёр действительно записал — теперь его ответ,
// а не предположение вызывающего, поэтому в тестах восстановления он задаётся.
let mockImportedMessages = 0;
let mockImportedKv = 0;
let mockExistingMessages = 0;
jest.mock('../local', () => ({
  countChatMessages: jest.fn(async () => mockExistingMessages),
  exportConversationMetaRows: jest.fn(async () => []),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => []),
  importConversationMetaRows: jest.fn(async () => 0),
  importDialogKvSnapshot: jest.fn(async () => mockImportedKv),
  importGroupBackupRows: jest.fn(async () => ({ groups: 0, messages: 0, members: 0 })),
  importRawChatMessageRows: jest.fn(async () => mockImportedMessages),
  rebuildConversationsFromMessages: jest.fn(async () => 0),
}));

import { RAW_CHAT_MESSAGE_MAX_ROWS } from '../chatMessageBackup';
import {
  deleteDialogBackupForProfile,
  exportDialogBackupToFile,
  tryRestoreDialogBackupFromFile,
} from '../dialogBackup';

const fsMock = jest.requireMock('expo-file-system/legacy') as { __files: Record<string, string> };
const LEGACY_URI = '/doc/airchat_dialogs_backup_v1.json';
/** Тот же ключ, что выдаёт фейк deriveKeyPairFromMnemonicForProfile. */
const WALLET_PUB = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

beforeEach(() => {
  for (const k of Object.keys(fsMock.__files)) delete fsMock.__files[k];
  mockActiveProfileId = 1;
  mockMnemonic = 'test mnemonic phrase';
  mockImportedMessages = 0;
  mockImportedKv = 0;
  mockExistingMessages = 0;
});

describe('адрес файла копии', () => {
  it('возвращается тот же адрес, по которому файл и записан', async () => {
    const uri = await exportDialogBackupToFile();
    expect(uri).toBe('/doc/airchat_dialogs_backup_v1_p1.json');
    expect(fsMock.__files[uri as string]).toBeDefined();
  });

  it('у второго профиля — своё имя, и оно не общее', async () => {
    mockActiveProfileId = 2;
    const uri = await exportDialogBackupToFile();
    expect(uri).toBe('/doc/airchat_dialogs_backup_v1_p2.json');
    expect(fsMock.__files[LEGACY_URI]).toBeUndefined();
  });

  it('общая копия до v4.32.280 не выдаётся за свежую', async () => {
    // Ровно случай обновлённого устройства: старый файл на диске есть, но
    // экспорт обязан вернуть адрес НОВОГО файла активного профиля.
    fsMock.__files[LEGACY_URI] = '{"v":1,"messages":[]}';
    mockActiveProfileId = 2;
    const uri = await exportDialogBackupToFile();
    expect(uri).not.toBe(LEGACY_URI);
    expect(fsMock.__files[LEGACY_URI]).toBe('{"v":1,"messages":[]}');
  });

  it('без сид-фразы файл не пишется и адреса нет', async () => {
    // null, а не адрес несуществующего файла: иначе «Поделиться» открылось бы
    // на пустоту, а вызывающий не отличил бы «не записалось» от «записалось».
    mockMnemonic = null;
    expect(await exportDialogBackupToFile()).toBeNull();
    expect(Object.keys(fsMock.__files)).toHaveLength(0);
  });
});

describe('удаление копии удалённого профиля (v4.32.309)', () => {
  it('уходит копия своего профиля и только своя', async () => {
    // Удаление профиля чистило базу и ленту, а копию оставляло: вся переписка
    // удалённого аккаунта продолжала лежать на диске под тем же DEK, и навсегда
    // — номера профилей монотонны, перезаписать этот файл уже некому.
    fsMock.__files['/doc/airchat_dialogs_backup_v1_p2.json'] = 'x';
    fsMock.__files['/doc/airchat_dialogs_backup_v1_p3.json'] = 'y';
    await deleteDialogBackupForProfile(2);
    expect(fsMock.__files['/doc/airchat_dialogs_backup_v1_p2.json']).toBeUndefined();
    expect(fsMock.__files['/doc/airchat_dialogs_backup_v1_p3.json']).toBe('y');
  });

  it('вместе с первым профилем уходит и общая копия до v4.32.280', async () => {
    // Её наследует только первый профиль — значит с ним и должна уйти.
    fsMock.__files[LEGACY_URI] = 'old';
    fsMock.__files['/doc/airchat_dialogs_backup_v1_p1.json'] = 'new';
    await deleteDialogBackupForProfile(1);
    expect(Object.keys(fsMock.__files)).toHaveLength(0);
  });

  it('общая копия остаётся, когда удаляют не первый профиль', async () => {
    fsMock.__files[LEGACY_URI] = 'old';
    await deleteDialogBackupForProfile(2);
    expect(fsMock.__files[LEGACY_URI]).toBe('old');
  });
});

describe('восстановление из файла (v4.32.370)', () => {
  const P1 = '/doc/airchat_dialogs_backup_v1_p1.json';

  function put(uri: string, body: unknown): void {
    fsMock.__files[uri] = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const goodFile = (messages: unknown[]): object => ({
    v: 1,
    walletPubKeyB64: WALLET_PUB,
    exportedAt: 1,
    messages,
    kv: [],
  });

  it('возвращается число записанных строк, а не число строк в файле', async () => {
    // Проверка отбрасывает строку целиком — чужой профиль, битый ключ,
    // время из будущего. Раньше отчёт брался из длины массива в файле, и
    // «восстановлено 3 сообщения» стояло рядом с пустым списком чатов.
    put(P1, goodFile([{}, {}, {}]));
    mockImportedMessages = 1;
    expect(await tryRestoreDialogBackupFromFile()).toBe(1);
  });

  it('ноль записанных — это ноль, даже когда файл не пустой', async () => {
    put(P1, goodFile([{}, {}]));
    mockImportedMessages = 0;
    expect(await tryRestoreDialogBackupFromFile()).toBe(0);
  });

  it('файл из одного слова null не роняет загрузку', async () => {
    // JSON.parse('null') — это годный JSON, а `data.v` на нём TypeError. Он
    // летел мимо обоих catch: разбор их не покрывает, а вызывающий в App.tsx
    // стоит на пути загрузки и своего try не имеет.
    put(P1, 'null');
    await expect(tryRestoreDialogBackupFromFile()).resolves.toBe(0);
  });

  it('другие не-объекты на месте копии — тоже ноль, а не исключение', async () => {
    for (const body of ['123', '"строка"', '[1,2,3]', 'true', 'не json', '']) {
      put(P1, body);
      await expect(tryRestoreDialogBackupFromFile()).resolves.toBe(0);
    }
  });

  it('копия чужого кошелька не восстанавливается', async () => {
    put(P1, { ...goodFile([{}]), walletPubKeyB64: 'B'.repeat(44) });
    mockImportedMessages = 5;
    expect(await tryRestoreDialogBackupFromFile()).toBe(0);
  });

  it('непустая база оставляется в покое', async () => {
    // Иначе восстановление затёрло бы более свежую переписку старой копией.
    put(P1, goodFile([{}]));
    mockExistingMessages = 1;
    mockImportedMessages = 1;
    expect(await tryRestoreDialogBackupFromFile()).toBe(0);
  });

  it('messages не массивом — плохой формат, а не попытка разбора', async () => {
    for (const messages of [null, 'x', 42, { length: 3 }]) {
      put(P1, { ...goodFile([]), messages });
      mockImportedMessages = 7;
      await expect(tryRestoreDialogBackupFromFile()).resolves.toBe(0);
    }
  });

  it('файл со строками сверх предела не разбирается вовсе', async () => {
    // Предел стоит на числе строк: разбор подменённого файла с миллионом
    // сообщений — это минуты SQL, которых восстановление может не пережить.
    put(P1, goodFile(new Array(RAW_CHAT_MESSAGE_MAX_ROWS + 1).fill(null)));
    mockImportedMessages = 7;
    expect(await tryRestoreDialogBackupFromFile()).toBe(0);
  });

  it('без файла — ноль и никакого импорта', async () => {
    expect(await tryRestoreDialogBackupFromFile()).toBe(0);
  });
});
