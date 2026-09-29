/**
 * Три шага восстановления копии перестали глушить отказ базы (v4.32.1025).
 *
 * ДЕФЕКТ. `rebuildConversationsFromMessages`, `importConversationMetaRows` и
 * `importGroupBackupRows` целиком лежали в `try`, а во внешней ловушке стояли
 * `log.warn` и `return 0` / `return none`. Внутренняя ловушка при этом честная:
 * откат транзакции и `throw`. То есть отказ доезжал ровно до последней строки
 * функции — и там превращался в число.
 *
 * ЦЕНА. Восстановление ведёт `step()` в dialogBackup (v4.32.717), и узнаёт он
 * о провале ТОЛЬКО по броску: `catch { failed.push(name) }`. Броска от этих
 * трёх не приходило никогда, поэтому в `failed` могли попасть лишь два шага из
 * пяти — `messages` и `kv`. Дальше `dialogBackupReport` видит пустой `failed`,
 * отвечает `ok: true`, и SettingsScreen печатает зелёным «Восстановлено: N
 * сообщений. Перезапустите приложение.» — в тот самый момент, когда список
 * переписок, настройки переписок и ВСЕ группы не вернулись. Повторить импорт
 * уже нельзя (`db_not_empty`), а локальный файл — единственное, чем группа
 * восстанавливается вообще. Ветка частичного импорта, написанная в v4.32.844
 * со словами «человек видел успех ровно в тот момент, когда терял группы
 * навсегда», для трёх шагов из пяти была мёртвым кодом с первого дня.
 *
 * ПРАВКА. Журнальная строка остаётся — по ней ищут причину, — следом `throw e`.
 * Та же форма, что у пяти писателей диалога в v4.32.838.
 *
 * ГРАНИЦЫ. Законный ноль остаётся нулём: пустая копия, копия без настроек
 * переписок, база без сообщений — всё это по-прежнему тихий `0`, а не отказ.
 * Второй вызывающий, живая синхронизация, своего поведения не меняет: там
 * перестроение списка — проекция после переноса, и её отказ не имеет права
 * откатить курсор захода, поэтому он подавлен на месте вызова и назван вслух.
 */
import fs from 'fs';
import path from 'path';

type Run = { changes: number; lastInsertRowId: number };

/** Отказ чтения сообщений — того самого SELECT, по которому строится список. */
let mockReadMessagesFails = false;
/** Отказ записи в conversations. */
let mockConvWriteFails = false;
/** Отказ записи в groups. */
let mockGroupWriteFails = false;
/** Что лежит в chat_messages. */
let mockMessages: { contact_pub_b64: string; last_at: number; text: string; direction: string }[] = [];

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string): Promise<Run> => {
      const s = norm(sql);
      if (/INTO conversations|UPDATE conversations/.test(s) && mockConvWriteFails) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      if (/INTO groups /.test(s) && mockGroupWriteFails) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async (sql: string) => {
      if (/FROM chat_messages m/.test(norm(sql))) {
        if (mockReadMessagesFails) throw new Error('SQLITE_BUSY: database is locked');
        return mockMessages;
      }
      return [];
    }),
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
  encryptAtRestIfPlain: jest.fn((v: string | null) => v),
  decryptAtRestString: jest.fn((v: string) => v),
  decryptAtRestNullable: jest.fn((v: string | null) => v),
  isAtRestCiphertext: jest.fn(() => false),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import {
  importConversationMetaRows,
  importGroupBackupRows,
  kvDelete,
  rebuildConversationsFromMessages,
} from '../local';
import { dialogBackupReport, type DialogBackupStep } from '../dialogBackupReport';

const PID = 1;
const PEER = 'A'.repeat(43);

/** Строка настроек переписки, какой её пропускает sanitizeConversationMetaRows. */
const metaRow = {
  contact_pub_b64: PEER,
  unread_count: 3,
  draft_text: null,
  pinned: 1,
  archived: 0,
  muted: 0,
  muted_until: null,
  pinned_message_id: null,
  disappear_after_ms: null,
  disappear_set_at: null,
  color_tag: null,
};

