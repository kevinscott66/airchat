/**
 * Импорт копии диалогов перестал сводить десять исходов к одной фразе (v4.32.844).
 *
 * Дефект. `importDialogBackupJson` отвечал числом восстановленных сообщений, и
 * всё, кроме удачи, было нулём. Нулём отвечали: нет кошелька; база не ответила;
 * история не пуста; файл больше 80 МБ; файл не разбирается; файл не той формы
 * (дважды); копия от другого аккаунта; шесть разных превышений по числу строк.
 * Экран настроек на любой из них печатал одно:
 *
 *   «Копия не импортирована: проверьте секретные слова и убедитесь, что
 *    история на этом устройстве пуста.»
 *
 * Из десяти случаев это правда в двух. В остальных совет уводит от причины:
 * слова верные, история пуста, а не вышло совсем по другому поводу — и человек
 * перебирает seed-фразу вместо того, чтобы перезапустить приложение или взять
 * неповреждённый файл.
 *
 * Цена. Хуже отказа читался успех. Шаги импорта идут порознь (v4.32.717), и
 * сбой одного не отменяет остальные — но список упавших уходил только в журнал
 * (`dialog_backup_import_partial`), а человеку показывали «Восстановлено
 * сообщений: N». Между тем повторить импорт в эту историю уже нельзя:
 * `existing > 0` его не пустит. А локальный файл — единственное, чем группа
 * восстанавливается вообще: в сети её нет. То есть экран рапортовал успех ровно
 * в ту минуту, когда группы терялись навсегда, и человек спокойно удалял файл.
 *
 * Правка. Импорт отвечает разбором: что восстановлено, какие шаги не прошли и
 * почему отказано. Слова живут отдельным модулем — без базы и файловой системы.
 */

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { UTF8: 'utf8' },
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  readAsStringAsync: jest.fn(async () => ''),
  writeAsStringAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
}));
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
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { reloadBlocked: jest.fn(async () => {}) },
}));

/** Сколько строк в базе: `null` — база не ответила. */
let mockExistingMessages: number | null = 0;
let mockImportedMessages = 0;
let mockGroupsResult: { groups: number; messages: number; members: number } = {
  groups: 0,
  messages: 0,
  members: 0,
};
/** Шаги, которым велено сорваться: ровно так они и падают на устройстве. */
let mockThrowIn = new Set<string>();
const maybeThrow = (name: string): void => {
  if (mockThrowIn.has(name)) throw new Error(`${name} failed`);
};

jest.mock('../local', () => ({
  countChatMessages: jest.fn(async () => mockExistingMessages),
  exportConversationMetaRows: jest.fn(async () => []),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => []),
  importConversationMetaRows: jest.fn(async () => {
    maybeThrow('meta');
    return 0;
  }),
  importDialogKvSnapshot: jest.fn(async () => {
    maybeThrow('kv');
    return 0;
  }),
  importGroupBackupRows: jest.fn(async () => {
    maybeThrow('groups');
    return mockGroupsResult;
  }),
  importRawChatMessageRows: jest.fn(async () => {
    maybeThrow('messages');
    return mockImportedMessages;
  }),
  rebuildConversationsFromMessages: jest.fn(async () => {
    maybeThrow('conversations');
    return 0;
  }),
}));

import fs from 'fs';
import path from 'path';

import { RAW_CHAT_MESSAGE_MAX_ROWS } from '../chatMessageBackup';
import { importDialogBackupJson, tryRestoreDialogBackupFromFile } from '../dialogBackup';
import {
  DIALOG_BACKUP_NOTHING,
  dialogBackupRefused,
  dialogBackupReport,
  type DialogBackupImportResult,
} from '../dialogBackupReport';

/** Тот же ключ, что выдаёт фейк deriveKeyPairFromMnemonicForProfile. */
const WALLET_PUB = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

const file = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, walletPubKeyB64: WALLET_PUB, messages: [], ...extra });

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

beforeEach(() => {
  mockMnemonic = 'test mnemonic phrase';
  mockExistingMessages = 0;
  mockImportedMessages = 0;
  mockGroupsResult = { groups: 0, messages: 0, members: 0 };
  mockThrowIn = new Set<string>();
});

