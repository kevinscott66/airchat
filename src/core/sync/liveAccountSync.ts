import { sha256 } from '@noble/hashes/sha2.js';
import { decryptSymmetric, encryptSymmetric } from '../crypto/encrypt';
import { deriveLocalDekFromMnemonic } from '../storage/dekDerivation';
import {
  applySyncGroupMember,
  applySyncGroupMessage,
  deleteSyncEntity,
  exportConversationMetaRows,
  exportDialogKvSnapshot,
  exportSyncProfileSettings,
  exportGroupBackupRows,
  exportRawChatMessageRows,
  getSyncEntityHeads,
  importConversationMetaRows,
  importDialogKvSnapshot,
  importSyncProfileSetting,
  importGroupBackupRows,
  importRawChatMessageRows,
  rebuildConversationsFromMessages,
  saveSyncEntityHeads,
  type SyncEntityHead,
} from '../storage/local';
import {
  applyFeedSyncComment,
  applyFeedSyncCommentDelete,
  applyFeedSyncPost,
  applyFeedSyncPostDelete,
  exportFeedSyncSnapshot,
} from '../social/feedService';
import type { FeedCommentRow, FeedPostRow } from '../storage/feedStorage';
import type { RawChatMessageRow } from '../storage/chatMessageBackup';
import type { ConversationMetaRow } from '../storage/conversationMeta';
import type { GroupMemberBackupRow, GroupMessageBackupRow } from '../storage/groupBackup';
import { getConfigSync } from '../config';
import { log } from '../logger';
import { feedCommentIsHeldFromSync, feedPostIsHeldFromSync } from '../social/feedPostGuard';
import { heldEntityCount, presentEntityKeys, pushableEntities } from './entityHold';
import { syncAccountOnce } from './accountSync';
import type { SyncEntityKind, SyncMutation, SyncPushResponse } from './syncProtocol';
import type { KeyPairBytes } from '../crypto/keyManager';

/**
 * Версия формата синхронизации.
 *
 * v2 (v4.32.523) отличается от v1 двумя вещами: в AAD вошли номер ревизии и
 * признак удаления, а метка об удалении перестала быть пустой — она тоже
 * шифруется. Читать v1 мы обязаны и дальше: сущность, не менявшаяся с прошлой
 * версии, лежит на сервере в старом виде, и перешифровать её некому — она
 * обновится сама, когда её тронут. Писать — всегда v2.
 */
const SNAPSHOT_VERSION = 2;
const LEGACY_SNAPSHOT_VERSION = 1;
const MAX_PUSH_MUTATIONS = 100;
const MAX_SYNC_ENTITY_BYTES = 420 * 1024;
const MAX_SYNC_PASSES = 20;
let syncGeneration = 0;

type LocalEntity = {
  entityKind: SyncEntityKind;
  entityId: string;
  value: unknown;
  deleted?: boolean;
  /**
   * v4.32.588: строку прочитать не удалось — наверх её не отправляем, но и
   * забывать нельзя: пропуск означал бы надгробие. См. sync/entityHold.
   */
  hold?: boolean;
};

type EncodedEntity = {
  v: number;
  entityKind: SyncEntityKind;
  entityId: string;
  ownerProfileId: number;
  revision: number;
  deleted: boolean;
  /** У метки об удалении — только время; у обычной сущности — сама строка. */
  value: unknown;
};

type AadFields = Pick<
  EncodedEntity,
  'entityKind' | 'entityId' | 'ownerProfileId' | 'revision' | 'deleted'
>;

type PendingHead = SyncEntityHead & { mutationId: string };

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function fingerprint(value: unknown): string {
  return Buffer.from(sha256(new TextEncoder().encode(stableStringify(value)))).toString('base64url');
}

function encodedEntityId(entityId: string): string {
  return Buffer.from(entityId, 'utf8').toString('base64url');
}

function decodedEntityId(entityId: string): string | null {
  try {
    const value = Buffer.from(entityId, 'base64url').toString('utf8');
    return value.length > 0 && value.length <= 256 ? value : null;
  } catch {
    return null;
  }
}