/** Строка группы, какой её пропускает sanitizeGroupRows. */
const groupRow = {
  id: 'g1',
  name: 'enc2:zzz',
  description: null,
  avatar_cid: null,
  type: 'group',
  invite_token: null,
  username: null,
  is_admin: 1,
  member_count: 3,
  unread_count: 0,
  mention_count: 0,
  muted: 0,
  muted_until: null,
  pinned: 0,
  archived: 0,
  last_message_at: 1_700_000_000_000,
  last_message_preview: 'enc2:pre',
  last_message_sender_name: 'enc2:name',
  last_message_sender_pub: PEER,
  pinned_message_id: null,
  pinned_message_text: null,
  draft_text: null,
  disappear_after_ms: null,
  disappear_set_at: null,
  slow_mode_seconds: 0,
  admin_only_posting: 0,
  admin_only_pinning: 1,
  anonymous_posting: 0,
  require_approval: 0,
  created_at: 1_699_000_000_000,
};

/** База поднимается лениво; открываем её до того, как включён отказ. */
beforeAll(async () => {
  await kvDelete('warmup');
});

beforeEach(() => {
  mockReadMessagesFails = false;
  mockConvWriteFails = false;
  mockGroupWriteFails = false;
  mockMessages = [
    { contact_pub_b64: PEER, last_at: 1_700_000_000_000, text: 'привет', direction: 'in' },
  ];
});

describe('отказ базы доходит до того, кто собирает отчёт', () => {
  it('список переписок не перестроился — это не «появилось 0 переписок»', async () => {
    mockReadMessagesFails = true;
    await expect(rebuildConversationsFromMessages(PID)).rejects.toThrow('SQLITE_BUSY');
  });

  it('настройки переписок не легли — это не «вернулось 0 настроек»', async () => {
    mockConvWriteFails = true;
    await expect(importConversationMetaRows([metaRow], PID)).rejects.toThrow('SQLITE_BUSY');
  });

  it('группы не легли — это не «вернулось 0 групп»', async () => {
    mockGroupWriteFails = true;
    await expect(
      importGroupBackupRows({ groups: [groupRow], messages: [], members: [] }, PID),
    ).rejects.toThrow('SQLITE_BUSY');
  });
});

