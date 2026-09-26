/**
 * Сорвавшаяся запись копии диалогов больше не уносит прежнюю (v4.32.969).
 *
 * Дефект. Запись шла так: временный файл — удалить прежний — переставить
 * временный на его место, а разбор отказа стирал временный. Между вторым и
 * третьим шагом копии не было ни одной, и отказ переноса заканчивался тем, что
 * `catch` дочищал последнее, что от переписки оставалось. Пояснение над этим
 * местом (v4.32.728) утверждало обратное: «содержимое к этому моменту уже
 * целиком на диске» — про временный файл правда, про прежний нет.
 *
 * Цена. В файле лежит вся переписка профиля одним куском, и смысл его ровно в
 * том, чтобы пережить потерю базы: это последнее, к чему можно вернуться.
 * Пишется он сам, через четыре секунды после каждого сообщения, — то есть
 * попасть на отказ может кто угодно и не узнать об этом.
 *
 * Ещё: обрывок `.tmp-<время>` не убирал никто. Имя у него каждый раз новое,
 * поэтому следующая запись поверх не встаёт, уборка при удалении профиля
 * сверяла точные имена, а уборка при сбросе кошелька — выражение, которому
 * обрывок не подходил. Вся переписка оставалась на устройстве после «удалить
 * данные» — и накапливалась по файлу на каждый обрыв.
 *
 * Правка. Прежняя копия отходит в сторону под именем `.prev`, а не стирается;
 * читатель это имя знает и поднимает — питание не ждёт никакого `catch`.
 * Уборки считают копией все три имени.
 *
 * Границы. Файловая система поддельная, в памяти.
 */
const mockFiles: Record<string, string> = {};
/** Переезд НА эти пути отказывает. */
const mockFailMoveTo = new Set<string>();
/** Переезд ОТКУДА отказывает — по началу пути. */
let mockFailMoveFrom = '';
/** Запись отказывает, не оставив байт. */
let mockWriteFails = false;
/** Сколько раз писали временный файл. */
let mockWrites = 0;
/** Чтение каталога отказывает — так ведёт себя web. */
let mockReadDirFails = false;

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: uri in mockFiles })),
  readAsStringAsync: jest.fn(async (uri: string) => mockFiles[uri] ?? ''),
  readDirectoryAsync: jest.fn(async (uri: string) => {
    if (mockReadDirFails) throw new Error('EPERM');
    return Object.keys(mockFiles)
      .filter((k) => k.startsWith(uri))
      .map((k) => k.slice(uri.length));
  }),
  writeAsStringAsync: jest.fn(async (uri: string, data: string) => {
    mockWrites += 1;
    if (mockWriteFails) throw new Error('ENOSPC');
    mockFiles[uri] = data;
  }),
  deleteAsync: jest.fn(async (uri: string) => { delete mockFiles[uri]; }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (mockFailMoveTo.has(to)) throw new Error(`move failed → ${to}`);
    if (mockFailMoveFrom && from.startsWith(mockFailMoveFrom)) throw new Error('move failed');
    if (!(from in mockFiles)) throw new Error('ENOENT');
    mockFiles[to] = mockFiles[from];
    delete mockFiles[from];
  }),
}));

jest.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: (cb: () => void) => cb() },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(async () => 'test mnemonic phrase'),
  deriveKeyPairFromMnemonicForProfile: jest.fn(() => ({
    publicKey: new Uint8Array(32).fill(7),
    secretKey: new Uint8Array(64),
  })),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { reloadBlocked: jest.fn(async () => {}) },
}));

/** Строки переписки, которые уйдут в копию. */
let mockRows: Array<Record<string, unknown>> = [];
/** Сколько строк примет импорт. */
let mockImported = 0;