function entityKey(entityKind: string, entityId: string): string {
  return `${entityKind}\u0000${entityId}`;
}

/**
 * Что именно связывает шифротекст (v4.32.523).
 *
 * Раньше в AAD входили только вид сущности, её идентификатор и профиль, а номер
 * ревизии и признак удаления оставались снаружи. Значит, сервер — или тот, кто
 * до него добрался, — мог взять вчерашний шифротекст и выдать его за свежую
 * ревизию: расшифровка сходилась, номер был больше локального, и клиент
 * откатывал сущность назад. Заблокированный контакт снова разблокирован,
 * удалённое сообщение снова в переписке, у отредактированного возвращается
 * прежний текст. Теперь ревизия и признак удаления связаны шифротекстом.
 */
function aadFor(entity: AadFields, version: number = SNAPSHOT_VERSION): Uint8Array {
  const head = `airchat-sync-v${version}:${entity.entityKind}:${entity.entityId}:${entity.ownerProfileId}`;
  return new TextEncoder().encode(
    version === LEGACY_SNAPSHOT_VERSION ? head : `${head}:${entity.revision}:${entity.deleted ? 1 : 0}`,
  );
}

/**
 * Метка об удалении — такая же запечатанная сущность, как и всё остальное.
 *
 * До этого круга удаление приезжало как `deleted: true, ciphertextB64: null` —
 * то есть сервер сообщал клиенту голый факт, ничем не подтверждённый. Стереть
 * что угодно у кого угодно мог кто угодно, у кого была запись в базу сервера:
 * переписку, ленту, настройки, — и стереть навсегда, потому что метка
 * разъезжалась по всем устройствам аккаунта. Обещание «сервер не может читать»
 * держалось, обещание «сервер не может испортить» — нет.
 */
function tombstoneCiphertext(
  mnemonic: string,
  base: Omit<AadFields, 'deleted'>,
  deletedAt: number,
): string | null {
  return encryptEntity(mnemonic, {
    v: SNAPSHOT_VERSION,
    entityKind: base.entityKind,
    entityId: base.entityId,
    ownerProfileId: base.ownerProfileId,
    revision: base.revision,
    deleted: true,
    value: { deletedAt },
  });
}

function encryptEntity(mnemonic: string, entity: EncodedEntity): string | null {
  const plain = new TextEncoder().encode(JSON.stringify(entity));
  const encrypted = encryptSymmetric(deriveLocalDekFromMnemonic(mnemonic), plain, aadFor(entity));
  if (encrypted.byteLength > MAX_SYNC_ENTITY_BYTES) {
    log.warn('live_sync_entity_oversize', {
      entityKind: entity.entityKind,
      entityId: entity.entityId.slice(0, 64),
      bytes: encrypted.byteLength,
    });
    return null;
  }
  return Buffer.from(encrypted).toString('base64');
}

/**
 * Совпадает ли расшифрованное с тем, что заявлено снаружи.
 *
 * AAD уже не дал подменить эти поля, но проверка остаётся: она стоит дёшево, а
 * ловит и случай, когда одно и то же значение зашифровано верно, а собрано в
 * конверт неверно — то есть ошибку на нашей же стороне, а не нападение.
 */
function parseEntityPayload(
  plain: Uint8Array,
  mutation: SyncMutation,
  entityId: string,
  version: number,
): EncodedEntity | null {
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as Partial<EncodedEntity>;
  if (
    parsed.v !== version ||
    parsed.entityKind !== mutation.entityKind ||
    parsed.entityId !== entityId ||
    parsed.ownerProfileId !== mutation.ownerProfileId ||
    parsed.value === undefined
  ) return null;
  if (version !== LEGACY_SNAPSHOT_VERSION
    && (parsed.revision !== mutation.revision || parsed.deleted !== mutation.deleted)) return null;
  return {
    ...parsed,
    revision: parsed.revision ?? mutation.revision,
    deleted: parsed.deleted ?? mutation.deleted,
  } as EncodedEntity;
}

