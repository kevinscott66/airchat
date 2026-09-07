/**
 * Группа, пришедшая живой синхронизацией, обязана лечь поверх (v4.32.619).
 *
 * Дефект. Ветка `case 'group'` в liveAccountSync звала `importGroupBackupRows`
 * — помощника ВОССТАНОВЛЕНИЯ из файла. Тот кладёт группы через
 * `INSERT OR IGNORE`, и для копии это верно: «то, что на устройстве, новее
 * того, что в архиве». На пути синхронизации то же правило означает обратное.
 *
 * Устройство B получало группу от A, не применяло НИЧЕГО — и всё равно
 * записывало голову сущности по присланному отпечатку. Следующий же
 * `collectPending` на B видел, что его собственная строка с головой не
 * сходится, и отправлял свою, устаревшую, с revision+1. A получал её, тоже
 * ничего не применял, тоже записывал голову — и отправлял свою обратно. Пара
 * устройств гоняла одну группу по кругу вечно: по мутации на круг в счёт
 * квоты аккаунта, а название, описание, закреплённое сообщение и настройки
 * не сходились никогда.
 *
 * Срабатывало это почти на каждой группе: в строке едут ещё и unread_count,
 * mention_count, draft_text, last_message_at — они у двух устройств
 * расходятся сами собой, без всякого редактирования.
 *
 * `exportGroupBackupRows`/`importGroupBackupRows` при этом остаются как были:
 * у восстановления из файла своё правило, и оно правильное.
 */
const mockRuns: Array<{ sql: string; params: unknown[] }> = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      mockRuns.push({ sql, params });
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
  encryptAtRestIfPlain: jest.fn((v: string | null) =>
    v == null ? null : (v.startsWith('enc2:') ? v : `enc2:${v}`)),
  decryptAtRestString: jest.fn((v: string) => v.replace('enc2:', '')),
  decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : v.replace('enc2:', ''))),
  isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import { applySyncGroup } from '../local';
import type { GroupBackupRow } from '../groupBackup';

function row(over: Partial<GroupBackupRow> = {}): GroupBackupRow {
  return {
    id: 'g-1',
    name: 'Название с того устройства',
    description: 'описание',
    avatar_cid: 'nb:abc',
    type: 'group',
    invite_token: 'tok',
    is_admin: 1,
    member_count: 3,
    unread_count: 0,
    mention_count: 0,
    muted: 0,
    muted_until: null,
    pinned: 0,
    archived: 0,
    last_message_at: 1000,
    last_message_preview: 'привет',
    last_message_sender_name: 'Рита',
    last_message_sender_pub: 'A'.repeat(43),
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
    created_at: 900,
    ...over,
  } as GroupBackupRow;
}

const groupSql = () => mockRuns.filter((r) => /INSERT\s+(OR\s+\w+\s+)?INTO groups/i.test(r.sql));

beforeEach(() => { mockRuns.length = 0; });

describe('applySyncGroup: запись сходится, а не игнорируется', () => {
  it('строка кладётся поверх существующей', async () => {
    await applySyncGroup(row(), 1);
    const sql = groupSql();
    expect(sql).toHaveLength(1);
    // Именно этим отличается путь синхронизации от восстановления из файла.
    expect(sql[0].sql).not.toMatch(/INSERT\s+OR\s+IGNORE/i);
    expect(sql[0].sql).toMatch(/ON CONFLICT \(id, owner_profile_id\) DO UPDATE/);
  });

  it('обновляется КАЖДЫЙ столбец, кроме ключевых', async () => {
    await applySyncGroup(row(), 1);
    const sql = groupSql()[0].sql;
    // Пропущенный столбец — это поле, которое не сойдётся никогда и будет
    // гонять мутации по кругу ровно так же, как гонял весь INSERT OR IGNORE.
    const columns = [
      'name', 'description', 'avatar_cid', 'type', 'invite_token', 'is_admin',
      'member_count', 'unread_count', 'mention_count', 'muted', 'muted_until',
      'pinned', 'archived', 'last_message_at', 'last_message_preview',
      'last_message_sender_name', 'last_message_sender_pub', 'pinned_message_id',
      'pinned_message_text', 'draft_text', 'disappear_after_ms', 'disappear_set_at',
      'slow_mode_seconds', 'admin_only_posting', 'admin_only_pinning',
      'anonymous_posting', 'require_approval', 'created_at',
    ];
    const update = sql.slice(sql.indexOf('DO UPDATE'));
    for (const c of columns) {
      expect(update).toContain(`${c} = excluded.${c}`);
    }
    // Ключевые столбцы обновлять нельзя: по ним и идёт сопоставление.
    expect(update).not.toContain('id = excluded.id');
    expect(update).not.toContain('owner_profile_id = excluded.owner_profile_id');
  });

  it('текстовые столбцы уезжают в базу шифртекстом', async () => {
    await applySyncGroup(row(), 1);
    const params = groupSql()[0].params;
    expect(params).toContain('enc2:Название с того устройства');
    expect(params).toContain('enc2:описание');
    expect(params).toContain('enc2:tok');
    // Открытым текстом ничего из этого лечь не должно.
    expect(params).not.toContain('Название с того устройства');
    expect(params).not.toContain('tok');
  });

  it('пришедший шифртекст повторно не заворачивается', async () => {
    await applySyncGroup(row({ name: 'enc2:уже-зашифровано' }), 1);
    const params = groupSql()[0].params;
    expect(params).toContain('enc2:уже-зашифровано');
    expect(params).not.toContain('enc2:enc2:уже-зашифровано');
  });

  it('негодная строка отвергается, а не записывается молча', async () => {
    // Отказ обязан быть слышен: тихий пропуск означал бы, что голова сущности
    // запишется, а группы на устройстве не будет.
    await expect(applySyncGroup(row({ type: 'что-то-своё' }), 1)).rejects.toThrow();
    await expect(applySyncGroup(row({ id: '' }), 1)).rejects.toThrow();
    expect(groupSql()).toHaveLength(0);
  });

  it('чужой номер профиля отвергается', async () => {
    await expect(applySyncGroup(row(), 0)).rejects.toThrow('Invalid sync profile id');
    await expect(applySyncGroup(row(), 1.5)).rejects.toThrow('Invalid sync profile id');
    expect(groupSql()).toHaveLength(0);
  });

  it('проверка не пустая: годная строка доходит до базы с нужным профилем', async () => {
    await applySyncGroup(row(), 2);
    const { params } = groupSql()[0];
    expect(params[0]).toBe('g-1');
    expect(params[1]).toBe(2);
  });
});