describe('у каждого отказа своя причина', () => {
  it('база не ответила — это не «история не пуста»', async () => {
    mockExistingMessages = null;
    const r = await importDialogBackupJson(file());
    // ПРОВЕРКА НЕ ПУСТАЯ: причина названа, и названа своя.
    expect(r.refused).toBe('db_unreadable');
    expect(r.messages).toBe(0);

    mockExistingMessages = 12;
    expect((await importDialogBackupJson(file())).refused).toBe('db_not_empty');
  });

  it('нет кошелька — сверять копию не с чем, и сказано именно это', async () => {
    mockMnemonic = null;
    expect((await importDialogBackupJson(file())).refused).toBe('no_wallet');
  });

  it('повреждённый файл отличают от файла чужой формы', async () => {
    expect((await importDialogBackupJson('не json вовсе')).refused).toBe('bad_json');
    expect((await importDialogBackupJson('null')).refused).toBe('bad_format');
    expect((await importDialogBackupJson('[1,2,3]')).refused).toBe('bad_format');
    expect((await importDialogBackupJson(JSON.stringify({ v: 2 }))).refused).toBe('bad_format');
  });

  it('копия от другого аккаунта — и вот тут про секретные слова правда', async () => {
    const r = await importDialogBackupJson(file({ walletPubKeyB64: 'ZHJ1Z29q' }));
    expect(r.refused).toBe('wallet_mismatch');
    expect(dialogBackupReport(r).text).toContain('секретные слова');
    // А на отказе базы — не про слова: они ни при чём.
    expect(dialogBackupReport(dialogBackupRefused('db_unreadable')).text).not.toContain(
      'секретные слова',
    );
  });

  it('слишком много строк — отдельная причина, а не «проверьте слова»', async () => {
    const many = new Array(RAW_CHAT_MESSAGE_MAX_ROWS + 1).fill(0);
    const r = await importDialogBackupJson(file({ messages: many }));
    expect(r.refused).toBe('rows_oversize');
    expect(dialogBackupReport(r).text).not.toContain('секретные слова');
    expect(dialogBackupReport(r).text).not.toContain('пуста');
  });

  it('все восемь причин звучат по-разному и ни одна не пуста', () => {
    const said = (
      [
        'no_wallet',
        'db_unreadable',
        'db_not_empty',
        'file_oversize',
        'bad_json',
        'bad_format',
        'wallet_mismatch',
        'rows_oversize',
      ] as const
    ).map((c) => dialogBackupReport(dialogBackupRefused(c)));
    for (const s of said) {
      expect(s.ok).toBe(false);
      expect(s.text.length).toBeGreaterThan(20);
    }
    expect(new Set(said.map((s) => s.text)).size).toBe(8);
  });
});

