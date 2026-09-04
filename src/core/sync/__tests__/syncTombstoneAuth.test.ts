/**
 * Под удалением должна стоять подпись (v4.32.523).
 *
 * Сущности уезжали на сервер шифротекстом, и это работало: прочитать переписку
 * сервер не мог. А вот удалить — мог. Метка об удалении ехала как
 * `deleted: true, ciphertextB64: null`, то есть голым фактом, ничем не
 * подтверждённым, и клиент принимал её на слово. Кто угодно, у кого была запись
 * в базу сервера, стирал у любого аккаунта что угодно — переписку, ленту,
 * настройки — и стирал навсегда: метка разъезжалась по всем устройствам.
 *
 * Второе, из той же щели: в AAD не входили ни номер ревизии, ни признак
 * удаления. Значит, вчерашний шифротекст можно было выдать за свежую ревизию —
 * расшифровка сходилась, номер был больше локального, и клиент откатывал
 * сущность назад: разблокированным становился заблокированный контакт,
 * возвращался прежний текст отредактированного сообщения.
 *
 * Набор поведенческий и работает на НАСТОЯЩЕЙ криптографии: шифротекст для
 * проверок приёма берётся из того, что модуль сам же отправил.
 */
import type { SyncMutation } from '../syncProtocol';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let mockPulled: SyncMutation[] = [];
let mockPushed: SyncMutation[] = [];
let mockHeads: unknown[] = [];
let mockMessages: unknown[] = [];
let mockCommentTombstones: { commentId: string; postId: string; deletedAt: number }[] = [];

jest.mock('../accountSync', () => ({
  syncAccountOnce: jest.fn(async (options: {
    pendingMutations?: SyncMutation[];
    applyMutation: (m: SyncMutation) => Promise<void>;
    afterProjection?: () => Promise<void>;
  }) => {
    mockPushed = options.pendingMutations ?? [];
    for (const m of mockPulled) await options.applyMutation(m);
    if (options.afterProjection) await options.afterProjection();
    return {
      status: 'synced',
      pushed: null,
      pulled: { mutations: mockPulled, hasMore: false, nextCursor: null, serverEpoch: 'e' },
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
  exportConversationMetaRows: jest.fn(async () => []),
  exportDialogKvSnapshot: jest.fn(async () => []),
  exportSyncProfileSettings: jest.fn(async () => []),
  exportGroupBackupRows: jest.fn(async () => ({ groups: [], messages: [], members: [] })),
  exportRawChatMessageRows: jest.fn(async () => mockMessages),
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
  exportFeedSyncSnapshot: jest.fn(async () => ({
    posts: [],
    comments: [],
    commentTombstones: mockCommentTombstones,
  })),
}));

import * as fs from 'fs';
import * as path from 'path';

import { encryptSymmetric } from '../../crypto/encrypt';
import { deriveLocalDekFromMnemonic } from '../../storage/dekDerivation';
import {
  applyFeedSyncCommentDelete,
  applyFeedSyncPostDelete,
} from '../../social/feedService';
import {
  deleteSyncEntity,
  importRawChatMessageRows,
  saveSyncEntityHeads,
} from '../../storage/local';
import { syncActiveAccount } from '../liveAccountSync';

const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) };
const deleteEntity = deleteSyncEntity as jest.MockedFunction<typeof deleteSyncEntity>;
const importMessages = importRawChatMessageRows as jest.MockedFunction<typeof importRawChatMessageRows>;
const saveHeads = saveSyncEntityHeads as jest.MockedFunction<typeof saveSyncEntityHeads>;
const deleteComment = applyFeedSyncCommentDelete as jest.MockedFunction<typeof applyFeedSyncCommentDelete>;
const deletePost = applyFeedSyncPostDelete as jest.MockedFunction<typeof applyFeedSyncPostDelete>;

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'liveAccountSync.ts'), 'utf8');

const MESSAGE_ROW = { id: 'msg-1', contact_pub_b64: 'peer', text: 'привет', created_at: 7 };

/** Один проход синхронизации: сначала отдаём накопленное, потом принимаем. */
async function runSync(): Promise<void> {
  await syncActiveAccount(MNEMONIC, pair, 1);
}