describe('цена дефекта: зелёный «Восстановлено» поверх потерянных групп', () => {
  /** Точно тот же состав, что у step() в dialogBackup.ts. */
  const step = async (
    name: DialogBackupStep,
    failed: DialogBackupStep[],
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch {
      failed.push(name);
    }
  };

  const runImport = async (): Promise<DialogBackupStep[]> => {
    const failed: DialogBackupStep[] = [];
    await step('conversations', failed, async () => {
      await rebuildConversationsFromMessages(PID);
    });
    await step('meta', failed, async () => {
      await importConversationMetaRows([metaRow], PID);
    });
    await step('groups', failed, async () => {
      await importGroupBackupRows({ groups: [groupRow], messages: [], members: [] }, PID);
    });
    return failed;
  };

  it('три упавших шага названы в отчёте, а не пропущены', async () => {
    mockReadMessagesFails = true;
    mockConvWriteFails = true;
    mockGroupWriteFails = true;

    expect(await runImport()).toEqual(['conversations', 'meta', 'groups']);
  });

  it('человек читает про потерю, а не «Перезапустите приложение»', async () => {
    mockReadMessagesFails = true;
    mockConvWriteFails = true;
    mockGroupWriteFails = true;
    const failed = await runImport();

    const said = dialogBackupReport({ messages: 7, groups: 0, failed, refused: null });
    expect(said.ok).toBe(false);
    expect(said.text).toContain('Не восстановлено: список переписок, настройки переписок, группы');
    expect(said.text).toContain('сохраните файл копии');
    expect(said.text).not.toContain('Перезапустите приложение');
  });

  it('упала только часть — остальные шаги всё равно выполняются', async () => {
    mockGroupWriteFails = true;

    expect(await runImport()).toEqual(['groups']);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: целая база работает как работала', () => {
  it('список переписок перестраивается и считается', async () => {
    await expect(rebuildConversationsFromMessages(PID)).resolves.toBe(1);
  });

  it('настройки переписок возвращаются и считаются', async () => {
    await expect(importConversationMetaRows([metaRow], PID)).resolves.toBe(1);
  });

  it('группы возвращаются и считаются', async () => {
    await expect(
      importGroupBackupRows({ groups: [groupRow], messages: [], members: [] }, PID),
    ).resolves.toEqual({ groups: 1, messages: 0, members: 0 });
  });

  it('целый импорт отчитывается успехом — ветка отказа не срабатывает вхолостую', async () => {
    const said = dialogBackupReport({ messages: 7, groups: 1, failed: [], refused: null });
    expect(said.ok).toBe(true);
    expect(said.text).toBe('Восстановлено: 7 сообщений, 1 группа. Перезапустите приложение.');
  });
});

describe('ГРАНИЦА: законный ноль остаётся нулём', () => {
  it('сообщений нет — переписок не появилось, и это не отказ', async () => {
    mockMessages = [];
    await expect(rebuildConversationsFromMessages(PID)).resolves.toBe(0);
  });

  it('настроек переписок в копии нет — тихий ноль', async () => {
    await expect(importConversationMetaRows([], PID)).resolves.toBe(0);
  });

  it('групп в копии нет — тихий ноль', async () => {
    await expect(
      importGroupBackupRows({ groups: [], messages: [], members: [] }, PID),
    ).resolves.toEqual({ groups: 0, messages: 0, members: 0 });
  });

  it('негодная строка отбрасывается как прежде, без броска', async () => {
    await expect(importConversationMetaRows([{ contact_pub_b64: 'не ключ' }], PID)).resolves.toBe(0);
  });
});

const read = (...p: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...p), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const LOCAL = codeOnly(read('core', 'storage', 'local.ts'));
const BACKUP = codeOnly(read('core', 'storage', 'dialogBackup.ts'));
const REPORT = codeOnly(read('core', 'storage', 'dialogBackupReport.ts'));
const LIVE = codeOnly(read('core', 'sync', 'liveAccountSync.ts'));
const SETTINGS = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('step() узнаёт о провале только по броску', () => {
    const at = BACKUP.indexOf('const step = async (name: DialogBackupStep');
    expect(at).toBeGreaterThan(0);
    const body = BACKUP.slice(at, at + 400);
    expect(body).toContain('await run();');
    expect(body).toContain('failed.push(name);');
  });

  it('все три шага обёрнуты step() — без него отказ некуда записать', () => {
    for (const s of [
      "await step('conversations', async () => {",
      "await step('meta', async () => {",
      "await step('groups', async () => {",
    ]) {
      expect(BACKUP).toContain(s);
    }
  });

  it('отчёт умеет называть упавшие шаги, и у трёх из них есть имена', () => {
    expect(REPORT).toContain('if (r.failed.length > 0) {');
    expect(REPORT).toContain("conversations: 'список переписок',");
    expect(REPORT).toContain("meta: 'настройки переписок',");
    expect(REPORT).toContain("groups: 'группы',");
  });

  it('экран печатает именно эту фразу — и не всплывашкой, когда шаги упали', () => {
    const at = SETTINGS.indexOf('const said = dialogBackupReport(outcome);');
    expect(at).toBeGreaterThan(0);
    const body = SETTINGS.slice(at, at + 500);
    expect(body).toContain('if (said.ok) {');
    expect(body).toContain('showSuccess(said.text);');
    // Частичный импорт — единственная ветка с Alert: подсказка гаснет сама,
    // а файл копии надо сохранить прямо сейчас.
    expect(body).toContain("Alert.alert('История восстановлена не полностью', said.text);");
  });

  it('внутренняя ловушка честна и до правки: откат и бросок', () => {
    for (const head of [
      'export async function rebuildConversationsFromMessages(',
      'export async function importConversationMetaRows(',
      'export async function importGroupBackupRows(',
    ]) {
      const at = LOCAL.indexOf(head);
      expect(at).toBeGreaterThan(0);
      const body = LOCAL.slice(at, LOCAL.indexOf('\n}', at));
      expect(body).toContain('await txn.rollback();');
    }
  });
});

describe('ЗАКРЕПКА: ни один из трёх шагов не отвечает на отказ числом', () => {
  it('журнальная строка остаётся, а следом идёт бросок', () => {
    for (const tag of [
      'conversations_rebuild_failed',
      'conversation_meta_import_failed',
      'group_backup_import_failed',
    ]) {
      const at = LOCAL.indexOf(`log.warn('${tag}'`);
      expect(at).toBeGreaterThan(0);
      const tail = LOCAL.slice(at, at + 200);
      expect(tail).toContain('throw e;');
      expect(tail).not.toContain('return 0;');
      expect(tail).not.toContain('return none;');
    }
  });

  it('живая синхронизация подавляет отказ перестроения у себя и говорит об этом', () => {
    const at = LIVE.indexOf('afterProjection: async () => {');
    expect(at).toBeGreaterThan(0);
    const body = LIVE.slice(at, LIVE.indexOf('albumsChanged', at));
    expect(body).toContain('await rebuildConversationsFromMessages(ownerProfileId);');
    expect(body).toContain("log.warn('live_sync_conversations_rebuild_failed'");
  });
});