function decryptEntity(mnemonic: string, mutation: SyncMutation): EncodedEntity | null {
  if (!mutation.ciphertextB64) return null;
  try {
    const entityId = decodedEntityId(mutation.entityId);
    if (!entityId) return null;
    const blob = new Uint8Array(Buffer.from(mutation.ciphertextB64, 'base64'));
    if (blob.byteLength > MAX_SYNC_ENTITY_BYTES) return null;
    const dek = deriveLocalDekFromMnemonic(mnemonic);
    const base: AadFields = {
      entityKind: mutation.entityKind,
      entityId,
      ownerProfileId: mutation.ownerProfileId,
      revision: mutation.revision,
      deleted: mutation.deleted,
    };
    const fresh = decryptSymmetric(dek, blob, aadFor(base));
    if (fresh) return parseEntityPayload(fresh, mutation, entityId, SNAPSHOT_VERSION);
    // Меток об удалении в старом формате не существовало вовсе: они не
    // шифровались. Значит, шифротекст с v1 AAD может принадлежать только
    // обычной сущности — и запасной путь удалению не открывается.
    if (mutation.deleted) return null;
    const legacy = decryptSymmetric(dek, blob, aadFor(base, LEGACY_SNAPSHOT_VERSION));
    if (!legacy) return null;
    log.info('live_sync_entity_legacy_aad', { entityKind: mutation.entityKind });
    return parseEntityPayload(legacy, mutation, entityId, LEGACY_SNAPSHOT_VERSION);
  } catch {
    return null;
  }
}

async function collectLocalEntities(ownerProfileId: number): Promise<LocalEntity[]> {
  const [messages, conversations, kv, profileSettings, groups, feed] = await Promise.all([
    exportRawChatMessageRows(ownerProfileId),
    exportConversationMetaRows(ownerProfileId),
    exportDialogKvSnapshot(ownerProfileId),
    exportSyncProfileSettings(ownerProfileId),
    exportGroupBackupRows(ownerProfileId),
    exportFeedSyncSnapshot(),
  ]);
  const entities: LocalEntity[] = [];
  const feedTombstoneIds = new Set(feed.commentTombstones.map((row) => `${row.commentId}\u0000${row.postId}`));
  for (const row of messages) entities.push({ entityKind: 'message', entityId: row.id, value: row });
  for (const row of conversations) entities.push({ entityKind: 'conversation', entityId: row.contact_pub_b64, value: row });
  for (const row of kv) entities.push({ entityKind: 'setting', entityId: row.k, value: row });
  for (const row of profileSettings) entities.push({ entityKind: 'profile', entityId: row.k, value: row });
  for (const row of groups.groups) entities.push({ entityKind: 'group', entityId: row.id, value: row });
  for (const row of groups.messages) entities.push({ entityKind: 'group_message', entityId: row.id, value: row });
  for (const row of groups.members) entities.push({
    entityKind: 'group_member',
    entityId: `${row.group_id}\u0000${row.peer_pub_b64}`,
    value: row,
  });
  // v4.32.588: лента выгружается расшифрованной, и столбец, не открывшийся
  // ключом этого устройства, уехал бы наверх пустой строкой с новой ревизией
  // — а устройство с исправным ключом приняло бы её как более свежую и
  // затёрло свою читаемую запись.
  for (const row of feed.posts) entities.push({
    entityKind: 'feed_post',
    entityId: row.id,
    value: row,
    hold: feedPostIsHeldFromSync(row),
  });
  for (const row of feed.comments) {
    const entityId = `${row.id}\u0000${row.postId}`;
    if (feedTombstoneIds.has(entityId)) continue;
    entities.push({
      entityKind: 'feed_comment',
      entityId,
      value: row,
      hold: feedCommentIsHeldFromSync(row),
    });
  }
  for (const row of feed.commentTombstones) entities.push({
    entityKind: 'feed_comment',
    entityId: `${row.commentId}\u0000${row.postId}`,
    value: row,
    deleted: true,
  });
  return entities;
}