jest.mock('../local', () => ({
  countChatMessages: jest.fn(async () => 0),
  exportConversationMetaRows: jest.fn(async () => []),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => mockRows),
  importConversationMetaRows: jest.fn(async () => 0),
  importDialogKvSnapshot: jest.fn(async () => 0),
  importGroupBackupRows: jest.fn(async () => ({ groups: 0, messages: 0, members: 0 })),
  importRawChatMessageRows: jest.fn(async () => mockImported),
  rebuildConversationsFromMessages: jest.fn(async () => 0),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  deleteAllDialogBackups,
  deleteDialogBackupForProfile,
  exportDialogBackupToFile,
  tryRestoreDialogBackupFromFile,
} from '../dialogBackup';

const URI = '/doc/airchat_dialogs_backup_v1_p1.json';
const PREV = `${URI}.prev`;

function row(id: string): Record<string, unknown> {
  return {
    id,
    contact_pub_b64: 'B'.repeat(43),
    cid: null,
    text: `шифротекст ${id}`,
    direction: 'in',
    status: 'read',
    media_cids: null,
    created_at: 1_700_000_000_000,
    owner_profile_id: 1,
  };
}

/** Только код: пояснения закрепку удовлетворять не должны. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SRC = codeOnly(readFileSync(join(__dirname, '..', 'dialogBackup.ts'), 'utf8'));

/** Сколько строк переписки лежит в файле по этому адресу. */
const rowsIn = (uri: string): number =>
  (JSON.parse(mockFiles[uri]) as { messages: unknown[] }).messages.length;

beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockFailMoveTo.clear();
  mockFailMoveFrom = '';
  mockWriteFails = false;
  mockWrites = 0;
  mockReadDirFails = false;
  mockRows = [row('m1')];
  mockImported = 0;
});

describe('отказ записи не уносит прежнюю копию', () => {
  it('перенос сорвался — прежняя переписка на месте', async () => {
    expect(await exportDialogBackupToFile()).toBe(URI);
    mockRows = [row('m1'), row('m2')];

    // Отказывает перестановка временного файла; отход прежней в сторону и
    // возврат проходят.
    mockFailMoveFrom = `${URI}.tmp-`;
    await expect(exportDialogBackupToFile()).rejects.toThrow();
    mockFailMoveFrom = '';

    // До правки здесь не было ничего: прежнюю стёрли, временный дочистил
    // разбор отказа.
    expect(mockFiles[URI]).toBeDefined();
    expect(rowsIn(URI)).toBe(1);
    expect(Object.keys(mockFiles)).toEqual([URI]);
  });

  it('обрыв питания между переносами — читатель поднимает отодвинутую', async () => {
    expect(await exportDialogBackupToFile()).toBe(URI);
    // Ровно то, что остаётся на диске от снятого приложения.
    mockFiles[PREV] = mockFiles[URI];
    delete mockFiles[URI];

    mockImported = 1;
    expect(await tryRestoreDialogBackupFromFile()).toBe(1);
    expect(Object.keys(mockFiles)).toEqual([URI]);
  });

  it('сорвались оба переноса — переписка всё равно возвращается', async () => {
    expect(await exportDialogBackupToFile()).toBe(URI);

    mockFailMoveTo.add(URI);
    await expect(exportDialogBackupToFile()).rejects.toThrow();
    mockFailMoveTo.clear();

    mockImported = 1;
    expect(await tryRestoreDialogBackupFromFile()).toBe(1);
  });
});