/** Что модуль отправил бы на сервер за один проход. */
async function push(): Promise<SyncMutation[]> {
  mockPulled = [];
  await runSync();
  return mockPushed;
}

/** Что модуль сделает, приняв эти строки с сервера. */
async function pull(mutations: SyncMutation[]): Promise<void> {
  mockMessages = [];
  mockHeads = [];
  mockCommentTombstones = [];
  mockPulled = mutations;
  await runSync();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPulled = [];
  mockPushed = [];
  mockHeads = [];
  mockMessages = [];
  mockCommentTombstones = [];
});

describe('проверка не пустая', () => {
  it('обычная сущность доезжает от отправки до приёма', async () => {
    mockMessages = [MESSAGE_ROW];
    const [mutation] = await push();
    expect(mutation.deleted).toBe(false);
    await pull([mutation]);
    expect(importMessages).toHaveBeenCalledTimes(1);
  });
});

describe('отправка: метка об удалении запечатывается', () => {
  it('удалённый комментарий ленты уезжает с шифротекстом', async () => {
    mockCommentTombstones = [{ commentId: 'c-1', postId: 'p-1', deletedAt: 5 }];
    const [mutation] = await push();
    expect(mutation.deleted).toBe(true);
    expect(mutation.ciphertextB64).toEqual(expect.any(String));
  });

  it('исчезнувшая сущность тоже: её метка не пустая', async () => {
    mockHeads = [{
      entityKind: 'message', entityId: 'msg-1', ownerProfileId: 1,
      revision: 3, fingerprint: 'f', deleted: false, updatedAt: 1,
    }];
    const [mutation] = await push();
    expect(mutation.deleted).toBe(true);
    expect(mutation.revision).toBe(4);
    expect(mutation.ciphertextB64).toEqual(expect.any(String));
  });

  it('в шифротексте метки нет самой сущности — только время', async () => {
    mockCommentTombstones = [{ commentId: 'c-1', postId: 'p-1', deletedAt: 5 }];
    const [mutation] = await push();
    // Сервер видит длину; она не должна зависеть от того, что удалено.
    const first = mutation.ciphertextB64?.length ?? 0;
    mockCommentTombstones = [{ commentId: 'c-1', postId: 'p-1', deletedAt: 5 }];
    const [again] = await push();
    expect(again.ciphertextB64?.length).toBe(first);
  });
});

describe('приём: удаление без подписи отклоняется', () => {
  it('метка в старом формате (пустой шифротекст) ничего не стирает', async () => {
    await pull([{
      mutationId: 'm-x', entityKind: 'message', entityId: Buffer.from('msg-1').toString('base64url'),
      ownerProfileId: 1, revision: 9, deleted: true, ciphertextB64: null, updatedAt: 1,
    }]);
    expect(deleteEntity).not.toHaveBeenCalled();
  });

  it('подделанный шифротекст метки ничего не стирает', async () => {
    await pull([{
      mutationId: 'm-x', entityKind: 'message', entityId: Buffer.from('msg-1').toString('base64url'),
      ownerProfileId: 1, revision: 9, deleted: true,
      ciphertextB64: Buffer.from(new Uint8Array(64).fill(7)).toString('base64'),
      updatedAt: 1,
    }]);
    expect(deleteEntity).not.toHaveBeenCalled();
  });

  it('отклонённая метка не запоминается как применённая', async () => {
    await pull([{
      mutationId: 'm-x', entityKind: 'message', entityId: Buffer.from('msg-1').toString('base64url'),
      ownerProfileId: 1, revision: 9, deleted: true, ciphertextB64: null, updatedAt: 1,
    }]);
    // Иначе сущность считалась бы удалённой и больше никогда не отправилась бы.
    expect(saveHeads).not.toHaveBeenCalled();
  });

  it('пост ленты чужой меткой не удаляется', async () => {
    await pull([{
      mutationId: 'm-x', entityKind: 'feed_post', entityId: Buffer.from('p-1').toString('base64url'),
      ownerProfileId: 1, revision: 2, deleted: true, ciphertextB64: null, updatedAt: 1,
    }]);
    expect(deletePost).not.toHaveBeenCalled();
  });

  it('своя же метка принимается: удаление продолжает работать', async () => {
    mockCommentTombstones = [{ commentId: 'c-1', postId: 'p-1', deletedAt: 5 }];
    const [mutation] = await push();
    await pull([mutation]);
    expect(deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 'c-1', postId: 'p-1' }),
    );
  });

  it('своя метка о сущности хранилища тоже принимается', async () => {
    mockHeads = [{
      entityKind: 'message', entityId: 'msg-1', ownerProfileId: 1,
      revision: 3, fingerprint: 'f', deleted: false, updatedAt: 1,
    }];
    const [mutation] = await push();
    await pull([mutation]);
    expect(deleteEntity).toHaveBeenCalledWith('message', 'msg-1', 1);
  });
});