async function collectPending(
  mnemonic: string,
  ownerProfileId: number,
): Promise<{ mutations: SyncMutation[]; pendingHeads: Map<string, PendingHead> }> {
  const [entities, heads] = await Promise.all([
    collectLocalEntities(ownerProfileId),
    getSyncEntityHeads(ownerProfileId),
  ]);
  const headByKey = new Map(heads.map((head) => [entityKey(head.entityKind, head.entityId), head]));
  // v4.32.588: ключи считаются по всем строкам, включая придержанные. Иначе
  // придержанная строка выпадет из набора, и проход ниже выпишет ей
  // надгробие — порча текста вылечилась бы удалением всей строки.
  const currentKeys = presentEntityKeys(entities, (e) => entityKey(e.entityKind, e.entityId));
  const held = heldEntityCount(entities);
  if (held > 0) log.warn('live_sync_entities_held_unreadable', { held });
  const mutations: SyncMutation[] = [];
  const pendingHeads = new Map<string, PendingHead>();
  const now = Date.now();

  for (const entity of pushableEntities(entities)) {
    const key = entityKey(entity.entityKind, entity.entityId);
    if (entity.deleted) {
      if (headByKey.get(key)?.deleted) continue;
      const previous = headByKey.get(key);
      const revision = (previous?.revision ?? 0) + 1;
      const encodedId = encodedEntityId(entity.entityId);
      const ciphertextB64 = tombstoneCiphertext(
        mnemonic,
        { entityKind: entity.entityKind, entityId: entity.entityId, ownerProfileId, revision },
        now,
      );
      if (!ciphertextB64) continue;
      const mutationId = `m:${entity.entityKind}:${ownerProfileId}:${encodedId}:${revision}`;
      mutations.push({
        mutationId,
        entityKind: entity.entityKind,
        entityId: encodedId,
        ownerProfileId,
        revision,
        deleted: true,
        ciphertextB64,
        updatedAt: now,
      });
      pendingHeads.set(mutationId, {
        entityKind: entity.entityKind,
        entityId: entity.entityId,
        ownerProfileId,
        revision,
        fingerprint: null,
        deleted: true,
        updatedAt: now,
        mutationId,
      });
      if (mutations.length >= MAX_PUSH_MUTATIONS) break;
      continue;
    }
    const nextFingerprint = fingerprint(entity.value);
    const previous = headByKey.get(key);
    if (previous && !previous.deleted && previous.fingerprint === nextFingerprint) continue;
    const revision = (previous?.revision ?? 0) + 1;
    const encoded: EncodedEntity = {
      v: SNAPSHOT_VERSION,
      entityKind: entity.entityKind,
      entityId: entity.entityId,
      ownerProfileId,
      revision,
      deleted: false,
      value: entity.value,
    };
    const ciphertextB64 = encryptEntity(mnemonic, encoded);
    if (!ciphertextB64) continue;
    const encodedId = encodedEntityId(entity.entityId);
    const mutationId = `m:${entity.entityKind}:${ownerProfileId}:${encodedId}:${revision}`;
    const mutation: SyncMutation = {
      mutationId,
      entityKind: entity.entityKind,
      entityId: encodedId,
      ownerProfileId,
      revision,
      deleted: false,
      ciphertextB64,
      updatedAt: now,
    };
    mutations.push(mutation);
    pendingHeads.set(mutationId, {
      entityKind: entity.entityKind,
      entityId: entity.entityId,
      ownerProfileId,
      revision,
      fingerprint: nextFingerprint,
      deleted: false,
      updatedAt: now,
      mutationId,
    });
    if (mutations.length >= MAX_PUSH_MUTATIONS) break;
  }

  if (mutations.length < MAX_PUSH_MUTATIONS) {
    for (const previous of heads) {
      const key = entityKey(previous.entityKind, previous.entityId);
      if (previous.deleted || currentKeys.has(key)) continue;
      const revision = previous.revision + 1;
      const encodedId = encodedEntityId(previous.entityId);
      const ciphertextB64 = tombstoneCiphertext(
        mnemonic,
        {
          entityKind: previous.entityKind as SyncEntityKind,
          entityId: previous.entityId,
          ownerProfileId,
          revision,
        },
        now,
      );
      if (!ciphertextB64) continue;
      const mutationId = `m:${previous.entityKind}:${ownerProfileId}:${encodedId}:${revision}`;
      mutations.push({
        mutationId,
        entityKind: previous.entityKind as SyncEntityKind,
        entityId: encodedId,
        ownerProfileId,
        revision,
        deleted: true,
        ciphertextB64,
        updatedAt: now,
      });
      pendingHeads.set(mutationId, {
        ...previous,
        revision,
        fingerprint: null,
        deleted: true,
        updatedAt: now,
        mutationId,
      });
      if (mutations.length >= MAX_PUSH_MUTATIONS) break;
    }
  }
  return { mutations, pendingHeads };
}