describe('уборка считает копией все её имена', () => {
  it('сброс кошелька уносит и отодвинутую, и обрывок', async () => {
    mockFiles[URI] = '{"v":1,"messages":[]}';
    mockFiles[PREV] = '{"v":1,"messages":[]}';
    mockFiles[`${URI}.tmp-1700000000000`] = '{"v":1,"messages":[]}';
    mockFiles['/doc/airchat_dialogs_backup_v1.json'] = '{"v":1,"messages":[]}';

    await deleteAllDialogBackups();
    expect(Object.keys(mockFiles)).toEqual([]);
  });

  it('удаление профиля уносит его обрывки', async () => {
    mockFiles[URI] = '{"v":1,"messages":[]}';
    mockFiles[`${URI}.tmp-1700000000000`] = '{"v":1,"messages":[]}';

    await deleteDialogBackupForProfile(1);
    expect(Object.keys(mockFiles)).toEqual([]);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отход в сторону не вправе ни оставлять мусор после удачной записи, ни трогать
 * чужие файлы, ни выдумывать копию там, где её не было.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный ход не изменился', () => {
  it('удачная запись оставляет ровно один файл', async () => {
    expect(await exportDialogBackupToFile()).toBe(URI);
    expect(Object.keys(mockFiles)).toEqual([URI]);
    expect(await exportDialogBackupToFile()).toBe(URI);
    expect(Object.keys(mockFiles)).toEqual([URI]);
  });

  it('обрыв записи временного прежнюю не трогает', async () => {
    expect(await exportDialogBackupToFile()).toBe(URI);
    const before = mockFiles[URI];

    mockWriteFails = true;
    await expect(exportDialogBackupToFile()).rejects.toThrow();
    mockWriteFails = false;

    expect(mockFiles[URI]).toBe(before);
  });

  it('ГРАНИЦА: удаление профиля чужих файлов не трогает', async () => {
    mockFiles[URI] = 'свой';
    mockFiles['/doc/airchat_dialogs_backup_v1_p2.json'] = 'чужой';
    mockFiles['/doc/airchat_dialogs_backup_v1_p2.json.tmp-1'] = 'чужой обрывок';

    await deleteDialogBackupForProfile(1);
    expect(mockFiles['/doc/airchat_dialogs_backup_v1_p2.json']).toBe('чужой');
    expect(mockFiles['/doc/airchat_dialogs_backup_v1_p2.json.tmp-1']).toBe('чужой обрывок');
  });

  it('ГРАНИЦА: копии нет вовсе — читатель отвечает нулём', async () => {
    expect(await tryRestoreDialogBackupFromFile()).toBe(0);
  });

  it('ГРАНИЦА: каталог не прочитался — точные имена всё равно уходят', async () => {
    mockFiles[URI] = '{"v":1,"messages":[]}';
    mockReadDirFails = true;
    await expect(deleteDialogBackupForProfile(1)).resolves.toBeUndefined();
    expect(mockFiles[URI]).toBeUndefined();
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отказ случается именно на переносе — запись к тому моменту прошла целиком, —
 * а теряется при этом весь разговор, а не строка настройки.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отказ на переносе, а не на записи', async () => {
    expect(await exportDialogBackupToFile()).toBe(URI);
    mockWrites = 0;

    mockFailMoveFrom = `${URI}.tmp-`;
    await expect(exportDialogBackupToFile()).rejects.toThrow();
    expect(mockWrites).toBe(1);
  });

  it('в файле — вся переписка профиля и ключ владельца', async () => {
    mockRows = [row('m1'), row('m2'), row('m3')];
    expect(await exportDialogBackupToFile()).toBe(URI);
    const saved = JSON.parse(mockFiles[URI]) as { messages: unknown[]; walletPubKeyB64: string };
    expect(saved.messages).toHaveLength(3);
    expect(saved.walletPubKeyB64).toBe(Buffer.from(new Uint8Array(32).fill(7)).toString('base64'));
  });
});

describe('форма исходников: прежняя отходит в сторону и поднимается', () => {
  it('у отодвинутого имени есть создатель и подъёмник', () => {
    expect(SRC).toContain('function previousBackupUri(uri: string): string {');
    expect(SRC).toContain('async function restoreStrandedBackup(uri: string): Promise<void> {');
    expect(SRC).toContain('await restoreStrandedBackup(readUri);');
  });

  it('прежнюю больше не стирают перед перестановкой', () => {
    expect(SRC).not.toContain(
      'await FileSystem.deleteAsync(uri, { idempotent: true });\n    await FileSystem.moveAsync({ from: temporary, to: uri });'
    );
    expect(SRC).toContain('await FileSystem.moveAsync({ from: uri, to: previous });');
    expect(SRC).toContain("log.error('dialog_backup_previous_rollback_failed'");
  });

  it('уборка знает все три имени', () => {
    expect(SRC).not.toContain('/^airchat_dialogs_backup_v1_p\\d+\\.json$/');
    expect(SRC).toContain('BACKUP_NAME_RE.test(name)');
    expect(SRC).toContain('function isNameOfBackup(name: string, mainName: string): boolean {');
  });
});
