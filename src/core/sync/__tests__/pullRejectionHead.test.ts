/**
 * Отвергнутую строку нельзя записывать как применённую (v4.32.619).
 *
 * Дефект. `applyPulledMutation` разбирала пять видов сущностей, и три из них
 * ответ импорта выбрасывали: `conversation`, `setting` и `group`. А сразу
 * после разбора — безусловный `saveSyncEntityHeads` с отпечатком присланного
 * значения. То есть строку отбросила проверка (негодный ключ собеседника,
 * значение сверх предела, чужой формат) — а голова сущности всё равно
 * записывалась так, будто строка легла.
 *
 * Дальше это уже не «одна потерянная строка». Следующий `collectPending`
 * сравнивает отпечаток местной строки с головой, не находит совпадения и
 * отправляет своё — устаревшее — обратно с revision+1. Второе устройство
 * делает то же самое в обратную сторону. Пара устройств гоняет одну и ту же
 * сущность по кругу вечно, по мутации на круг в счёт квоты аккаунта, и
 * сходимости нет никогда. `message` и `profile` этот же сигнал уже
 * обрабатывали — правило теперь одно на все пять.
 *
 * Набор поведенческий: мутация проезжает весь путь применения, проверяется,
 * записана голова или нет.
 */
import type { SyncMutation } from '../syncProtocol';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let mockPulled: SyncMutation[] = [];
let mockPayload: unknown = null;
let mockConversationAccepted = 1;
let mockSettingAccepted = 1;
let mockGroupThrows = false;

jest.mock('../accountSync', () => ({
  syncAccountOnce: jest.fn(async (options: {
    pendingMutations?: SyncMutation[];
    applyMutation: (m: SyncMutation) => Promise<void>;
  }) => {
    for (const m of mockPulled) await options.applyMutation(m);
    return {
      status: 'synced',
      pushed: null,
      pulled: { mutations: mockPulled, hasMore: false, nextCursor: null, serverEpoch: 'e' },
    };
  }),
}));

// Конверт распечатывается заглушкой: предмет набора — что делают с уже
// разобранным значением, а не сама криптография (её держат свои наборы).
jest.mock('../../crypto/encrypt', () => ({
  encryptSymmetric: jest.fn(() => new Uint8Array([1])),
  decryptSymmetric: jest.fn(() => new TextEncoder().encode(JSON.stringify(mockPayload))),
}));

jest.mock('../../storage/dekDerivation', () => ({
  deriveLocalDekFromMnemonic: jest.fn(() => new Uint8Array(32)),
}));

jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({ cloudBackup: { enabled: true } })),
}));

jest.mock('../../storage/local', () => ({
  applySyncGroup: jest.fn(async () => {
    if (mockGroupThrows) throw new Error('Группа синхронизации не прошла проверку.');
  }),
  applySyncGroupMember: jest.fn(async () => undefined),
  applySyncGroupMessage: jest.fn(async () => undefined),
  deleteSyncEntity: jest.fn(async () => undefined),
  exportConversationSyncRows: jest.fn(async () => []),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportSyncProfileSettings: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => []),
  getSyncEntityHeads: jest.fn(async () => []),
  importConversationMetaRows: jest.fn(async () => mockConversationAccepted),
  importDialogKvSnapshot: jest.fn(async () => mockSettingAccepted),
  importSyncProfileSetting: jest.fn(async () => true),
  importRawChatMessageRows: jest.fn(async () => 1),
  rebuildConversationsFromMessages: jest.fn(async () => undefined),
  saveSyncEntityHeads: jest.fn(async () => undefined),
  forgetSyncEntityFingerprints: jest.fn(async () => undefined),
}));

jest.mock('../../storage/kvKeys', () => ({
  dialogKvSnapshotHasBlockList: jest.fn(() => false),
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { reloadBlocked: jest.fn(async () => undefined) },
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

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { saveSyncEntityHeads } from '../../storage/local';
import { syncActiveAccount } from '../liveAccountSync';

const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) };
const saveHeads = saveSyncEntityHeads as jest.MockedFunction<typeof saveSyncEntityHeads>;

const b64url = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mutation(entityKind: string, entityId: string): SyncMutation {
  return {
    mutationId: `m:${entityKind}:1:${b64url(entityId)}:1`,
    entityKind,
    entityId: b64url(entityId),
    ownerProfileId: 1,
    revision: 1,
    deleted: false,
    ciphertextB64: 'ZW5j',
    updatedAt: 1,
  } as SyncMutation;
}

function payload(entityKind: string, entityId: string, value: unknown) {
  return { v: 2, entityKind, entityId, ownerProfileId: 1, revision: 1, deleted: false, value };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPulled = [];
  mockPayload = null;
  mockConversationAccepted = 1;
  mockSettingAccepted = 1;
  mockGroupThrows = false;
});

describe('голова сущности пишется только после настоящего применения', () => {
  it('проверка не пустая: принятый диалог голову получает', async () => {
    mockPulled = [mutation('conversation', 'peer-1')];
    mockPayload = payload('conversation', 'peer-1', { contact_pub_b64: 'peer-1' });
    mockConversationAccepted = 1;
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(saveHeads).toHaveBeenCalled();
  });

  it('отвергнутый диалог голову не получает', async () => {
    mockPulled = [mutation('conversation', 'peer-1')];
    mockPayload = payload('conversation', 'peer-1', { contact_pub_b64: 'peer-1' });
    mockConversationAccepted = 0;
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(saveHeads).not.toHaveBeenCalled();
  });

  it('проверка не пустая: принятая настройка голову получает', async () => {
    mockPulled = [mutation('setting', 'k')];
    mockPayload = payload('setting', 'k', { k: 'k', v: '1' });
    mockSettingAccepted = 1;
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(saveHeads).toHaveBeenCalled();
  });

  it('отвергнутая настройка голову не получает', async () => {
    mockPulled = [mutation('setting', 'k')];
    mockPayload = payload('setting', 'k', { k: 'k', v: '1' });
    mockSettingAccepted = 0;
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(saveHeads).not.toHaveBeenCalled();
  });

  it('проверка не пустая: принятая группа голову получает', async () => {
    mockPulled = [mutation('group', 'g-1')];
    mockPayload = payload('group', 'g-1', { id: 'g-1' });
    mockGroupThrows = false;
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(saveHeads).toHaveBeenCalled();
  });

  it('отвергнутая группа голову не получает', async () => {
    mockPulled = [mutation('group', 'g-1')];
    mockPayload = payload('group', 'g-1', { id: 'g-1' });
    mockGroupThrows = true;
    await syncActiveAccount(MNEMONIC, pair, 1);
    expect(saveHeads).not.toHaveBeenCalled();
  });
});

describe('живая синхронизация не пользуется помощником восстановления', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const LIVE = fs.readFileSync(path.join(__dirname, '..', 'liveAccountSync.ts'), 'utf8');

  it('группа кладётся через applySyncGroup, а не importGroupBackupRows', () => {
    // importGroupBackupRows кладёт через INSERT OR IGNORE — по замыслу, для
    // копии из файла. На пути синхронизации это означало «не применять ничего».
    expect(LIVE).not.toContain('importGroupBackupRows');
    expect(LIVE).toContain('applySyncGroup(');
  });

  it('помощник восстановления при этом остался на месте', () => {
    const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
    const BACKUP = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'dialogBackup.ts'), 'utf8');
    expect(LOCAL).toContain('export async function importGroupBackupRows(');
    expect(BACKUP).toContain('importGroupBackupRows');
  });
});