async function applyPulledMutation(mnemonic: string, mutation: SyncMutation): Promise<void> {
  const rawEntityId = decodedEntityId(mutation.entityId);
  if (!rawEntityId) throw new Error('Некорректный идентификатор синхронизации.');
  if (mutation.deleted) {
    // Удаление принимается только с подписью. Неподтверждённую метку не
    // применяем и не запоминаем — но и не роняем разбор: иначе один такой
    // конверт останавливал бы курсор навсегда, и синхронизация аккаунта
    // вставала бы целиком. Метки, отправленные до v4.32.523, попадают сюда же:
    // сущность в этом случае остаётся на месте, и это осознанная цена — уж
    // лучше не удалить лишнего, чем удалить чужого.
    if (!decryptEntity(mnemonic, mutation)) {
      log.warn('live_sync_tombstone_unauthenticated', {
        entityKind: mutation.entityKind,
        ownerProfileId: mutation.ownerProfileId,
        revision: mutation.revision,
      });
      return;
    }
    if (mutation.entityKind === 'feed_post') {
      await applyFeedSyncPostDelete(rawEntityId);
    } else if (mutation.entityKind === 'feed_comment') {
      const separator = rawEntityId.indexOf('\u0000');
      if (separator <= 0) throw new Error('Некорректная tombstone ленты.');
      await applyFeedSyncCommentDelete({
        commentId: rawEntityId.slice(0, separator),
        postId: rawEntityId.slice(separator + 1),
        deletedAt: mutation.updatedAt,
      });
    } else {
      await deleteSyncEntity(mutation.entityKind, rawEntityId, mutation.ownerProfileId);
    }
    await saveSyncEntityHeads([{
      entityKind: mutation.entityKind,
      entityId: rawEntityId,
      ownerProfileId: mutation.ownerProfileId,
      revision: mutation.revision,
      fingerprint: null,
      deleted: true,
      updatedAt: mutation.updatedAt,
    }]);
    return;
  }

  const entity = decryptEntity(mnemonic, mutation);
  if (!entity) throw new Error('Не удалось расшифровать синхронизацию.');
  switch (mutation.entityKind) {
    case 'message':
      if ((await importRawChatMessageRows(
        [entity.value as RawChatMessageRow],
        mutation.ownerProfileId,
      )) !== 1) {
        // Do not let accountSync advance the cursor when validation silently
        // rejected the row. The mutation must be replayed after the local
        // profile/database state is repaired.
        throw new Error('Сообщение синхронизации не прошло проверку.');
      }
      break;
    case 'conversation':
      await importConversationMetaRows([entity.value as ConversationMetaRow], mutation.ownerProfileId);
      break;
    case 'setting':
      await importDialogKvSnapshot([entity.value], mutation.ownerProfileId);
      break;
    case 'profile':
      if (!(await importSyncProfileSetting(entity.value, mutation.ownerProfileId))) {
        throw new Error('Некорректная настройка профиля.');
      }
      break;
    case 'group':
      await importGroupBackupRows({ groups: [entity.value] }, mutation.ownerProfileId);
      break;
    case 'group_message':
      await applySyncGroupMessage(entity.value as GroupMessageBackupRow, mutation.ownerProfileId);
      break;
    case 'group_member':
      await applySyncGroupMember(entity.value as GroupMemberBackupRow, mutation.ownerProfileId);
      break;
    case 'feed_post':
      await applyFeedSyncPost(entity.value as FeedPostRow);
      break;
    case 'feed_comment':
      await applyFeedSyncComment(entity.value as FeedCommentRow);
      break;
    default:
      throw new Error(`Неподдерживаемый тип синхронизации: ${mutation.entityKind}`);
  }
  await saveSyncEntityHeads([{
    entityKind: mutation.entityKind,
    entityId: rawEntityId,
    ownerProfileId: mutation.ownerProfileId,
    revision: mutation.revision,
    fingerprint: fingerprint(entity.value),
    deleted: false,
    updatedAt: mutation.updatedAt,
  }]);
}

