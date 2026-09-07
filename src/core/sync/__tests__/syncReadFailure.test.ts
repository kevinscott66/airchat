/**
 * Сорванное чтение базы — не «пользователь всё удалил» (v4.32.616).
 *
 * Четыре выгрузки из local.ts перехватывали ошибку чтения и отдавали пустой
 * список. Пустой список — утверждение, и отправка ему верила: строки нет
 * среди текущих, а голова с прошлого прохода есть — значит удалили, выписать
 * надгробие. Одна временная ошибка SQLite (база занята, сбой ввода-вывода,
 * битая страница одной таблицы) превращалась в надгробие КАЖДОМУ сообщению,
 * и другие устройства честно стирали переписку насовсем.
 *
 * Тот же перехват портил и резервную копию: пустой файл записывался поверх
 * целого.
 *
 * Набор поведенческий: выгрузка срывается по-настоящему, проверяется, что
 * наверх не ушло ничего.
 */
import type { SyncMutation } from '../syncProtocol';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let mockPushed: SyncMutation[] = [];
let mockSyncCalls = 0;
let mockHeads: unknown[] = [];
let mockMessages: unknown[] = [];
let mockMessagesFail = false;

jest.mock('../accountSync', () => ({
  syncAccountOnce: jest.fn(async (options: { pendingMutations?: SyncMutation[] }) => {
    mockSyncCalls += 1;
    mockPushed = options.pendingMutations ?? [];
    return {
      status: 'synced',
      pushed: null,
      pulled: { mutations: [], hasMore: false, nextCursor: null, serverEpoch: 'e' },
    };
  }),
}));

jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({ cloudBackup: { enabled: true } })),
}));

jest.mock('../../storage/local', () => ({
  applySyncGroupMember: jest.fn(async () => undefined),
  applySyncGroupMessage: jest.fn(async () => undefined),
  deleteSyncEntity: jest.fn(async () => undefined),
  exportConversationSyncRows: jest.fn(async () => []),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportSyncProfileSettings: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => {
    if (mockMessagesFail) throw new Error('database is locked');
    return mockMessages;
  }),
  getSyncEntityHeads: jest.fn(async () => mockHeads),
  importConversationMetaRows: jest.fn(async () => undefined),
  importDialogKvSnapshot: jest.fn(async () => undefined),
  importSyncProfileSetting: jest.fn(async () => true),
  importGroupBackupRows: jest.fn(async () => undefined),
  importRawChatMessageRows: jest.fn(async () => 1),
  rebuildConversationsFromMessages: jest.fn(async () => undefined),
  saveSyncEntityHeads: jest.fn(async () => undefined),
}));

jest.mock('../../social/storyAlbumSync', () => ({
  applySyncStoryAlbum: jest.fn(async () => undefined),
  applySyncStoryAlbumDelete: jest.fn(async () => undefined),
  applySyncStoryAlbumItem: jest.fn(async () => undefined),
  applySyncStoryAlbumItemDelete: jest.fn(async () => undefined),
  exportStoryAlbumSyncSnapshot: jest.fn(async () => ({ albums: [], items: [] })),
}));

jest.mock('../../social/feedService', () => ({
  applyFeedSyncComment: jest.fn(async () => undefined),
  applyFeedSyncCommentDelete: jest.fn(async () => undefined),
  applyFeedSyncPost: jest.fn(async () => undefined),
  applyFeedSyncPostDelete: jest.fn(async () => undefined),
  exportFeedSyncSnapshot: jest.fn(async () => ({ posts: [], comments: [], commentTombstones: [] })),
}));

import * as fs from 'fs';
import * as path from 'path';

import { saveSyncEntityHeads } from '../../storage/local';
import { syncActiveAccount } from '../liveAccountSync';

const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) };
const saveHeads = saveSyncEntityHeads as jest.MockedFunction<typeof saveSyncEntityHeads>;

const HEAD = {
  entityKind: 'message', entityId: 'msg-1', ownerProfileId: 1,
  revision: 3, fingerprint: 'f', deleted: false, updatedAt: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPushed = [];
  mockSyncCalls = 0;
  mockHeads = [];
  mockMessages = [];
  mockMessagesFail = false;
});

describe('сорванное чтение не выписывает надгробий', () => {
  it('проверка не пустая: исчезнувшая строка надгробие получает', async () => {
    mockHeads = [HEAD];
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(mockPushed).toHaveLength(1);
    expect(mockPushed[0].deleted).toBe(true);
  });

  it('ошибка чтения обрывает проход, а не удаляет переписку', async () => {
    mockHeads = [HEAD];
    mockMessagesFail = true;
    // Проход обязан упасть внутрь себя: syncActiveAccount ловит и пишет в
    // журнал, наружу ошибка не выходит.
    await expect(syncActiveAccount(MNEMONIC, pair, 1)).resolves.toBeUndefined();
    expect(mockSyncCalls).toBe(0);
    expect(mockPushed).toHaveLength(0);
    // И головы не сдвинуты: следующий проход соберёт отправку заново.
    expect(saveHeads).not.toHaveBeenCalled();
  });
});

describe('выгрузки не глотают ошибку чтения', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  function bodyOf(head: string): string {
    const at = SRC.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    const end = SRC.indexOf('\n}', at);
    expect(end).toBeGreaterThan(at);
    return SRC.slice(at, end);
  }

  // Все семь выгрузок, из которых собирается отправка. Три правых никогда и
  // не перехватывали — ратчет держит все семь в одном правиле.
  const EXPORTS = [
    'export async function exportRawChatMessageRows(',
    'export async function exportConversationMetaRows(',
    'export async function exportConversationSyncRows(',
    'export async function exportDialogKvSnapshot(',
    'export async function exportGroupBackupRows(',
    'export async function exportSyncProfileSettings(',
  ];

  it.each(EXPORTS)('%s не перехватывает', (head) => {
    const body = bodyOf(head);
    // Комментарии не считаются: слово в объяснении — не перехват.
    const code = body.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/\bcatch\b/);
  });
});

describe('чужой шифротекст меряется до раскодирования', () => {
  /**
   * v4.32.617. Предел на размер сущности проверялся по УЖЕ раскодированному
   * буферу: чтобы отвергнуть заведомо негодный конверт, в память сначала
   * поднимались лишние ¾ его объёма, и сколько именно — решала чужая сторона.
   * Длина base64-строки известна сразу, и порядок проверок — единственное, чем
   * это отличается: наружу поведение то же (конверт отвергнут), поэтому
   * правило держится ратчетом.
   */
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'liveAccountSync.ts'), 'utf8');

  const bodyOfLive = (head: string): string => {
    const at = SRC.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    const end = SRC.indexOf('\n}', at);
    expect(end).toBeGreaterThan(at);
    return SRC.slice(at, end)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  };

  it('длина строки проверяется раньше, чем Buffer.from', () => {
    const body = bodyOfLive('function decryptEntity(');
    const guard = body.indexOf('MAX_SYNC_ENTITY_B64_CHARS');
    const decode = body.indexOf("Buffer.from(mutation.ciphertextB64");
    expect(guard).toBeGreaterThan(-1);
    expect(decode).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(decode);
  });

  it('проверка не пустая: предел в символах выведен из предела в байтах', () => {
    // Иначе ратчет выше удовлетворила бы любая константа с подходящим именем.
    expect(SRC).toMatch(/MAX_SYNC_ENTITY_B64_CHARS\s*=\s*Math\.ceil\(MAX_SYNC_ENTITY_BYTES \/ 3\) \* 4/);
  });
});