describe('частичный импорт больше не выдаётся за успех', () => {
  it('группы не восстановились — об этом говорят, и говорят словом «группы»', async () => {
    mockThrowIn = new Set(['groups']);
    mockImportedMessages = 120;
    const r = await importDialogBackupJson(file({ groups: [{ id: 'g1' }] }));
    expect(r.refused).toBeNull();
    expect(r.messages).toBe(120);
    expect(r.failed).toEqual(['groups']);

    const said = dialogBackupReport(r);
    // Успехом это не считается: повторить импорт уже не дадут.
    expect(said.ok).toBe(false);
    expect(said.text).toContain('120 сообщений');
    expect(said.text).toContain('Не восстановлено: группы');
    expect(said.text).toContain('Повторить импорт в эту же историю уже нельзя');
  });

  it('упало несколько шагов — перечислены все', async () => {
    mockThrowIn = new Set(['kv', 'meta']);
    mockImportedMessages = 3;
    const r = await importDialogBackupJson(
      file({ kv: [{ k: 'a', v: 'b' }], conversations: [{ peer: 'p' }] }),
    );
    expect(r.failed).toEqual(['kv', 'meta']);
    const text = dialogBackupReport(r).text;
    expect(text).toContain('контакты и настройки');
    expect(text).toContain('настройки переписок');
  });

  it('сбой первого шага не отменяет остальные и виден наружу', async () => {
    mockThrowIn = new Set(['messages']);
    mockGroupsResult = { groups: 2, messages: 7, members: 4 };
    const r = await importDialogBackupJson(file({ groups: [{ id: 'g1' }, { id: 'g2' }] }));
    expect(r.failed).toEqual(['messages']);
    expect(r.groups).toBe(2);
    expect(r.messages).toBe(7);
    const text = dialogBackupReport(r).text;
    expect(text).toContain('2 группы');
    expect(text).toContain('Не восстановлено: сообщения');
  });

  it('всё прошло — успех, и он выглядит успехом', async () => {
    mockImportedMessages = 5;
    mockGroupsResult = { groups: 1, messages: 2, members: 3 };
    const r = await importDialogBackupJson(file({ groups: [{ id: 'g1' }] }));
    expect(r.failed).toEqual([]);
    const said = dialogBackupReport(r);
    expect(said.ok).toBe(true);
    expect(said.text).toBe('Восстановлено: 7 сообщений, 1 группа. Перезапустите приложение.');
  });

  it('копия пустая — это не отказ, и про секретные слова тут молчат', async () => {
    const said = dialogBackupReport(await importDialogBackupJson(file()));
    expect(said.ok).toBe(true);
    expect(said.text).toContain('нечего');
    expect(said.text).not.toContain('секретные слова');
  });

  it('числа склоняются', () => {
    const r = (messages: number, groups: number): DialogBackupImportResult => ({
      ...DIALOG_BACKUP_NOTHING,
      messages,
      groups,
    });
    expect(dialogBackupReport(r(1, 0)).text).toContain('1 сообщение.');
    expect(dialogBackupReport(r(2, 0)).text).toContain('2 сообщения');
    expect(dialogBackupReport(r(11, 0)).text).toContain('11 сообщений');
    expect(dialogBackupReport(r(21, 0)).text).toContain('21 сообщение');
    expect(dialogBackupReport(r(0, 5)).text).toContain('5 групп');
    expect(dialogBackupReport(r(0, 12)).text).toContain('12 групп');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('прежний ответ не различал ни один из десяти исходов', () => {
    // Всё, кроме удачи, было нулём — и вызывающему не из чего было выбрать слова.
    const oldAnswer = (outcome: string): number => (outcome === 'ok' ? 5 : 0);
    const outcomes = [
      'no_wallet',
      'db_unreadable',
      'db_not_empty',
      'file_oversize',
      'bad_json',
      'bad_format_null',
      'bad_format_v',
      'wallet_mismatch',
      'rows_oversize',
      'partial',
    ];
    expect(new Set(outcomes.map(oldAnswer)).size).toBe(1);
    // А теперь у каждого свой ответ.
    expect(dialogBackupReport(dialogBackupRefused('db_unreadable')).text).not.toBe(
      dialogBackupReport(dialogBackupRefused('db_not_empty')).text,
    );
  });

  it('прежняя фраза экрана советовала не то в восьми случаях из десяти', () => {
    const oldText =
      'Копия не импортирована: проверьте секретные слова и убедитесь, что история на этом устройстве пуста.';
    expect(oldText).toContain('секретные слова');
    // Про слова говорят только там, где слова и правда виноваты.
    const aboutWords = (
      ['no_wallet', 'db_unreadable', 'db_not_empty', 'bad_json', 'rows_oversize'] as const
    ).filter((c) => dialogBackupReport(dialogBackupRefused(c)).text.includes('секретные слова'));
    expect(aboutWords).toEqual(['no_wallet']);
    // И самой фразы в приложении больше нет.
    expect(read('ui', 'screens', 'SettingsScreen.tsx')).not.toContain(oldText);
  });

  it('прежний успех молчал о том, что часть шагов упала', async () => {
    mockThrowIn = new Set(['groups']);
    mockImportedMessages = 120;
    const r = await importDialogBackupJson(file({ groups: [{ id: 'g1' }] }));
    // Столько же, сколько возвращалось раньше — и раньше этим всё и кончалось.
    expect(r.messages).toBe(120);
    const oldSuccess = `Восстановлено сообщений: ${r.messages}. Перезапустите приложение.`;
    expect(oldSuccess).not.toContain('групп');
    // Новый текст об этом говорит — и не зовёт перезапуститься, будто всё хорошо.
    expect(dialogBackupReport(r).text).toContain('группы');
    expect(dialogBackupReport(r).ok).toBe(false);
  });
});

describe('форма исходников', () => {
  const BACKUP = codeOnly(read('core', 'storage', 'dialogBackup.ts'));
  const SCREEN = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));

  it('импорт отвечает разбором, а не числом', () => {
    expect(BACKUP).toContain(
      'export async function importDialogBackupJson(raw: string): Promise<DialogBackupImportResult> {',
    );
    // Ни одного немого нуля в отказах не осталось.
    const body = BACKUP.slice(
      BACKUP.indexOf('export async function importDialogBackupJson'),
      BACKUP.indexOf('export async function tryRestoreDialogBackupFromFile'),
    );
    expect(body).not.toContain('return 0;');
    for (const c of ['no_wallet', 'db_unreadable', 'db_not_empty', 'file_oversize', 'bad_json', 'bad_format', 'wallet_mismatch', 'rows_oversize']) {
      expect(body).toContain(`dialogBackupRefused('${c}')`);
    }
    // Шесть превышений по числу строк — одна причина на всех, но не «ноль».
    expect(body.split("dialogBackupRefused('rows_oversize')").length - 1).toBe(6);
  });

  it('список упавших шагов доезжает до вызывающего, а не только до журнала', () => {
    expect(BACKUP).toContain('const failed: DialogBackupStep[] = [];');
    expect(BACKUP).toContain("log.warn('dialog_backup_import_partial'");
    expect(BACKUP).toContain('      failed,');
  });

  it('автовосстановление после seed-фразы работает по-прежнему числом', async () => {
    // У него нет экрана, кому показывать разбор, и его вызывающие не менялись.
    expect(BACKUP).toContain('export async function tryRestoreDialogBackupFromFile(): Promise<number> {');
    expect(BACKUP).toContain('return (await importDialogBackupJson(raw)).messages;');
    await expect(tryRestoreDialogBackupFromFile()).resolves.toBe(0);
  });

  it('экран настроек показывает разбор, а частичный импорт — с остановкой', () => {
    expect(SCREEN).toContain(
      "import { dialogBackupReport } from '../../core/storage/dialogBackupReport';",
    );
    expect(SCREEN).toContain('const said = dialogBackupReport(outcome);');
    // Всплывающей подсказки на потерю групп мало: её можно не заметить.
    expect(SCREEN).toContain("Alert.alert('История восстановлена не полностью', said.text);");
  });

  it('слова живут отдельно от базы и файловой системы', () => {
    const mod = codeOnly(read('core', 'storage', 'dialogBackupReport.ts'));
    const imports = mod.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { ruPlural } from '../text/ruPlural';"]);
    expect(mod).toContain('export function dialogBackupReport(');
  });
});
