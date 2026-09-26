/**
 * Отменённая копия диалогов больше не возвращается после сброса (v4.32.970).
 *
 * Дефект. Отсрочка записи двухступенчатая: таймер на четыре секунды, а за ним
 * `InteractionManager.runAfterInteractions` — очередь, которая ждёт конца
 * анимаций и снять из себя задачу не умеет. Отмена гасила только таймер. Между
 * ступенями `debounceTimer` уже null, и отмена становилась пустым действием —
 * ровно тогда, когда запись была ближе всего. Начатую запись она тоже не
 * ждала: возвращала `void` и уходила.
 *
 * Цена. Зовут отмену из сброса кошелька первым шагом, а файлы копий уносит шаг
 * `dialog_backups` двумя десятками шагов позже. Всё, что успевало записаться в
 * этом промежутке, переживало «удалить данные на устройстве» навсегда: в файле
 * вся переписка профиля одним куском, номер профиля повторно не займёт никто,
 * перезаписать файл нечем. Сброс при этом отвечал `ok: true`.
 *
 * Правка. У отсрочек появился номер поколения: задача, дошедшая до очереди
 * взаимодействий, сама спрашивает, тот ли мир вокруг, в котором её заводили.
 * Отмена поколение сдвигает и дожидается записи, которая уже идёт, — тогда
 * удаление файлов заведомо идёт ПОСЛЕ неё, а не до. В сбросе добавлена вторая
 * отмена сразу за удалением файлов.
 *
 * Границы. Поколение, а не флаг «запись выключена»: после сброса приложение
 * поднимается в том же процессе (walletBootNonce), и выключенная навсегда
 * копия — это следующий владелец устройства без резервной копии. Отдельная
 * проверка внизу следит, чтобы отсрочка после отмены снова работала.
 */
const mockFiles: Record<string, string> = {};
/** Сколько раз писали временный файл. */
let mockWrites = 0;
/** Пока не разрешится — запись висит. */
let mockWriteGate: Promise<void> | null = null;
/** Задачи, отданные очереди взаимодействий и ещё не выполненные. */
const mockInteractions: Array<() => void> = [];

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: uri in mockFiles })),
  readAsStringAsync: jest.fn(async (uri: string) => mockFiles[uri] ?? ''),
  readDirectoryAsync: jest.fn(async (uri: string) =>
    Object.keys(mockFiles)
      .filter((k) => k.startsWith(uri))
      .map((k) => k.slice(uri.length)),
  ),
  writeAsStringAsync: jest.fn(async (uri: string, data: string) => {
    mockWrites += 1;
    if (mockWriteGate) await mockWriteGate;
    mockFiles[uri] = data;
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    delete mockFiles[uri];
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (!(from in mockFiles)) throw new Error('ENOENT');
    mockFiles[to] = mockFiles[from];
    delete mockFiles[from];
  }),
}));

jest.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (cb: () => void) => {
      mockInteractions.push(cb);
    },
  },
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

