/**
 * Снятая настройка — не удалённая переписка (v4.32.617).
 *
 * Синхронизация читала выгрузку резервной копии (exportConversationMetaRows), а
 * та по замыслу отдаёт только строки, где что-то настроено: остальное копия
 * восстанавливает по сообщениям. Синхронизация же трактует отсутствие иначе —
 * «строку удалили» — и выписывает надгробие, по которому
 * deleteSyncEntity('conversation') сносит строку целиком.
 *
 * Открепили единственный закреплённый чат — живая строка выпадала из выгрузки,
 * и на другом устройстве переписка исчезала из списка вместе с
 * last_message_at, last_message_preview и last_message_direction, которых в
 * выгрузке нет и которые импорт не возвращает. Сообщения при этом оставались в
 * chat_messages, а rebuildConversationsFromMessages в таком проходе не
 * вызывается: его запускает только изменение сообщений.
 *
 * Строку conversations не удаляет ни один местный путь (clearChatHistory её
 * обнуляет, а не удаляет), поэтому надгробие здесь могло быть только ложным.
 */
import type { SyncMutation } from '../syncProtocol';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let mockPushed: SyncMutation[] = [];
let mockHeads: unknown[] = [];
let mockConversations: unknown[] = [];

jest.mock('../accountSync', () => ({
  syncAccountOnce: jest.fn(async (options: { pendingMutations?: SyncMutation[] }) => {
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
  applySyncGroup: jest.fn(async () => undefined),
  applySyncGroupMember: jest.fn(async () => undefined),
  applySyncGroupMessage: jest.fn(async () => undefined),
  deleteSyncEntity: jest.fn(async () => undefined),
  exportConversationSyncRows: jest.fn(async () => mockConversations),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportSyncProfileSettings: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => []),
  getSyncEntityHeads: jest.fn(async () => mockHeads),
  importConversationMetaRows: jest.fn(async () => 1),
  importDialogKvSnapshot: jest.fn(async () => 1),
  importSyncProfileSetting: jest.fn(async () => true),
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

import { syncActiveAccount } from '../liveAccountSync';

const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) };
const PEER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const HEAD = {
  entityKind: 'conversation', entityId: PEER, ownerProfileId: 1,
  revision: 2, fingerprint: 'f', deleted: false, updatedAt: 1,
};

/** Строка, с которой сняли последнюю настройку: флагов нет, переписка есть. */
const UNPINNED = {
  contact_pub_b64: PEER,
  unread_count: 0,
  draft_text: null,
  pinned: 0,
  archived: 0,
  muted: 0,
  muted_until: null,
  pinned_message_id: null,
  disappear_after_ms: null,
  disappear_set_at: null,
  color_tag: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPushed = [];
  mockHeads = [];
  mockConversations = [];
});

describe('надгробие переписки', () => {
  it('проверка не пустая: строка вне выгрузки надгробие получает', async () => {
    mockHeads = [HEAD];
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(mockPushed).toHaveLength(1);
    expect(mockPushed[0].deleted).toBe(true);
  });

  it('строка без настроек, но в выгрузке, надгробия не получает', async () => {
    mockHeads = [HEAD];
    mockConversations = [UNPINNED];
    await syncActiveAccount(MNEMONIC, pair, 1);
    // Не «надгробия нет», а «уехало обновление»: пустая отправка тоже не
    // содержит надгробий, и проверка на одно лишь отсутствие ничего не ловит.
    expect(mockPushed).toHaveLength(1);
    expect(mockPushed[0].deleted).toBe(false);
  });
});

describe('выгрузка для синхронизации отделена от выгрузки копии', () => {
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
  const LIVE = fs.readFileSync(path.join(__dirname, '..', 'liveAccountSync.ts'), 'utf8');
  const BACKUP = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'dialogBackup.ts'), 'utf8');

  function bodyOf(src: string, head: string): string {
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', at);
    expect(end).toBeGreaterThan(at);
    // Комментарии не в счёт: слово в объяснении — не условие отбора.
    return src
      .slice(at, end)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it('выгрузка синхронизации держит строку, пока в ней есть след переписки', () => {
    expect(bodyOf(LOCAL, 'export async function exportConversationSyncRows(')).toMatch(
      /last_message_at\s*>\s*0/
    );
  });

  it('выгрузка копии осталась прежней: только там, где что-то настроено', () => {
    // Обратная сторона того же правила — иначе «разделили» превратилось бы в
    // «переименовали», и копия потолстела бы без причины.
    expect(bodyOf(LOCAL, 'export async function exportConversationMetaRows(')).not.toMatch(
      /last_message_at/
    );
  });

  it('синхронизация берёт свою выгрузку, а не выгрузку копии', () => {
    expect(LIVE).toContain('exportConversationSyncRows');
    expect(LIVE).not.toContain('exportConversationMetaRows');
  });

  it('резервная копия берёт свою', () => {
    expect(BACKUP).toContain('exportConversationMetaRows');
    expect(BACKUP).not.toContain('exportConversationSyncRows');
  });
});