async function runLiveSync(mnemonic: string, pair: KeyPairBytes, ownerProfileId: number): Promise<void> {
  if (!getConfigSync().cloudBackup?.enabled) return;
  const generation = syncGeneration;
  const shouldContinue = () => generation === syncGeneration;
  for (let pass = 0; pass < MAX_SYNC_PASSES; pass += 1) {
    if (!shouldContinue()) return;
    const collected = await collectPending(mnemonic, ownerProfileId);
    const localHeads = new Map(
      (await getSyncEntityHeads(ownerProfileId)).map((head) => [entityKey(head.entityKind, head.entityId), head]),
    );
    let messagesChanged = false;
    const result = await syncAccountOnce({
      mnemonic,
      pair,
      ownerProfileId,
      pendingMutations: collected.mutations,
      applyMutation: async (mutation) => {
        const rawEntityId = decodedEntityId(mutation.entityId);
        if (!rawEntityId) {
          // Keep the existing validation/error path inside applyPulledMutation.
          await applyPulledMutation(mnemonic, mutation);
          return;
        }
        const key = entityKey(mutation.entityKind, rawEntityId);
        const current = localHeads.get(key);
        // A local edit may have been created after the server cursor was read.
        // Never let an older replay overwrite that newer projection.
        if (current && current.revision >= mutation.revision) return;
        await applyPulledMutation(mnemonic, mutation);
        localHeads.set(key, {
          entityKind: mutation.entityKind,
          entityId: rawEntityId,
          ownerProfileId: mutation.ownerProfileId,
          revision: mutation.revision,
          fingerprint: mutation.deleted ? null : current?.fingerprint ?? null,
          deleted: mutation.deleted,
          updatedAt: mutation.updatedAt,
        });
        if (mutation.entityKind === 'message') messagesChanged = true;
      },
      afterProjection: async () => {
        if (messagesChanged) await rebuildConversationsFromMessages(ownerProfileId);
      },
      onPushAccepted: async (response: SyncPushResponse) => {
        const accepted = response.acceptedMutationIds
          .map((mutationId) => collected.pendingHeads.get(mutationId))
          .filter((head): head is PendingHead => !!head)
          .map(({ mutationId: _mutationId, ...head }) => head);
        await saveSyncEntityHeads(accepted);
      },
      shouldContinue,
    });
    if (result.status === 'offline' || !shouldContinue()) return;
    const hasRejected = (result.pushed?.rejectedMutationIds.length ?? 0) > 0;
    const hasMorePush = collected.mutations.length >= MAX_PUSH_MUTATIONS;
    if (!hasRejected && !hasMorePush && !result.pulled?.hasMore) return;
  }
  log.warn('live_sync_pass_limit', { ownerProfileId, limit: MAX_SYNC_PASSES });
}

/** Cancel in-flight work before replacing or wiping the active identity. */
export function cancelLiveAccountSync(): void {
  syncGeneration += 1;
}

const locks = new Map<number, Promise<void>>();

/** Sync the active seed-bound account; repeated lifecycle events are serialized. */
export function syncActiveAccount(
  mnemonic: string,
  pair: KeyPairBytes,
  ownerProfileId: number,
): Promise<void> {
  const previous = locks.get(ownerProfileId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => runLiveSync(mnemonic, pair, ownerProfileId)).catch((error) => {
    log.warn('live_sync_failed', {
      ownerProfileId,
      err: error instanceof Error ? error.message : String(error),
    });
  });
  locks.set(ownerProfileId, current);
  return current.finally(() => {
    if (locks.get(ownerProfileId) === current) locks.delete(ownerProfileId);
  });
}