jest.mock('../local', () => ({
  countChatMessages: jest.fn(async () => 0),
  exportConversationMetaRows: jest.fn(async () => []),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => mockRows),
  importConversationMetaRows: jest.fn(async () => 0),
  importDialogKvSnapshot: jest.fn(async () => 0),
  importGroupBackupRows: jest.fn(async () => ({ groups: 0, messages: 0, members: 0 })),
  importRawChatMessageRows: jest.fn(async () => 0),
  rebuildConversationsFromMessages: jest.fn(async () => 0),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  cancelScheduledDialogBackup,
  deleteAllDialogBackups,
  exportDialogBackupToFile,
  scheduleDialogBackupPersist,
} from '../dialogBackup';

const URI = '/doc/airchat_dialogs_backup_v1_p1.json';
const DEBOUNCE_MS = 4000;

function row(id: string): Record<string, unknown> {
  return {
    id,
    contact_pub_b64: 'B'.repeat(43),
    text: `сообщение ${id}`,
    timestamp: 1,
    direction: 'in',
    owner_pid: 1,
  };
}

/** Все имена, под которыми копия может лежать на диске. */
function backupFiles(): string[] {
  return Object.keys(mockFiles)
    .filter((k) => k.includes('airchat_dialogs_backup'))
    .sort();
}

/** Дать микрозадачам доработать: запись идёт через полдюжины `await`. */
async function tick(times = 60): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Отдать очереди взаимодействий то, что в ней накопилось. */
function flushInteractions(): void {
  const queued = mockInteractions.splice(0, mockInteractions.length);
  for (const cb of queued) cb();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Только код: пояснения не должны сами удовлетворять закрепку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SRC = codeOnly(readFileSync(join(__dirname, '..', 'dialogBackup.ts'), 'utf8'));
const WIPE = codeOnly(
  readFileSync(join(__dirname, '..', '..', 'wallet', 'wipeLocalWallet.ts'), 'utf8'),
);

beforeEach(async () => {
  jest.useFakeTimers();
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockWrites = 0;
  mockWriteGate = null;
  mockInteractions.length = 0;
  mockRows = [row('m1'), row('m2')];
  await cancelScheduledDialogBackup();
  mockInteractions.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('отмена настигает запись на любой ступени отсрочки', () => {
  it('таймер отработал, запись в очереди — отмена её всё равно снимает', async () => {
    scheduleDialogBackupPersist();
    jest.advanceTimersByTime(DEBOUNCE_MS);
    expect(mockInteractions).toHaveLength(1);

    await cancelScheduledDialogBackup();
    flushInteractions();
    await tick();

    expect(mockWrites).toBe(0);
    expect(backupFiles()).toEqual([]);
  });

  it('сброс кошелька не возвращает переписку, дождавшуюся конца анимаций', async () => {
    scheduleDialogBackupPersist();
    jest.advanceTimersByTime(DEBOUNCE_MS);

    // Так и идёт сброс: отмена — первым шагом, удаление файлов — много позже.
    await cancelScheduledDialogBackup();
    await deleteAllDialogBackups();

    // А анимации кончились уже после того, как человеку сказали «удалено».
    flushInteractions();
    await tick();

    expect(backupFiles()).toEqual([]);
  });

  it('отмена дожидается записи, которая уже пошла', async () => {
    const gate = deferred();
    mockWriteGate = gate.promise;
    scheduleDialogBackupPersist();
    jest.advanceTimersByTime(DEBOUNCE_MS);
    flushInteractions();
    await tick();
    expect(mockWrites).toBe(1);
    expect(backupFiles()).toEqual([]);

    let finished = false;
    const cancelling = Promise.resolve(cancelScheduledDialogBackup()).then(() => {
      finished = true;
    });
    await tick(20);
    expect(finished).toBe(false);

    gate.resolve();
    await cancelling;
    expect(finished).toBe(true);
  });

  it('начатая запись заканчивается ДО удаления файлов, а не после', async () => {
    const gate = deferred();
    mockWriteGate = gate.promise;
    scheduleDialogBackupPersist();
    jest.advanceTimersByTime(DEBOUNCE_MS);
    flushInteractions();
    await tick();
    expect(mockWrites).toBe(1);

    const wipe = (async () => {
      await cancelScheduledDialogBackup();
      await deleteAllDialogBackups();
    })();

    // Диск своим чередом доводит начатое — отмене его не остановить.
    await tick(20);
    gate.resolve();
    await wipe;
    await tick();

    expect(backupFiles()).toEqual([]);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отмена, снимающая слишком много, хуже прежней: копия диалогов — это
 * последнее, к чему можно вернуться после потери базы, и выключить её навсегда
 * значит оставить следующего владельца устройства без неё. Приложение после
 * сброса поднимается в том же процессе, так что «навсегда» тут буквально.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: отмена снимает ровно отменённое', () => {
  it('отмена до срабатывания таймера по-прежнему гасит его', async () => {
    scheduleDialogBackupPersist();
    await cancelScheduledDialogBackup();
    jest.advanceTimersByTime(DEBOUNCE_MS * 3);
    flushInteractions();
    await tick();

    expect(mockWrites).toBe(0);
    expect(backupFiles()).toEqual([]);
  });

  it('ГРАНИЦА: отсрочка, заведённая после отмены, доходит до файла', async () => {
    await cancelScheduledDialogBackup();

    scheduleDialogBackupPersist();
    jest.advanceTimersByTime(DEBOUNCE_MS);
    flushInteractions();
    await tick();

    expect(backupFiles()).toEqual([URI]);
  });

  it('ГРАНИЦА: отмена без единой отсрочки никому не мешает', async () => {
    await cancelScheduledDialogBackup();
    await cancelScheduledDialogBackup();

    expect(mockWrites).toBe(0);
    expect(backupFiles()).toEqual([]);
  });

  it('ГРАНИЦА: удаление копий само по себе файл уносит', async () => {
    await exportDialogBackupToFile();
    expect(backupFiles()).toEqual([URI]);

    await deleteAllDialogBackups();
    expect(backupFiles()).toEqual([]);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Оба довода — про то, что отменять было что и что отменяемое стоило дорого.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('между таймером и записью гасить уже нечего', () => {
    scheduleDialogBackupPersist();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(DEBOUNCE_MS);

    // Таймер потрачен, запись ещё не началась — и вся отмена прежних времён
    // (clearTimeout) в этот промежуток не попадала ничем.
    expect(jest.getTimerCount()).toBe(0);
    expect(mockInteractions).toHaveLength(1);
  });

  it('без отмены отложенная запись доносит до файла всю переписку профиля', async () => {
    scheduleDialogBackupPersist();
    jest.advanceTimersByTime(DEBOUNCE_MS);
    flushInteractions();
    await tick();

    expect(backupFiles()).toEqual([URI]);
    const payload = JSON.parse(mockFiles[URI]) as {
      messages: Array<{ id: string }>;
      walletPubKeyB64: string;
    };
    expect(payload.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(payload.walletPubKeyB64).toBe(Buffer.from(new Uint8Array(32).fill(7)).toString('base64'));
  });
});

describe('форма исходников: отмена — обещание, а не слово', () => {
  it('у отсрочек есть поколение, и очередь взаимодействий его проверяет', () => {
    expect(SRC).toContain('let backupEpoch = 0;');
    expect(SRC).toContain('const epoch = backupEpoch;');
    expect(SRC).toContain('if (epoch !== backupEpoch) {');
  });

  it('отмена ждёт начатое и потому возвращает обещание', () => {
    expect(SRC).toContain('export async function cancelScheduledDialogBackup(): Promise<void> {');
    expect(SRC).not.toContain('export function cancelScheduledDialogBackup(): void {');
    expect(SRC).toContain('let inFlightExport: Promise<unknown> | null = null;');
    expect(SRC).toContain('if (running) await running.catch(() => {});');
  });

  it('сброс отменяет ещё раз — сразу за удалением файлов', () => {
    const at = WIPE.indexOf("await step('dialog_backups'");
    expect(at).toBeGreaterThan(0);
    expect(WIPE.slice(at, at + 220)).toContain(
      "await step('cancel_dialog_backup_late', () => cancelScheduledDialogBackup(), failed);",
    );
  });
});
