/**
 * Вечный отказ отправки больше не крутит двадцать полных выгрузок (v4.32.617).
 *
 * Голову отвергнутой записи проход не сохраняет — и правильно. Но из-за этого
 * следующий проход собирает ровно ту же запись, сервер отвергает её ровно так
 * же, и так все двадцать проходов. Каждый проход — полная выгрузка всей
 * местной базы: переписка, диалоги, настройки, группы, лента, альбомы. При
 * каждом заходе, навсегда.
 */
import type { SyncPushResponse, SyncPullResponse } from '../syncProtocol';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let mockPasses = 0;
/** Что сервер отвечает на отправку в проходе с этим номером (с нуля). */
let mockPush: (pass: number) => SyncPushResponse = () => ({
  serverEpoch: 'e', acceptedMutationIds: [], rejectedMutationIds: [], nextCursor: null,
});
let mockPull: SyncPullResponse = {
  serverEpoch: 'e', nextCursor: null, hasMore: false, mutations: [],
};

jest.mock('../accountSync', () => ({
  syncAccountOnce: jest.fn(async () => {
    const pushed = mockPush(mockPasses);
    mockPasses += 1;
    return { status: 'synced', pushed, pulled: mockPull };
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
  exportRawChatMessageRows: jest.fn(async () => []),
  getSyncEntityHeads: jest.fn(async () => []),
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

import { syncActiveAccount } from '../liveAccountSync';

const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) };

const rejecting = (ids: string[]): SyncPushResponse => ({
  serverEpoch: 'e', acceptedMutationIds: [], rejectedMutationIds: ids, nextCursor: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPasses = 0;
  mockPull = { serverEpoch: 'e', nextCursor: null, hasMore: false, mutations: [] };
});

it('тот же отказ во второй раз — проходы прекращаются', async () => {
  mockPush = () => rejecting(['m-1']);
  await syncActiveAccount(MNEMONIC, pair, 1);
  // Первый проход запоминает набор, второй видит тот же самый и выходит.
  expect(mockPasses).toBe(2);
});

it('порядок в списке отказов роли не играет', async () => {
  // Сервер вправе перечислить те же записи иначе; «топчемся на месте» — это
  // про набор, а не про порядок.
  mockPush = (pass) => rejecting(pass === 0 ? ['m-1', 'm-2'] : ['m-2', 'm-1']);
  await syncActiveAccount(MNEMONIC, pair, 1);
  expect(mockPasses).toBe(2);
});

it('проверка не пустая: пока что-то принимается, проходы продолжаются', async () => {
  // Отказ вместе с приёмом — это движение: головы принятых сохранены, и
  // следующий проход соберёт уже другое.
  mockPush = (pass) => (pass < 4
    ? { serverEpoch: 'e', acceptedMutationIds: [`ok-${pass}`], rejectedMutationIds: ['m-1'], nextCursor: null }
    : { serverEpoch: 'e', acceptedMutationIds: [], rejectedMutationIds: [], nextCursor: null });
  await syncActiveAccount(MNEMONIC, pair, 1);
  expect(mockPasses).toBe(5);
});

it('проверка не пустая: другой набор отказов — это движение', async () => {
  mockPush = (pass) => (pass < 3
    ? rejecting([`m-${pass}`])
    : { serverEpoch: 'e', acceptedMutationIds: [], rejectedMutationIds: [], nextCursor: null });
  await syncActiveAccount(MNEMONIC, pair, 1);
  expect(mockPasses).toBe(4);
});

it('входящее продолжает тянуться, даже когда отправка встала', async () => {
  mockPush = () => rejecting(['m-1']);
  let pulls = 0;
  Object.defineProperty(mockPull, 'hasMore', {
    get: () => {
      pulls += 1;
      return pulls < 3;
    },
  });
  await syncActiveAccount(MNEMONIC, pair, 1);
  expect(mockPasses).toBeGreaterThan(2);
  expect(mockPasses).toBeLessThan(20);
});