describe('приём: откат на прошлую ревизию не проходит', () => {
  it('старый шифротекст под новым номером ревизии не расшифровывается', async () => {
    mockMessages = [MESSAGE_ROW];
    const [mutation] = await push();
    await pull([{ ...mutation, revision: mutation.revision + 4 }]);
    expect(importMessages).not.toHaveBeenCalled();
  });

  it('шифротекст обычной сущности не выдать за метку об удалении', async () => {
    mockMessages = [MESSAGE_ROW];
    const [mutation] = await push();
    await pull([{ ...mutation, deleted: true }]);
    expect(deleteEntity).not.toHaveBeenCalled();
  });

  it('шифротекст не переставить на другую сущность', async () => {
    mockMessages = [MESSAGE_ROW];
    const [mutation] = await push();
    await pull([{ ...mutation, entityId: Buffer.from('msg-2').toString('base64url') }]);
    expect(importMessages).not.toHaveBeenCalled();
  });

  it('шифротекст не переставить в другой профиль', async () => {
    mockMessages = [MESSAGE_ROW];
    const [mutation] = await push();
    await pull([{ ...mutation, ownerProfileId: 2 }]);
    expect(importMessages).not.toHaveBeenCalled();
  });
});

describe('старый формат сущности читается', () => {
  /** Так конверт выглядел до v4.32.523: AAD без ревизии, в теле нет её и признака. */
  function legacyCiphertext(entityKind: string, entityId: string, value: unknown): string {
    const aad = new TextEncoder().encode(`airchat-sync-v1:${entityKind}:${entityId}:1`);
    const plain = new TextEncoder().encode(JSON.stringify({
      v: 1, entityKind, entityId, ownerProfileId: 1, value,
    }));
    return Buffer.from(
      encryptSymmetric(deriveLocalDekFromMnemonic(MNEMONIC), plain, aad),
    ).toString('base64');
  }

  it('сущность, не менявшаяся с прошлой версии, всё ещё разбирается', async () => {
    await pull([{
      mutationId: 'm-old', entityKind: 'message',
      entityId: Buffer.from('msg-1').toString('base64url'),
      ownerProfileId: 1, revision: 1, deleted: false,
      ciphertextB64: legacyCiphertext('message', 'msg-1', MESSAGE_ROW),
      updatedAt: 1,
    }]);
    expect(importMessages).toHaveBeenCalledTimes(1);
  });

  it('но запасной путь не открывает дорогу удалению', async () => {
    await pull([{
      mutationId: 'm-old', entityKind: 'message',
      entityId: Buffer.from('msg-1').toString('base64url'),
      ownerProfileId: 1, revision: 1, deleted: true,
      ciphertextB64: legacyCiphertext('message', 'msg-1', { deletedAt: 1 }),
      updatedAt: 1,
    }]);
    expect(deleteEntity).not.toHaveBeenCalled();
  });
});

describe('исходники', () => {
  it('пишем всегда новую версию формата', () => {
    expect(SOURCE).toContain('const SNAPSHOT_VERSION = 2;');
    expect(SOURCE).toContain('const LEGACY_SNAPSHOT_VERSION = 1;');
  });

  it('ревизия и признак удаления связаны шифротекстом', () => {
    expect(SOURCE).toContain('`${head}:${entity.revision}:${entity.deleted ? 1 : 0}`');
  });

  it('пустых меток об удалении больше не отправляется', () => {
    expect(SOURCE).not.toContain('ciphertextB64: null,');
  });
});
