import * as SQLite from 'expo-sqlite';

import { openLeasedDatabase } from './dbLease';
import * as FileSystem from 'expo-file-system/legacy';
import { randomBytes } from '@noble/hashes/utils.js';
import * as SecureStore from './secureStoreQueued';
import { log } from '../logger';
import { makeInviteToken } from '../social/groupInviteToken';
import { MEMBER_ROLE_ORDER_SQL } from '../social/groupRolePolicy';
import { parseViewerList } from '../social/viewerList';
import { mayOverwrite, cellTextOrNull, classifyAtRestCell, type AtRestCell } from './atRestCell';
import { scheduledReadState, type ScheduledReadState } from '../social/scheduledDispatch';
import type { ReactionWriteResult } from '../social/reactionWrite';
import { mayWritePreview, previewAction } from './unreadableCell';
import { unreadableFromCellState } from './unreadableText';
import { emptySearchScan, noteSearchedRow, type SearchScan } from './searchScan';
import {
  countScannedCell,
  countScannedRow,
  emptyRefScanTally,
  mayDeleteUnreferenced,
  refScanReport,
  type RefScanTally,
} from './refScanTally';
import { SECRET_UNREADABLE_TEXT, decideSecretUpdate } from './secretUpdate';
import {
  AT_REST_PREFIX,
  DEK_KEY,
  decryptAtRestString,
  readAtRestCell,
  tryDecryptAtRest,
  encryptAtRestIfPlain,
  encryptAtRestNullable,
  encryptAtRestString,
  getOrCreateDataEncryptionKey,
  canaryOpensWith,
  persistDek,
} from './localEncryption';
import { bytesEqualConstTime, deriveLocalDekFromMnemonic } from './dekDerivation';
import { reactionScopeSql, type ReactionScope } from './reactionScope';
import { anyChanged } from './writeEcho';
import {
  foundResult,
  missingResult,
  failedResult,
  lookupValue,
  type LookupResult,
} from '../utils/lookupResult';
import type { ChatPageCursor } from './chatPageCursor';
import type { DbRead } from './readResult';
import {
  INLINE_BLOB_PREFIX,
  decodeInlineBlob,
  encodeInlineBlob,
  isInlineBlobEncrypted,
  reencryptInlineBlob,
} from './inlineBlobCrypto';
import {
  dialogBackupKeySelectors,
  dialogBackupLogicalKey,
  dialogBackupStoredKey,
  hasProfilePrefix,
  legacySuffixBlockedKey,
  LEGACY_GLOBAL_SYNC_KEYS,
  OWN_PROFILE_KEYS,
  PER_PROFILE_UI_KEYS,
  PRIVACY_PREF_KEYS,
  pollClosedKey,
  profileScopedKey,
} from './kvKeys';
// Соглашение об именовании ключей kv живёт в kvKeys.ts, но исторически
// profileScopedKey импортируют отсюда — поэтому реэкспорт.
export { profileScopedKey } from './kvKeys';
import { shouldApplyDefaultAutoDelete } from './autoDeletePolicy';
import { forgetDefaultDisappear, getDefaultDisappearMsFor } from './defaultDisappear';
import {
  isColorTag,
  sanitizeConversationMetaRows,
  type ConversationMetaRow,
} from './conversationMeta';
import { sanitizeRawChatMessageRows } from './chatMessageBackup';
import { AT_REST_COLUMNS } from './atRestColumns';
import { rebuildColumns, type ColumnInfo } from './tableRebuild';
import { classifyStorageError, type StoragePressureKind } from './storagePressure';
import {
  sanitizeGroupMemberRows,
  sanitizeGroupMessageRows,
  sanitizeGroupRows,
  type GroupBackupRow,
  type GroupMemberBackupRow,
  type GroupMessageBackupRow,
} from './groupBackup';
import { clearTracesSql } from './purgeResidue';
// Модули без импортов — цикла storage → social → storage не возникает.
import { clampJoinedAt } from '../social/envelopeTime';
import { isControlOnlyText, previewLabelForText } from '../social/messagePreview';
import { matchesSearch } from '../social/searchableText';
import { countMembers } from '../social/groupRolePolicy';
import { nameOrNull } from '../social/contactLabel';
import { applyReaction, parseReactionMap, serializeReactionMap } from '../social/reactionMapPolicy';
import { blobCacheIdsIn, isDecryptedBlobUri, voiceFileUrisIn } from '../media/blobRef';
import {
  lostAddressCount,
  planStoryMediaSweep,
  type StoryUriCell,
} from '../media/storyMediaSweep';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
/**
 * Провалившаяся попытка открыть базу (v4.32.436).
 *
 * Поле dbPromise раньше держало и отказ тоже: одна неудача при старте — и
 * КАЖДОЕ последующее обращение к хранилищу до перезапуска процесса получало
 * тот же отказ. Снаружи это выглядело не как ошибка, а как пустой телефон:
 * kvGet отдаёт null, kvSetChecked — false, переписки не читаются и не пишутся,
 * и всё молча.
 *
 * Поэтому отказ из поля снимается, но помнится: без паузы каждое обращение
 * заново прогоняло бы всю цепочку миграций, а их здесь четыре десятка.
 */
let dbOpenError: unknown = null;
let dbOpenFailedAt = 0;
const DB_REOPEN_COOLDOWN_MS = 2000;

const LOCAL_DB_NAME = 'airchat_local.db';

const MIGRATED_KV = 'local_crypto_migrated_v2';
const DEK_MIGRATED_KV = 'dek_migrated_to_deterministic_v1';
const GROUP_MEMBER_NAMES_ENC_KV = 'group_member_names_enc_v1';
const MESSAGE_SOCIAL_ENC_KV = 'message_social_enc_v1';
const SCHEDULED_SENDER_ENC_KV = 'scheduled_sender_name_enc_v1';
const GROUP_AVATAR_ENC_KV = 'group_avatar_cid_enc_v1';

async function initSchema(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      owner_profile_id INTEGER
    );
    /* Cursor metadata for server-backed sync. Domain rows remain cache data. */
    CREATE TABLE IF NOT EXISTS sync_state (
      owner_profile_id INTEGER PRIMARY KEY NOT NULL,
      cursor TEXT,
      server_epoch TEXT,
      last_pull_at INTEGER,
      last_push_at INTEGER
    );
    /* Fingerprints/revisions for the server-backed entity projection. The
       fingerprint is non-secret; row payloads are encrypted before upload. */
    CREATE TABLE IF NOT EXISTS sync_entity_heads (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      owner_profile_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      fingerprint TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity_kind, entity_id, owner_profile_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_entity_heads_profile
      ON sync_entity_heads (owner_profile_id, entity_kind, entity_id);
    /* Текст и media_cids — ciphertext (XChaCha20-Poly1305), ключ в SecureStore. */
    CREATE TABLE IF NOT EXISTS chat_messages (
      /*
       * v4.32.519: первичный ключ составной — по образцу groups (v4.32.467).
       * Пока им был один id, сообщение принадлежало установке, а не аккаунту.
       * Идентификатор сообщения задаёт отправитель, а профили одного телефона
       * — разные люди: стоило одному и тому же id прийти в оба аккаунта, и
       * INSERT OR IGNORE молча не делал ничего (сообщение не появлялось во
       * втором профиле вовсе), а INSERT OR REPLACE сносил чужую строку вместе
       * со статусом, звёздочкой и реакциями.
       */
      id TEXT NOT NULL,
      contact_pub_b64 TEXT NOT NULL,
      cid TEXT,
      text TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      media_cids TEXT,
      created_at INTEGER NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      reply_to_id TEXT,
      reply_to_preview TEXT,
      PRIMARY KEY (id, owner_profile_id)
    );
    /* Метаданные диалогов: непрочитанные, черновики, закреплённые, архив, беззвучно. */
    CREATE TABLE IF NOT EXISTS conversations (
      contact_pub_b64 TEXT NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      unread_count INTEGER NOT NULL DEFAULT 0,
      draft_text TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT,
      last_message_direction TEXT,
      PRIMARY KEY (contact_pub_b64, owner_profile_id)
    );
    /*
     * v4.32.519: профиль вошёл в индекс. Каждый запрос к переписке отбирает
     * строки по паре (собеседник, профиль), а старый индекс знал только про
     * собеседника — на телефоне с двумя аккаунтами база доставала чужие строки
     * и отбрасывала их уже после чтения. Имя новое, потому что CREATE INDEX
     * IF NOT EXISTS не переопределяет существующий индекс, а тихо оставляет
     * старый; прежний убираем явно.
     */
    CREATE INDEX IF NOT EXISTS idx_chat_contact_profile
      ON chat_messages (contact_pub_b64, owner_profile_id, created_at DESC);
    DROP INDEX IF EXISTS idx_chat_contact;
    CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox (created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_conv_profile ON conversations (owner_profile_id, pinned DESC, last_message_at DESC);
    /* Группы и каналы. */
    CREATE TABLE IF NOT EXISTS groups (
      /*
       * v4.32.467: первичный ключ составной. Пока им был один id, группа
       * принадлежала установке, а не аккаунту: второй профиль этого же
       * телефона не мог завести группу с тем же идентификатором —
       * INSERT OR IGNORE молча не делал ничего, и группа по ссылке в нём
       * просто не появлялась.
       */
      id TEXT NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      description TEXT,
      avatar_cid TEXT,
      type TEXT NOT NULL DEFAULT 'group',  /* group | channel | supergroup */
      /*
       * v4.32.303: invite_link больше не пишется и не читается. Ссылка целиком
       * выводится из строки группы (groupInviteLink), хранить её было незачем, а
       * с появлением токена стало вредно: готовая ссылка несёт секрет группы, и
       * колонка держала бы его открытым текстом рядом с шифрованными. Секрет
       * живёт в invite_token и шифруется (AT_REST_COLUMNS). Колонку не удаляем:
       * ALTER TABLE ... DROP COLUMN есть не во всех сборках SQLite.
       */
      invite_link TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      member_count INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, owner_profile_id)
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      peer_pub_b64 TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',  /* owner | admin | member | banned */
      display_name TEXT,
      joined_at INTEGER NOT NULL DEFAULT 0,
      /*
       * v4.32.466: состав группы принадлежит профилю, как и всё остальное.
       * Без этой колонки одна строка описывала участника «вообще», и профили
       * этого приложения делили её на всех: выход из группы в одном аккаунте
       * стирал состав у соседа, бан прилетал обоим, а экран участников
       * показывал тех, кого в этом аккаунте никто не звал.
       */
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (group_id, peer_pub_b64, owner_profile_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      /* v4.32.519: ключ составной по той же причине, что и у chat_messages. */
      id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      sender_pub_b64 TEXT NOT NULL,
      sender_name TEXT,
      text TEXT NOT NULL,
      media_cids TEXT,
      reply_to_id TEXT,
      reply_to_preview TEXT,
      reactions TEXT,
      created_at INTEGER NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (id, owner_profile_id)
    );
    CREATE INDEX IF NOT EXISTS idx_grp_msg_profile
      ON group_messages (group_id, owner_profile_id, created_at DESC);
    DROP INDEX IF EXISTS idx_grp_msg;
    CREATE INDEX IF NOT EXISTS idx_grp_members ON group_members (group_id, owner_profile_id);
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY NOT NULL,
      author_pub_b64 TEXT NOT NULL,
      media_uri TEXT,
      text TEXT,
      expires_at INTEGER NOT NULL,
      viewed_by TEXT,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stories ON stories (author_pub_b64, created_at DESC);
    /*
     * v4.32.576: альбомы историй. История живёт сутки и уходит вместе со
     * своим файлом — это обещание, а не недоделка. Альбом — обещание
     * обратное: «эту оставить», поэтому в него кладётся СВОЯ копия снимка
     * (media_file, каталог документов, см. storyAlbumFiles), а не ссылка на
     * истёкшую строку.
     *
     * Адреса у снимка два, и это не дублирование. media_file — копия на ЭТОМ
     * телефоне, и она своя у каждой установки: имя файла второму устройству
     * ничего не значит, поэтому наверх оно не уезжает вовсе. media_cid —
     * общий адрес в IPFS, по нему альбом собирается на другом устройстве
     * аккаунта. Строка без CID из синхронизации придерживается: уехавшая без
     * снимка, она дала бы на том телефоне пустую плитку навсегда.
     *
     * Ключ составной: альбомы принадлежат аккаунту, а не установке, — ровно
     * та же причина, по которой составным стал ключ групп в v4.32.467.
     */
    CREATE TABLE IF NOT EXISTS story_albums (
      id TEXT NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (id, owner_profile_id)
    );
    CREATE TABLE IF NOT EXISTS story_album_items (
      id TEXT NOT NULL,
      album_id TEXT NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      media_file TEXT,
      media_cid TEXT,
      media_type TEXT NOT NULL DEFAULT 'image',
      text TEXT,
      created_at INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (id, owner_profile_id)
    );
    CREATE INDEX IF NOT EXISTS idx_story_album_items
      ON story_album_items (album_id, owner_profile_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY NOT NULL,
      contact_pub_b64 TEXT NOT NULL,
      text TEXT NOT NULL,
      media_cids TEXT,
      send_at INTEGER NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled ON scheduled_messages (send_at ASC);

    CREATE TABLE IF NOT EXISTS poll_votes (
      message_id TEXT NOT NULL,
      voter_pub_b64 TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      -- option_index в ключе — иначе в опросе с несколькими вариантами второй
      -- голос затирал первый. У существующих баз это чинит
      -- ensurePollVotesMultipleChoice; здесь правильный ключ сразу, чтобы на
      -- свежей установке таблица не пересоздавалась миграцией на первом же старте.
      PRIMARY KEY (message_id, voter_pub_b64, option_index, owner_profile_id)
    );
    CREATE TABLE IF NOT EXISTS quick_replies (
      id TEXT PRIMARY KEY NOT NULL,
      text TEXT NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_quick_replies ON quick_replies (owner_profile_id, created_at ASC);
    CREATE TABLE IF NOT EXISTS group_join_requests (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL,
      requester_pub_b64 TEXT NOT NULL,
      requester_name TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  /* pending | approved | rejected */
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_grp_join_req ON group_join_requests (group_id, status, created_at DESC);
  `);
}

/** Старые БД без колонки профиля — ALTER + заполнение. */
async function ensureChatMessagesOwnerProfileColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>(
      'PRAGMA table_info(chat_messages)'
    );
    if (cols.some((c) => c.name === 'owner_profile_id')) return;
    await database.execAsync(
      'ALTER TABLE chat_messages ADD COLUMN owner_profile_id INTEGER NOT NULL DEFAULT 1'
    );
  } catch (e) {
    log.warn('owner_profile_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** reply_to_id, reply_to_preview, edited_at — для цитат и редактирования. */
async function ensureReplyToColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(chat_messages)');
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('reply_to_id')) {
      await database.execAsync('ALTER TABLE chat_messages ADD COLUMN reply_to_id TEXT');
    }
    if (!names.has('reply_to_preview')) {
      await database.execAsync('ALTER TABLE chat_messages ADD COLUMN reply_to_preview TEXT');
    }
    if (!names.has('edited_at')) {
      await database.execAsync('ALTER TABLE chat_messages ADD COLUMN edited_at INTEGER');
    }
  } catch (e) {
    log.warn('reply_to_columns_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * reactions JSON и forwarded_from.
 *
 * forwarded_from не пишет и не читает никто: пересылка помечается внутри самого
 * текста конвертом '\x08fwd:Имя\nТекст' (forwardEnvelope.ts) — только так метка
 * доезжает до собеседника, тогда как колонка осталась бы на одном устройстве.
 * Колонку оставляем: ALTER TABLE ... DROP COLUMN есть не во всех сборках SQLite,
 * а пересоздавать таблицу с сообщениями ради пустого поля — риск куда больший,
 * чем само поле. Не заводите здесь второй механизм пересылки: до v4.32.301 в
 * ChatScreen жила ветка `item.forwardedFrom ? 'Переслано'`, которая при живой
 * колонке нарисовала бы вторую метку над настоящей «Переслано от N».
 */
async function ensureMessageExtraColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(chat_messages)');
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('reactions')) {
      await database.execAsync('ALTER TABLE chat_messages ADD COLUMN reactions TEXT');
    }
    if (!names.has('forwarded_from')) {
      await database.execAsync('ALTER TABLE chat_messages ADD COLUMN forwarded_from TEXT');
    }
  } catch (e) {
    log.warn('message_extra_columns_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * media_cid у строк альбома (v4.32.576).
 *
 * Таблица завелась на день раньше столбца, и установки с той сборки уже
 * существуют. Без этого прохода они падали бы на первом же чтении альбома.
 */
async function ensureStoryAlbumMediaCidColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(story_album_items)');
    if (cols.length > 0 && !cols.some((c) => c.name === 'media_cid')) {
      await database.execAsync('ALTER TABLE story_album_items ADD COLUMN media_cid TEXT');
    }
  } catch (e) {
    log.warn('story_album_media_cid_migration_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** pinned_message_id, disappear_after_ms, disappear_set_at — закрепление и автоудаление сообщений. */
async function ensureConversationPinnedMessageColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(conversations)');
    if (!cols.some((c) => c.name === 'pinned_message_id')) {
      await database.execAsync('ALTER TABLE conversations ADD COLUMN pinned_message_id TEXT');
    }
    if (!cols.some((c) => c.name === 'disappear_after_ms')) {
      await database.execAsync('ALTER TABLE conversations ADD COLUMN disappear_after_ms INTEGER');
    }
    // v4.32.237: момент включения таймера. Автоудаление действует только на
    // сообщения, написанные ПОСЛЕ включения — иначе включение «1 минута»
    // стирало бы всю прошлую переписку мгновенно, а с приходом синхронизации
    // это делал бы ещё и собеседник одним сообщением.
    if (!cols.some((c) => c.name === 'disappear_set_at')) {
      await database.execAsync('ALTER TABLE conversations ADD COLUMN disappear_set_at INTEGER');
    }
  } catch (e) {
    log.warn('conversation_pinned_msg_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** muted_until — время окончания беззвучного режима; slow_mode_seconds — задержка между сообщениями. */
async function ensureMutedUntilColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const convCols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(conversations)');
    if (!convCols.some((c) => c.name === 'muted_until')) {
      await database.execAsync('ALTER TABLE conversations ADD COLUMN muted_until INTEGER');
    }
    const grpCols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!grpCols.some((c) => c.name === 'muted_until')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN muted_until INTEGER');
    }
    if (!grpCols.some((c) => c.name === 'slow_mode_seconds')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN slow_mode_seconds INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    log.warn('muted_until_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** starred — флаг «Избранное» для личных и групповых сообщений. */
async function ensureStarredColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const msgCols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(chat_messages)');
    if (!msgCols.some((c) => c.name === 'starred')) {
      await database.execAsync('ALTER TABLE chat_messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0');
    }
    const grpCols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(group_messages)');
    if (!grpCols.some((c) => c.name === 'starred')) {
      await database.execAsync('ALTER TABLE group_messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    log.warn('starred_columns_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * transport — каким путём сообщение реально ушло (v4.32.563).
 *
 * Столбец пуст у всего, что записано до этой версии, и у всего входящего:
 * чужой маршрут нам не виден. Пустое значение и означает «путь неизвестен» —
 * в «Сведениях о сообщении» строка маршрута тогда просто не рисуется, вместо
 * того чтобы называть наугад самый вероятный транспорт.
 */
async function ensureMessageTransportColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(chat_messages)');
    if (!cols.some((c) => c.name === 'transport')) {
      await database.execAsync('ALTER TABLE chat_messages ADD COLUMN transport TEXT');
    }
  } catch (e) {
    log.warn('transport_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** last_message_sender_name — имя отправителя последнего сообщения в группе. */
async function ensureGroupSenderNameColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'last_message_sender_name')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN last_message_sender_name TEXT');
    }
    if (!cols.some((c) => c.name === 'last_message_sender_pub')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN last_message_sender_pub TEXT');
    }
  } catch (e) {
    log.warn('group_sender_name_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** pinned_message_id и pinned_message_text для groups — закрепление сообщений. */
async function ensureGroupPinnedMessageColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('pinned_message_id')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN pinned_message_id TEXT');
    }
    if (!names.has('pinned_message_text')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN pinned_message_text TEXT');
    }
  } catch (e) {
    log.warn('group_pinned_message_columns_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** edited_at для group_messages — редактирование сообщений в группах. */
async function ensureGroupMessageEditedAtColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(group_messages)');
    if (!cols.some((c) => c.name === 'edited_at')) {
      await database.execAsync('ALTER TABLE group_messages ADD COLUMN edited_at INTEGER');
    }
  } catch (e) {
    log.warn('group_messages_edited_at_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** mention_count — счётчик непрочитанных упоминаний @username в группе. */
async function ensureGroupMentionCountColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'mention_count')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    log.warn('group_mention_count_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** draft_text — черновик сообщения для группы. */
async function ensureGroupDraftTextColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'draft_text')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN draft_text TEXT');
    }
  } catch (e) {
    log.warn('group_draft_text_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * disappear_after_ms, disappear_set_at — таймер автоудаления сообщений группы
 * и момент его включения. Момент нужен по той же причине, что и у диалогов:
 * без нижней границы «1 минута» стирала бы всю прошлую переписку группы сразу.
 */
async function ensureGroupDisappearAfterMsColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'disappear_after_ms')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN disappear_after_ms INTEGER');
    }
    if (!cols.some((c) => c.name === 'disappear_set_at')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN disappear_set_at INTEGER');
    }
  } catch (e) {
    log.warn('group_disappear_after_ms_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** admin_only_posting — только администраторы могут отправлять сообщения в обычной группе. */
async function ensureGroupAdminOnlyPostingColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'admin_only_posting')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN admin_only_posting INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    log.warn('group_admin_only_posting_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * admin_only_pinning — закреплять сообщения могут только администраторы.
 *
 * DEFAULT 1 сохраняет поведение, которое было до появления настройки: пункт
 * «Закрепить» показывался только при amAdmin. Выключение отдаёт закрепление
 * всем участникам — как «Pin Messages» в правах группы Telegram.
 */
async function ensureGroupAdminOnlyPinningColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'admin_only_pinning')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN admin_only_pinning INTEGER NOT NULL DEFAULT 1');
    }
  } catch (e) {
    log.warn('group_admin_only_pinning_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** anonymous_posting — сообщения отображаются без имени отправителя. */
async function ensureGroupAnonymousPostingColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'anonymous_posting')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN anonymous_posting INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    log.warn('group_anonymous_posting_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** view_count — счётчик просмотров сообщения (аналог Telegram-каналов). */
async function ensureGroupMessageViewCountColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(group_messages)');
    if (!cols.some((c) => c.name === 'view_count')) {
      await database.execAsync('ALTER TABLE group_messages ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    log.warn('group_message_view_count_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** seen_by — JSON-массив pubB64 прочитавших сообщение в группе. */
/**
 * Составной первичный ключ у groups (v4.32.467).
 *
 * Пока ключом был один `id`, идентификатор группы принадлежал установке, а не
 * аккаунту. Следствия: второй профиль того же телефона не мог принять
 * приглашение в группу, уже заведённую первым, — `INSERT OR IGNORE` молча не
 * делал ничего, и группа не появлялась ни в списке, ни в поиске; а
 * восстановление резервной копии во второй профиль по той же причине
 * пропускало все группы, чьи идентификаторы уже заняты.
 *
 * Пересборка идёт по образцу ensurePollVotesMultipleChoice — те же четыре
 * состояния на диске и та же транзакция, — но список колонок берётся у самой
 * базы (PRAGMA table_info), а не пишется здесь руками: к groups за тридцать
 * с лишним версий добавляли колонки по одной, и захардкоженный список молча
 * потерял бы ту, что появилась последней.
 */
async function ensureGroupsProfileScopedKey(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const oldExists = await tableExists(database, 'groups');
    const v2Exists = await tableExists(database, 'groups_v2');

    if (oldExists) {
      const info = await database.getAllAsync<{ name: string; pk: number }>('PRAGMA table_info(groups)');
      const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name);
      if (pkCols.includes('owner_profile_id')) return; // уже переехали
    } else if (v2Exists) {
      await database.execAsync('ALTER TABLE groups_v2 RENAME TO groups;');
      log.info('groups_migrate_recovered_from_rename_gap');
      return;
    } else {
      return; // чистая установка
    }

    const cols = await database.getAllAsync<ColumnInfo>('PRAGMA table_info(groups)');
    const { decls, names, skipped } = rebuildColumns(cols, '          ');
    if (skipped.length) log.warn('groups_migrate_columns_skipped', { skipped: skipped.join(',') });
    // Ключевые колонки должны быть на месте: без них новая таблица получится
    // не той, что описана в схеме, а переливать в неё уже нечего.
    if (!names.includes('id') || !names.includes('owner_profile_id')) {
      log.warn('groups_migrate_skipped_unexpected_schema');
      return;
    }

    await database.execAsync('BEGIN IMMEDIATE;');
    try {
      // INSERT без OR IGNORE: в старой таблице id — первичный ключ, значит
      // пара (id, owner_profile_id) заведомо уникальна, и «пропустить строку»
      // здесь может означать только настоящую поломку. Пусть она откатит
      // транзакцию, а не потеряет группу молча.
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS groups_v2 (
${decls},
          PRIMARY KEY (id, owner_profile_id)
        );
        INSERT INTO groups_v2 (${names}) SELECT ${names} FROM groups;
        DROP TABLE groups;
        ALTER TABLE groups_v2 RENAME TO groups;
      `);
      await database.execAsync('COMMIT;');
      log.info('groups_migrated_to_composite_key', { cols: names.split(', ').length });
    } catch (inner) {
      await database.execAsync('ROLLBACK;').catch(() => { /* ignore */ });
      throw inner;
    }
  } catch (e) {
    log.warn('groups_migrate_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Составной ключ у переписки (v4.32.519).
 *
 * Дефект тот же, что был у групп в v4.32.467, только цена выше: первичным
 * ключом chat_messages и group_messages был один `id`. Идентификатор сообщения
 * приходит от отправителя и уникален у него, а не на нашем телефоне — и стоит
 * одному и тому же сообщению попасть в два профиля (общий канал, общая группа,
 * восстановление одной копии в оба аккаунта), как:
 *  - `INSERT OR IGNORE` во втором профиле тихо не делает ничего — сообщения в
 *    переписке просто нет, без ошибки и без записи в журнале;
 *  - `INSERT OR REPLACE` сносит строку первого профиля вместе со статусом,
 *    звёздочкой и реакциями и подставляет на её место чужую;
 *  - `ON CONFLICT (id)` в синхронизации переписывал соседскую строку и заодно
 *    менял ей `owner_profile_id` — сообщение переезжало в другой аккаунт.
 *
 * Переезд по образцу ensureGroupsProfileScopedKey: те же четыре состояния на
 * диске, та же транзакция, список колонок берётся у самой базы (в этих
 * таблицах он рос от версии к версии — edited_at, starred, view_count,
 * seen_by), а не пишется руками.
 *
 * Индекс пересоздаётся здесь же: DROP TABLE уносит его с собой, а блок схемы
 * с CREATE INDEX IF NOT EXISTS в этот запуск уже отработал — без строчки ниже
 * переписка осталась бы без индекса до следующего старта.
 *
 * WITHOUT ROWID не используется намеренно: по rowid ходят перешифровка при
 * смене DEK (reencryptAtRest) и уборка служебных конвертов.
 */
async function ensureChatMessagesProfileScopedKey(database: SQLite.SQLiteDatabase): Promise<void> {
  await ensureMessageTableCompositeKey(database, {
    table: 'chat_messages',
    index: 'CREATE INDEX IF NOT EXISTS idx_chat_contact_profile '
      + 'ON chat_messages (contact_pub_b64, owner_profile_id, created_at DESC);',
  });
}

async function ensureGroupMessagesProfileScopedKey(database: SQLite.SQLiteDatabase): Promise<void> {
  await ensureMessageTableCompositeKey(database, {
    table: 'group_messages',
    index: 'CREATE INDEX IF NOT EXISTS idx_grp_msg_profile '
      + 'ON group_messages (group_id, owner_profile_id, created_at DESC);',
  });
}

/**
 * Общая часть обеих пересборок.
 *
 * Одной функцией на две таблицы, потому что расходиться им нельзя: они
 * повторяют друг друга колонка в колонку по смыслу, и разъехавшиеся пересборки
 * означали бы, что в одной из таблиц ключ так и остался прежним — а заметно
 * это стало бы только на чужом телефоне с двумя аккаунтами.
 */
async function ensureMessageTableCompositeKey(
  database: SQLite.SQLiteDatabase,
  spec: { table: string; index: string },
): Promise<void> {
  const { table, index } = spec;
  const tmp = `${table}_v2`;
  try {
    const oldExists = await tableExists(database, table);
    const v2Exists = await tableExists(database, tmp);

    if (oldExists) {
      const info = await database.getAllAsync<{ name: string; pk: number }>(
        `PRAGMA table_info(${table})`
      );
      const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name);
      if (pkCols.includes('owner_profile_id')) return; // уже переехали
    } else if (v2Exists) {
      // Упали между DROP и RENAME — доименовать и закончить.
      await database.execAsync(`ALTER TABLE ${tmp} RENAME TO ${table};`);
      await database.execAsync(index);
      log.info('messages_migrate_recovered_from_rename_gap', { table });
      return;
    } else {
      return; // чистая установка — таблицу создаст CREATE TABLE IF NOT EXISTS
    }

    const cols = await database.getAllAsync<ColumnInfo>(`PRAGMA table_info(${table})`);
    const { decls, names, skipped } = rebuildColumns(cols, '          ');
    if (skipped.length) log.warn('messages_migrate_columns_skipped', { table, skipped: skipped.join(',') });
    if (!names.includes('id') || !names.includes('owner_profile_id')) {
      log.warn('messages_migrate_skipped_unexpected_schema', { table });
      return;
    }

    await database.execAsync('BEGIN IMMEDIATE;');
    try {
      // INSERT без OR IGNORE: в старой таблице id — первичный ключ, значит
      // пара (id, owner_profile_id) заведомо уникальна, и «пропустить строку»
      // здесь может означать только настоящую поломку. Пусть она откатит
      // транзакцию, а не потеряет сообщение молча.
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS ${tmp} (
${decls},
          PRIMARY KEY (id, owner_profile_id)
        );
        INSERT INTO ${tmp} (${names}) SELECT ${names} FROM ${table};
        DROP TABLE ${table};
        ALTER TABLE ${tmp} RENAME TO ${table};
        ${index}
      `);
      await database.execAsync('COMMIT;');
      log.info('messages_migrated_to_composite_key', { table, cols: names.split(', ').length });
    } catch (inner) {
      await database.execAsync('ROLLBACK;').catch(() => { /* ignore */ });
      throw inner;
    }
  } catch (e) {
    log.warn('messages_migrate_failed', { table, err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Профильная колонка у group_members (v4.32.466).
 *
 * До этой версии состав группы лежал одной строкой на всё приложение:
 * первичный ключ (group_id, peer_pub_b64), колонки профиля нет. Профили одной
 * установки — это разные люди с разными ключами; общая таблица участников
 * означала, что выход из группы в одном аккаунте удалял состав у второго
 * (`DELETE FROM group_members WHERE group_id = ?`), бан и смена роли,
 * пришедшие в один профиль, немедленно действовали и во втором, а экран
 * участников показывал соседский состав — то есть выдавал, с кем сосед
 * состоит в группе.
 *
 * Переезд идёт по образцу ensurePollVotesMultipleChoice: те же четыре
 * состояния на диске, та же транзакция. Профиль существующим строкам берётся
 * у самой группы — она про профиль знает всегда; если строки группы уже нет
 * (осиротевший состав), остаётся 1: непрефиксованные записи принадлежат
 * первому профилю по общему правилу этой базы.
 */
async function ensureGroupMembersProfileScoped(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const oldExists = await tableExists(database, 'group_members');
    const v2Exists = await tableExists(database, 'group_members_v2');

    if (oldExists) {
      const info = await database.getAllAsync<{ name: string; pk: number }>(
        'PRAGMA table_info(group_members)'
      );
      const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name);
      if (pkCols.includes('owner_profile_id')) return; // уже переехали
    } else if (v2Exists) {
      // Упали между DROP и RENAME — доименовать и закончить.
      await database.execAsync('ALTER TABLE group_members_v2 RENAME TO group_members;');
      log.info('group_members_migrate_recovered_from_rename_gap');
      return;
    } else {
      return; // чистая установка — таблицу создаст CREATE TABLE IF NOT EXISTS
    }

    await database.execAsync('BEGIN IMMEDIATE;');
    try {
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS group_members_v2 (
          group_id TEXT NOT NULL,
          peer_pub_b64 TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          display_name TEXT,
          joined_at INTEGER NOT NULL DEFAULT 0,
          owner_profile_id INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (group_id, peer_pub_b64, owner_profile_id)
        );
        INSERT OR IGNORE INTO group_members_v2
          SELECT m.group_id, m.peer_pub_b64, m.role, m.display_name, m.joined_at,
                 COALESCE((SELECT g.owner_profile_id FROM groups g WHERE g.id = m.group_id), 1)
            FROM group_members m;
        DROP TABLE group_members;
        ALTER TABLE group_members_v2 RENAME TO group_members;
        CREATE INDEX IF NOT EXISTS idx_grp_members ON group_members (group_id, owner_profile_id);
      `);
      await database.execAsync('COMMIT;');
      log.info('group_members_migrated_to_profile_scope');
    } catch (inner) {
      await database.execAsync('ROLLBACK;').catch(() => { /* ignore */ });
      throw inner;
    }
  } catch (e) {
    log.warn('group_members_migrate_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Migrate poll_votes to support multiple-choice polls (option_index in PK). */
async function ensurePollVotesMultipleChoice(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    // v4.32.129 (AUDIT P2): handle all 3 crash-interrupted states idempotently.
    // Possible on-disk states we can arrive in:
    //   (A) only `poll_votes` exists (old PK)  ← fresh migration needed
    //   (B) only `poll_votes` exists (new PK)  ← already done, early-exit
    //   (C) both `poll_votes` AND `poll_votes_v2` exist
    //       ← crashed between INSERT and DROP; retry is safe
    //   (D) only `poll_votes_v2` exists (data already copied)
    //       ← crashed between DROP and RENAME; rename & finish
    // The previous impl ran INSERT/DROP/RENAME in one un-wrapped execAsync,
    // so a crash in state (D) left us permanently stuck: next boot,
    // `poll_votes` is missing, `INSERT ... FROM poll_votes` throws, catch
    // swallows, and every subsequent boot repeats the same failure —
    // migrated rows in v2 are never finalised.
    const oldExists = await tableExists(database, 'poll_votes');
    const v2Exists = await tableExists(database, 'poll_votes_v2');

    if (oldExists) {
      const info = await database.getAllAsync<{ name: string; pk: number }>(
        'PRAGMA table_info(poll_votes)'
      );
      const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name);
      if (pkCols.includes('option_index')) return; // state (B) — already migrated.
    } else if (v2Exists) {
      // State (D): recover — just rename and we're done.
      await database.execAsync('ALTER TABLE poll_votes_v2 RENAME TO poll_votes;');
      log.info('poll_votes_migrate_recovered_from_rename_gap');
      return;
    } else {
      // Neither table — fresh install path handled by CREATE TABLE IF NOT EXISTS elsewhere.
      return;
    }

    // States (A) and (C): do the migration inside a transaction so we
    // either finish cleanly or end up exactly where we started.
    await database.execAsync('BEGIN IMMEDIATE;');
    try {
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS poll_votes_v2 (
          message_id TEXT NOT NULL,
          voter_pub_b64 TEXT NOT NULL,
          option_index INTEGER NOT NULL,
          owner_profile_id INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (message_id, voter_pub_b64, option_index, owner_profile_id)
        );
        INSERT OR IGNORE INTO poll_votes_v2
          SELECT message_id, voter_pub_b64, option_index, owner_profile_id FROM poll_votes;
        DROP TABLE poll_votes;
        ALTER TABLE poll_votes_v2 RENAME TO poll_votes;
      `);
      await database.execAsync('COMMIT;');
    } catch (inner) {
      await database.execAsync('ROLLBACK;').catch(() => { /* ignore */ });
      throw inner;
    }
  } catch (e) {
    log.warn('poll_votes_migrate_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

async function tableExists(database: SQLite.SQLiteDatabase, name: string): Promise<boolean> {
  const row = await database.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?;",
    [name]
  );
  return (row?.n ?? 0) > 0;
}

async function ensureGroupMessageSeenByColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(group_messages)');
    if (!cols.some((c) => c.name === 'seen_by')) {
      await database.execAsync('ALTER TABLE group_messages ADD COLUMN seen_by TEXT');
    }
  } catch (e) {
    log.warn('group_message_seen_by_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** color_tag — цветовая метка чата для визуальной организации. */
async function ensureConversationColorTagColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(conversations)');
    if (!cols.some((c) => c.name === 'color_tag')) {
      await database.execAsync('ALTER TABLE conversations ADD COLUMN color_tag TEXT');
    }
  } catch (e) {
    log.warn('conversation_color_tag_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

async function ensureStoryMediaTypeColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(stories)');
    if (!cols.some((c) => c.name === 'media_type')) {
      await database.execAsync("ALTER TABLE stories ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'");
    }
  } catch (e) {
    log.warn('story_media_type_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

async function ensureGroupRequireApprovalColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'require_approval')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    log.warn('group_require_approval_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * v4.32.303: секрет пригласительной ссылки. Хранится только у тех, кто вправе
 * приглашать: у создателя группы и у администраторов, которым его прислали.
 * Лежит шифртекстом (см. AT_REST_COLUMNS) — это capability: кто прочитал
 * колонку, тот собрал действующую ссылку в группу.
 */
async function ensureGroupInviteTokenColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(groups)');
    if (!cols.some((c) => c.name === 'invite_token')) {
      await database.execAsync('ALTER TABLE groups ADD COLUMN invite_token TEXT');
    }
  } catch (e) {
    log.warn('group_invite_token_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

async function ensureScheduledGroupIdColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(scheduled_messages)');
    if (!cols.some((c) => c.name === 'group_id')) {
      await database.execAsync('ALTER TABLE scheduled_messages ADD COLUMN group_id TEXT');
    }
    if (!cols.some((c) => c.name === 'sender_name')) {
      await database.execAsync('ALTER TABLE scheduled_messages ADD COLUMN sender_name TEXT');
    }
  } catch (e) {
    log.warn('scheduled_group_id_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Приоритет доставки офлайн-очереди: больше — раньше при sync. */
async function ensureOutboxPriorityColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(outbox)');
    if (cols.some((c) => c.name === 'priority')) return;
    await database.execAsync('ALTER TABLE outbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    log.warn('outbox_priority_column_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * owner_profile_id в outbox — чтобы sync не обрабатывал чужие items после смены профиля.
 * NULL = legacy items (enqueued до v4.32.49) — sync обрабатывает как раньше (под активным профилем).
 */
async function ensureOutboxOwnerProfileColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(outbox)');
    if (cols.some((c) => c.name === 'owner_profile_id')) return;
    await database.execAsync('ALTER TABLE outbox ADD COLUMN owner_profile_id INTEGER');
  } catch (e) {
    log.warn('outbox_owner_profile_column_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * v4.32.124 (AUDIT P1 Block 7): `attempts` column на outbox — для cap'а retry.
 * Без этого item с "битым" payload/контактом крутился бесконечно и зря жрёт CPU/трафик.
 */
async function ensureOutboxAttemptsColumn(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(outbox)');
    if (cols.some((c) => c.name === 'attempts')) return;
    await database.execAsync('ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    log.warn('outbox_attempts_column_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Одноразовая миграция: plaintext → enc2 (поля text, media_cids, outbox.payload). */
async function ensureLocalCryptoMigration(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const flag = await database.getFirstAsync<{ v: string }>(
      'SELECT v FROM kv WHERE k = ?',
      [MIGRATED_KV]
    );
    if (flag?.v === 'true') return;

    const dek = await getOrCreateDataEncryptionKey();
    // v4.32.519: строка адресуется по rowid, а не по id. Этот проход идёт до
    // перевода ключа на составной, поэтому id здесь пока уникален — но так
    // правильность зависела бы от порядка миграций, а он меняется.
    const msgs = await database.getAllAsync<{
      rowid: number;
      text: string;
      media_cids: string | null;
    }>('SELECT rowid, text, media_cids FROM chat_messages');
    const outs = await database.getAllAsync<{ id: number; payload: string }>(
      'SELECT id, payload FROM outbox'
    );

    await database.execAsync('BEGIN IMMEDIATE');
    try {
      for (const m of msgs) {
        let t = m.text;
        if (!t.startsWith(AT_REST_PREFIX)) {
          t = encryptAtRestString(t, dek);
        }
        let mc: string | null = m.media_cids;
        if (mc !== null && !mc.startsWith(AT_REST_PREFIX)) {
          mc = encryptAtRestString(mc, dek);
        }
        if (t !== m.text || mc !== m.media_cids) {
          await database.runAsync(
            'UPDATE chat_messages SET text = ?, media_cids = ? WHERE rowid = ?',
            [t, mc, m.rowid],
          );
        }
      }
      for (const o of outs) {
        if (o.payload.startsWith(AT_REST_PREFIX)) continue;
        const p = encryptAtRestString(o.payload, dek);
        await database.runAsync('UPDATE outbox SET payload = ? WHERE id = ?', [p, o.id]);
      }
      await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
        MIGRATED_KV,
        'true',
      ]);
      await database.execAsync('COMMIT');
    } catch (e) {
      try {
        await database.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  } catch (e) {
    log.warn('local_crypto_migration_failed', { err: e instanceof Error ? e.message : String(e) });
    // Do not expose a writable database while a security-critical migration
    // may have left plaintext rows behind. The boot layer can surface retry.
    throw e;
  }
}

/**
 * v4.32.298. Разовый перевод имён участников групп в шифртекст.
 *
 * Перешифровка при смене DEK трогает только то, что УЖЕ зашифровано, — иначе
 * она приняла бы открытый текст за шифртекст под старым ключом. Значит, у
 * существующей установки состав всех групп так и остался бы открытым: строку
 * group_members переписывают, только когда участник вступает или меняет роль, а
 * в устоявшейся группе этого не происходит годами.
 *
 * Имя, которое уже с префиксом, не трогается: перешифровать его нечем — старого
 * ключа здесь нет, и второй проход дал бы enc2 поверх enc2.
 */
async function ensureGroupMemberNamesEncrypted(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const flag = await database.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [
      GROUP_MEMBER_NAMES_ENC_KV,
    ]);
    if (flag?.v === 'true') return;
    const rows = await database.getAllAsync<{
      group_id: string;
      peer_pub_b64: string;
      display_name: string | null;
      owner_profile_id: number;
    }>(
      'SELECT group_id, peer_pub_b64, display_name, owner_profile_id FROM group_members WHERE display_name IS NOT NULL'
    );
    const pending = rows.filter((r) => r.display_name && !r.display_name.startsWith(AT_REST_PREFIX));
    if (pending.length > 0) {
      const dek = await getOrCreateDataEncryptionKey();
      await database.execAsync('BEGIN IMMEDIATE');
      try {
        for (const r of pending) {
          await database.runAsync(
            'UPDATE group_members SET display_name = ? WHERE group_id = ? AND peer_pub_b64 = ? AND owner_profile_id = ?',
            [encryptAtRestString(r.display_name as string, dek), r.group_id, r.peer_pub_b64, r.owner_profile_id]
          );
        }
        await database.execAsync('COMMIT');
      } catch (e) {
        try {
          await database.execAsync('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw e;
      }
    }
    await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
      GROUP_MEMBER_NAMES_ENC_KV,
      'true',
    ]);
    log.info('group_member_names_encrypted', { migrated: pending.length });
  } catch (e) {
    // Без отметки в kv попытка повторится при следующем запуске — это лучше,
    // чем оставить состав групп открытым и считать дело сделанным.
    log.warn('group_member_names_encrypt_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/**
 * v4.32.302. Разовый перевод реакций и списка прочитавших в шифртекст.
 *
 * Текст сообщения шифровался с самого начала, а рядом с ним открытым текстом
 * лежало: `reactions` — какой эмодзи и чьим ключом поставлен на какое
 * сообщение, и `seen_by` — кто и что в группе прочитал. Сообщения по этим
 * колонкам не восстановить, зато восстанавливается то, ради чего переписку и
 * прячут: кто с кем общается, кто в разговоре живой, а кто молча читает. У
 * сторис ровно этот же список зовётся `viewed_by` и шифруется с v4.32.279 —
 * здесь просто не заметили, что данные те же самые.
 *
 * Как и с именами участников: перешифровка при смене DEK трогает только уже
 * зашифрованное, поэтому без разового прохода старые реакции остались бы
 * открытыми навсегда — строку переписывают лишь при следующем нажатии.
 *
 * Пустые значения ('{}', '[]') пропускаются: шифровать в них нечего, а лишняя
 * запись — это лишний риск на миграции с тысячами строк.
 */
type PlainColumnSpec = { table: string; column: string; keys: readonly string[] };

/**
 * v4.32.304: общий разовый проход «колонку начали шифровать — переведи то, что
 * уже лежит открытым». Отмечается флагом в kv и второй раз не запускается.
 *
 * Вынесен из ensureMessageSocialColumnsEncrypted, когда понадобился третий раз
 * подряд (реакции, состав групп, теперь отложенные сообщения). Флаг у каждого
 * вызова свой: добавить колонку в чужой список бесполезно — у существующей
 * установки тот флаг давно 'true', и проход не повторится.
 *
 * Пустые значения ('', '{}', '[]') пропускаются: шифровать в них нечего, а
 * лишняя запись — лишний риск на миграции с тысячами строк. Значение с
 * префиксом enc2: не трогается — второй проход дал бы enc2 поверх enc2, и это
 * читалось бы наружу как «enc2:…» вместо содержимого.
 */
async function encryptPlainColumnsOnce(
  database: SQLite.SQLiteDatabase,
  flagKey: string,
  specs: ReadonlyArray<PlainColumnSpec>,
  logName: string
): Promise<void> {
  try {
    const flag = await database.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [
      flagKey,
    ]);
    if (flag?.v === 'true') return;
    let migrated = 0;
    for (const spec of specs) {
      const rows = await database.getAllAsync<Record<string, string | number | null>>(
        `SELECT ${spec.keys.join(', ')}, ${spec.column} AS value FROM ${spec.table}
         WHERE ${spec.column} IS NOT NULL AND ${spec.column} NOT IN ('', '{}', '[]')
           AND ${spec.column} NOT LIKE 'enc2:%'`
      );
      if (rows.length === 0) continue;
      const dek = await getOrCreateDataEncryptionKey();
      const whereSql = spec.keys.map((k) => `${k} = ?`).join(' AND ');
      await database.execAsync('BEGIN IMMEDIATE');
      try {
        for (const r of rows) {
          await database.runAsync(
            `UPDATE ${spec.table} SET ${spec.column} = ? WHERE ${whereSql}`,
            [
              encryptAtRestString(String(r.value), dek),
              ...spec.keys.map((k) => r[k] as string | number),
            ]
          );
        }
        await database.execAsync('COMMIT');
      } catch (e) {
        try {
          await database.execAsync('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw e;
      }
      migrated += rows.length;
    }
    await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [flagKey, 'true']);
    log.info(`${logName}_encrypted`, { migrated });
  } catch (e) {
    // Отметки в kv нет — значит, попытка повторится на следующем запуске. Это
    // лучше, чем оставить данные открытыми и считать дело сделанным.
    log.warn(`${logName}_encrypt_failed`, { err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * v4.32.302. Разовый перевод реакций и списка прочитавших в шифртекст.
 *
 * Текст сообщения шифровался с самого начала, а рядом с ним открытым текстом
 * лежало: `reactions` — какой эмодзи и чьим ключом поставлен на какое
 * сообщение, и `seen_by` — кто и что в группе прочитал. Сообщения по этим
 * колонкам не восстановить, зато восстанавливается то, ради чего переписку и
 * прячут: кто с кем общается, кто в разговоре живой, а кто молча читает. У
 * сторис ровно этот же список зовётся `viewed_by` и шифруется с v4.32.279 —
 * здесь просто не заметили, что данные те же самые.
 *
 * Как и с именами участников: перешифровка при смене DEK трогает только уже
 * зашифрованное, поэтому без разового прохода старые реакции остались бы
 * открытыми навсегда — строку переписывают лишь при следующем нажатии.
 */
function ensureMessageSocialColumnsEncrypted(database: SQLite.SQLiteDatabase): Promise<void> {
  return encryptPlainColumnsOnce(
    database,
    MESSAGE_SOCIAL_ENC_KV,
    [
      // v4.32.519: профиль в ключе. Один id теперь встречается в нескольких
      // строках, и без него реакции первого профиля переписывали строку
      // второго — а на второй итерации значение уже начиналось с enc2: и
      // пропускалось, так что чужие реакции оставались там навсегда.
      { table: 'chat_messages', column: 'reactions', keys: ['id', 'owner_profile_id'] },
      { table: 'group_messages', column: 'reactions', keys: ['id', 'owner_profile_id'] },
      { table: 'group_messages', column: 'seen_by', keys: ['id', 'owner_profile_id'] },
    ],
    'message_social_columns'
  );
}

/**
 * v4.32.304. Разовый перевод имени отправителя отложенного сообщения в шифртекст.
 *
 * В v4.32.283 у scheduled_messages зашифровали `text` и `media_cids` — ровно с
 * той мыслью, что отложенное сообщение это уже написанный текст, и лежит он тем
 * дольше, чем дальше отложен. Колонку `sender_name` завели позже, вместе с
 * `group_id`, и шифровать её забыли. В итоге строка выглядела так: содержимое —
 * шифртекст, а рядом открытым текстом «в группу g-… напишет Аня», и это
 * единственная во всей базе колонка с именем, оставшаяся открытой после
 * v4.32.298.
 *
 * Особенно упрямая: строку отложенного сообщения не переписывают вообще
 * никогда — её создают и удаляют. Без разового прохода имя осталось бы
 * открытым до самой отправки.
 */
function ensureScheduledSenderNameEncrypted(database: SQLite.SQLiteDatabase): Promise<void> {
  return encryptPlainColumnsOnce(
    database,
    SCHEDULED_SENDER_ENC_KV,
    [{ table: 'scheduled_messages', column: 'sender_name', keys: ['id'] }],
    'scheduled_sender_name'
  );
}

/**
 * v4.32.304. Разовый перевод аватара группы в шифртекст.
 *
 * `groups.avatar_cid` — не всегда IPFS-CID. На телефоне IPFS выключен, поэтому
 * аватар уходит обычным зашифрованным вложением, а в колонку ложится
 * `nb:`-дескриптор — и он НЕСЁТ КЛЮЧ РАСШИФРОВКИ файла (blobRef.ts, там же это
 * записано как правило: `nb:` допустим только внутри уже зашифрованного
 * конверта). Открывший файл БД скачивал аватар группы и расшифровывал его, ни
 * к чему не подбирая ключ, — при том что название группы в соседней колонке
 * лежало шифртекстом. Ровно то же основание, по которому в v4.32.286
 * зашифровали строку контакта: там аргументом был тот же avatarCid.
 */
function ensureGroupAvatarCidEncrypted(database: SQLite.SQLiteDatabase): Promise<void> {
  return encryptPlainColumnsOnce(
    database,
    GROUP_AVATAR_ENC_KV,
    [{ table: 'groups', column: 'avatar_cid', keys: ['id', 'owner_profile_id'] }],
    'group_avatar_cid'
  );
}

/** Какие из нужных колонок реально есть в этой БД — старые установки отстают по схеме. */
async function existingColumnsOf(
  database: SQLite.SQLiteDatabase,
  table: string,
  wanted: readonly string[]
): Promise<string[]> {
  if (wanted.length === 0) return [];
  try {
    const info = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
    const have = new Set(info.map((c) => c.name));
    return wanted.filter((c) => have.has(c));
  } catch {
    return [];
  }
}

/**
 * Перешифровать всё содержимое БД с ключа `from` на ключ `to`.
 * Вызывается внутри уже открытой транзакции.
 *
 * Значение, которое не расшифровалось старым ключом, остаётся нетронутым:
 * записать на его место пустую строку значило бы стереть сообщение, и уже
 * необратимо — после миграции старого ключа не останется.
 */
async function reencryptAtRest(
  database: SQLite.SQLiteDatabase,
  from: Uint8Array,
  to: Uint8Array
): Promise<void> {
  for (const spec of AT_REST_COLUMNS) {
    const cols = await existingColumnsOf(database, spec.table, spec.columns);
    if (cols.length === 0) continue;
    const rows = await database.getAllAsync<Record<string, string | number | null>>(
      `SELECT rowid AS at_rest_rowid, ${cols.join(', ')} FROM ${spec.table}`
    );
    for (const r of rows) {
      const sets: string[] = [];
      const vals: Array<string | number> = [];
      for (const c of cols) {
        const cur = r[c];
        if (typeof cur !== 'string' || !cur.startsWith(AT_REST_PREFIX)) continue;
        const plain = tryDecryptAtRest(cur, from);
        if (plain == null) continue;
        sets.push(`${c} = ?`);
        vals.push(encryptAtRestString(plain, to));
      }
      if (sets.length === 0) continue;
      vals.push(r.at_rest_rowid as number);
      await database.runAsync(
        `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE rowid = ?`,
        vals
      );
    }
  }
  // kv: секретные ключи пишет kvSetSecret, и их состав меняется от версии к
  // версии (журнал звонков, заметки, корзины). Поэтому отбор по признаку
  // шифртекста, а не по списку имён — список успел бы устареть. Настройки
  // лежат открытым текстом и под условие не попадают.
  const kvRows = await database.getAllAsync<{ k: string; v: string }>(
    'SELECT k, v FROM kv WHERE v LIKE ?',
    [`${AT_REST_PREFIX}%`]
  );
  for (const row of kvRows) {
    const plain = tryDecryptAtRest(row.v, from);
    if (plain == null) continue;
    await database.runAsync('UPDATE kv SET v = ? WHERE k = ?', [encryptAtRestString(plain, to), row.k]);
  }
  // v4.32.341: у байтов вложений ленты свой кодек и свой префикс (см.
  // inlineBlobCrypto), и под условие enc2 выше они не попадают. Без этого
  // прохода смена ключа оставила бы их зашифрованными старым — то есть все
  // фотографии и документы в ленте стали бы нечитаемы разом и навсегда.
  const inlineRows = await database.getAllAsync<{ k: string; v: string }>(
    'SELECT k, v FROM kv WHERE v LIKE ?',
    [`${INLINE_BLOB_PREFIX}%`]
  );
  for (const row of inlineRows) {
    const moved = reencryptInlineBlob(row.v, from, to);
    if (moved == null) continue;
    await database.runAsync('UPDATE kv SET v = ? WHERE k = ?', [moved, row.k]);
  }
}

/**
 * Случайный DEK → детерминированный из seed (после обновления можно восстановить DEK из мнемоники).
 * Должен выполняться до loadKeyPair() (см. ensureLocalStorageReadyForBoot).
 */
async function migrateDekRandomToDeterministic(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const done = await database.getFirstAsync<{ v: string }>(
      'SELECT v FROM kv WHERE k = ?',
      [DEK_MIGRATED_KV]
    );
    if (done?.v === 'true') return;

    // Avoid loading the seed module when this installation has never stored a
    // wallet. Besides keeping boot cheap, this lets the migration remain a
    // no-op in runtimes where dynamic imports are unavailable during tests.
    // A SecureStore read failure still propagates to the fail-closed handler.
    const hasMnemonicPayload = Boolean(
      (await SecureStore.getItemAsync('airchat_seed_mnemonic_enc_v2'))
      || (await SecureStore.getItemAsync('airchat_seed_mnemonic_v1'))
      || (await SecureStore.getItemAsync('airchat_seed'))
    );
    if (!hasMnemonicPayload) {
      await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
        DEK_MIGRATED_KV,
        'true',
      ]);
      return;
    }

    const { getStoredMnemonic } = await import('../backup/seedPhrase');
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic?.trim()) {
      await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
        DEK_MIGRATED_KV,
        'true',
      ]);
      return;
    }

    const derived = deriveLocalDekFromMnemonic(mnemonic);
    const b64 = await SecureStore.getItemAsync(DEK_KEY);
    if (!b64) {
      // v4.32.520: ключа в хранилище нет — но канарейка помнит, каким ключом
      // зашифрованы данные. Если она есть и выведенным из seed не открывается,
      // значит на диске лежит переписка под другим, уже потерянным ключом.
      // Записать сюда derived значило бы закрепить потерю: читаться всё станет
      // пустыми строками, а первая же реакция перетрёт шифртекст этой пустотой.
      if ((await canaryOpensWith(derived)) === false) {
        throw new Error('dek canary rejects seed-derived key');
      }
      await persistDek(derived);
      await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
        DEK_MIGRATED_KV,
        'true',
      ]);
      return;
    }

    const stored = new Uint8Array(Buffer.from(b64, 'base64'));
    if (bytesEqualConstTime(stored, derived)) {
      // persistDek вместо setDekMemory: ключ тот же, а канарейки у такой
      // установки может ещё не быть — заодно и заведём.
      await persistDek(derived);
      await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
        DEK_MIGRATED_KV,
        'true',
      ]);
      return;
    }

    // v4.32.520: прежде чем перешифровывать, спрашиваем канарейку, тем ли
    // ключом зашифрованы данные. Если stored им не является, reencryptAtRest не
    // расшифрует ни одной строки — tryDecryptAtRest вернёт null, и каждая
    // будет пропущена, — после чего мы объявим действующим derived, и вся база
    // останется под третьим, уже никому не известным ключом.
    const opensStored = await canaryOpensWith(stored);
    if (opensStored === false) {
      if ((await canaryOpensWith(derived)) !== true) {
        throw new Error('dek canary matches neither stored nor derived key');
      }
      // Данные уже под derived: переносить нечего, надо лишь закрепить ключ.
      await persistDek(derived);
      await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
        DEK_MIGRATED_KV,
        'true',
      ]);
      return;
    }

    const { rewrapSecretKeyWithDek } = await import('../crypto/keyManager');

    await database.execAsync('BEGIN IMMEDIATE');
    try {
      await reencryptAtRest(database, stored, derived);
      await database.execAsync('COMMIT');
    } catch (e) {
      try {
        await database.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }

    await rewrapSecretKeyWithDek(stored, derived);
    await persistDek(derived);

    await database.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
      DEK_MIGRATED_KV,
      'true',
    ]);
  } catch (e) {
    log.warn('dek_random_to_deterministic_failed', { err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    if (dbOpenError !== null && Date.now() - dbOpenFailedAt < DB_REOPEN_COOLDOWN_MS) throw dbOpenError;
    // v4.32.581: открытие идёт через аренду. На телефоне это просто очередь
    // операторов; в браузере — ещё и выбор вкладки-держателя: OPFS отдаёт файл
    // базы одной вкладке на всё происхождение, и раньше вторая вкладка не
    // запускалась вовсе. Всё, что ниже, — миграции — выполняет только
    // держатель и только по разу: просителю отдаётся уже готовая база.
    const attempt = openLeasedDatabase(LOCAL_DB_NAME, async () => {
      const database = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);
      await initSchema(database);
      await ensureChatMessagesOwnerProfileColumn(database);
      await ensureOutboxPriorityColumn(database);
      await ensureOutboxOwnerProfileColumn(database);
      await ensureOutboxAttemptsColumn(database);
      await ensureReplyToColumns(database);
      await ensureMessageExtraColumns(database);
      await ensureConversationPinnedMessageColumn(database);
      await ensureStoryAlbumMediaCidColumn(database);
      await ensureGroupPinnedMessageColumns(database);
      await ensureGroupSenderNameColumn(database);
      await ensureGroupMessageEditedAtColumn(database);
      await ensureGroupMentionCountColumn(database);
      await ensureGroupDraftTextColumn(database);
      await ensureGroupDisappearAfterMsColumn(database);
      await ensureScheduledGroupIdColumn(database);
      await ensureGroupAdminOnlyPostingColumn(database);
      await ensureGroupRequireApprovalColumn(database);
      await ensureGroupInviteTokenColumn(database);
      await ensureGroupAnonymousPostingColumn(database);
      await ensureGroupAdminOnlyPinningColumn(database);
      await ensureGroupMessageViewCountColumn(database);
      await ensureMutedUntilColumn(database);
      await ensureStarredColumns(database);
      await ensureMessageTransportColumn(database);
      await migrateDekRandomToDeterministic(database);
      await ensureLocalCryptoMigration(database);
      await ensureStoryMediaTypeColumn(database);
      await ensureConversationColorTagColumn(database);
      await ensureGroupMessageSeenByColumn(database);
      await ensurePollVotesMultipleChoice(database);
      // До ensureGroupMemberNamesEncrypted: тот пишет в group_members, а здесь
      // таблица пересобирается целиком — иначе правки достались бы копии.
      // Порядок важен: состав берёт профиль у groups, значит groups к этому
      // моменту уже должна быть в своём окончательном виде.
      await ensureGroupsProfileScopedKey(database);
      await ensureGroupMembersProfileScoped(database);
      // До ensureMessageSocialColumnsEncrypted: тот правит строки по ключу, и
      // ключ к этому моменту обязан быть уже составным — иначе он писал бы
      // реакции одного профиля поверх строки другого.
      await ensureChatMessagesProfileScopedKey(database);
      await ensureGroupMessagesProfileScopedKey(database);
      // После ensureLocalCryptoMigration: тот тоже берёт DEK, и порядок здесь
      // тот же — сперва ключ определён, потом им что-то шифруется.
      await ensureGroupMemberNamesEncrypted(database);
      await ensureMessageSocialColumnsEncrypted(database);
      await ensureScheduledSenderNameEncrypted(database);
      await ensureGroupAvatarCidEncrypted(database);
      return database;
    });
    dbPromise = attempt;
    // Отказ разбирается здесь же, иначе он остался бы необработанным.
    void attempt.then(
      () => {
        dbOpenError = null;
      },
      (e: unknown) => {
        log.warn('local_db_open_failed', { err: e instanceof Error ? e.message : String(e) });
        if (dbPromise === attempt) dbPromise = null;
        dbOpenError = e;
        dbOpenFailedAt = Date.now();
      }
    );
  }
  return dbPromise;
}

// v4.32.301: getLocalDb (сырой доступ к базе «для GroupChatScreen и
// ChatsListScreen») удалён — оба экрана давно не существуют, а вызвавший его
// получил бы строки в обход шифрования at-rest: на чтении — ciphertext «enc2:»
// вместо текста, на записи — открытый текст в зашифрованной колонке. Работать с
// базой следует через функции этого модуля.

/** Открыть SQLite и прогнать миграции шифрования до чтения ключей (обновление без потери сессии). */
export async function ensureLocalStorageReadyForBoot(): Promise<void> {
  await db();
}

/** Close the local database and reset its in-memory connection state. */
export async function closeLocalDatabase(): Promise<void> {
  try {
    if (dbPromise) {
      const d = await dbPromise;
      try {
        await d.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // The close below still releases the connection if checkpoint is unavailable.
      }
      await d.closeAsync();
    }
  } catch (e) {
    log.warn('local_db_close_before_wipe', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  dbPromise = null;
  // База уходит целиком, значит и прошлый отказ к ней больше не относится:
  // следующее обращение должно пробовать сразу, не выжидая паузу.
  dbOpenError = null;
  dbOpenFailedAt = 0;
}

export type SyncStateRow = {
  ownerProfileId: number;
  cursor: string | null;
  serverEpoch: string | null;
  lastPullAt: number | null;
  lastPushAt: number | null;
};

function validSyncProfileId(ownerProfileId: number): boolean {
  return Number.isSafeInteger(ownerProfileId) && ownerProfileId > 0;
}

function validSyncCursor(cursor: string | null): boolean {
  return cursor === null || (/^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor)));
}

/** Read server cursor metadata; this table is cache metadata, not account content. */
export async function getSyncState(ownerProfileId: number): Promise<SyncStateRow> {
  if (!validSyncProfileId(ownerProfileId)) throw new Error('Invalid sync profile id');
  const row = await (await db()).getFirstAsync<{
    owner_profile_id: number;
    cursor: string | null;
    server_epoch: string | null;
    last_pull_at: number | null;
    last_push_at: number | null;
  }>('SELECT owner_profile_id, cursor, server_epoch, last_pull_at, last_push_at FROM sync_state WHERE owner_profile_id = ?', [ownerProfileId]);
  return {
    ownerProfileId,
    cursor: row?.cursor ?? null,
    serverEpoch: row?.server_epoch ?? null,
    lastPullAt: row?.last_pull_at ?? null,
    lastPushAt: row?.last_push_at ?? null,
  };
}

/** Advance sync metadata only after the corresponding network operation succeeds. */
export async function saveSyncState(
  ownerProfileId: number,
  patch: Partial<Omit<SyncStateRow, 'ownerProfileId'>>,
): Promise<void> {
  if (!validSyncProfileId(ownerProfileId)) throw new Error('Invalid sync profile id');
  if (patch.cursor !== undefined && !validSyncCursor(patch.cursor)) throw new Error('Invalid sync cursor');
  if (patch.serverEpoch !== undefined && patch.serverEpoch !== null
    && (typeof patch.serverEpoch !== 'string' || patch.serverEpoch.length === 0 || patch.serverEpoch.length > 128)) {
    throw new Error('Invalid sync server epoch');
  }
  for (const value of [patch.lastPullAt, patch.lastPushAt]) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('Invalid sync timestamp');
    }
  }
  const current = await getSyncState(ownerProfileId);
  await (await db()).runAsync(`
    INSERT INTO sync_state (owner_profile_id, cursor, server_epoch, last_pull_at, last_push_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (owner_profile_id) DO UPDATE SET
      cursor = excluded.cursor,
      server_epoch = excluded.server_epoch,
      last_pull_at = excluded.last_pull_at,
      last_push_at = excluded.last_push_at
  `, [
    ownerProfileId,
    patch.cursor !== undefined ? patch.cursor : current.cursor,
    patch.serverEpoch !== undefined ? patch.serverEpoch : current.serverEpoch,
    patch.lastPullAt !== undefined ? patch.lastPullAt : current.lastPullAt,
    patch.lastPushAt !== undefined ? patch.lastPushAt : current.lastPushAt,
  ]);
}

export type SyncEntityHead = {
  entityKind: string;
  entityId: string;
  ownerProfileId: number;
  revision: number;
  fingerprint: string | null;
  deleted: boolean;
  updatedAt: number;
};

/** Read local projection heads without exposing entity payloads. */
export async function getSyncEntityHeads(ownerProfileId: number): Promise<SyncEntityHead[]> {
  if (!validSyncProfileId(ownerProfileId)) throw new Error('Invalid sync profile id');
  const rows = await (await db()).getAllAsync<{
    entity_kind: string;
    entity_id: string;
    owner_profile_id: number;
    revision: number;
    fingerprint: string | null;
    deleted: number;
    updated_at: number;
  }>(
    `SELECT entity_kind, entity_id, owner_profile_id, revision, fingerprint, deleted, updated_at
       FROM sync_entity_heads
      WHERE owner_profile_id = ?`,
    [ownerProfileId],
  );
  return rows.map((row) => ({
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    ownerProfileId: row.owner_profile_id,
    revision: row.revision,
    fingerprint: row.fingerprint,
    deleted: row.deleted === 1,
    updatedAt: row.updated_at,
  }));
}

/**
 * Забыть, что сервер уже видел эти записи (v4.32.595).
 *
 * Нужно ровно в одном случае: серверная копия аккаунта заведена заново.
 * Головы — это утверждение «там уже лежит», и после потери серверной копии
 * оно ложно; удаление возвращает сборщик отправки к полному объёму, а сами
 * данные лежат в своих таблицах и не трогаются.
 */
export async function clearSyncEntityHeads(ownerProfileId: number): Promise<void> {
  if (!validSyncProfileId(ownerProfileId)) throw new Error('Invalid sync profile id');
  await (await db()).runAsync('DELETE FROM sync_entity_heads WHERE owner_profile_id = ?', [ownerProfileId]);
}

/** Persist only heads confirmed by a successful push or pull projection. */
export async function saveSyncEntityHeads(heads: readonly SyncEntityHead[]): Promise<void> {
  if (heads.length === 0) return;
  for (const head of heads) {
    if (!validSyncProfileId(head.ownerProfileId)
      || typeof head.entityKind !== 'string' || !/^[a-z_]{1,32}$/.test(head.entityKind)
      || typeof head.entityId !== 'string' || head.entityId.length < 1 || head.entityId.length > 256
      || !Number.isSafeInteger(head.revision) || head.revision < 1
      || (head.fingerprint !== null && (typeof head.fingerprint !== 'string' || head.fingerprint.length > 128))
      || typeof head.deleted !== 'boolean'
      || !Number.isSafeInteger(head.updatedAt) || head.updatedAt < 0) {
      throw new Error('Invalid sync entity head');
    }
  }
  const d = await db();
  await d.execAsync('BEGIN IMMEDIATE');
  try {
    for (const head of heads) {
      await d.runAsync(
        `INSERT INTO sync_entity_heads
           (entity_kind, entity_id, owner_profile_id, revision, fingerprint, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (entity_kind, entity_id, owner_profile_id) DO UPDATE SET
           revision = excluded.revision,
           fingerprint = excluded.fingerprint,
           deleted = excluded.deleted,
           updated_at = excluded.updated_at
         WHERE excluded.revision >= sync_entity_heads.revision`,
        [
          head.entityKind,
          head.entityId,
          head.ownerProfileId,
          head.revision,
          head.fingerprint,
          head.deleted ? 1 : 0,
          head.updatedAt,
        ],
      );
    }
    await d.execAsync('COMMIT');
  } catch (error) {
    try { await d.execAsync('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

/** Закрыть и удалить локальную БД (чаты, kv, outbox) — при выходе из аккаунта. */
export async function wipeLocalDatabase(): Promise<void> {
  await closeLocalDatabase();
  const databaseUris = [
    `${FileSystem.documentDirectory ?? ''}SQLite/${LOCAL_DB_NAME}`,
    `${FileSystem.documentDirectory ?? ''}SQLite/${LOCAL_DB_NAME}-wal`,
    `${FileSystem.documentDirectory ?? ''}SQLite/${LOCAL_DB_NAME}-shm`,
  ].filter(Boolean);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await SQLite.deleteDatabaseAsync(LOCAL_DB_NAME);
    } catch (e) {
      lastError = e;
      log.warn('local_db_delete_failed', {
        attempt: attempt + 1,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    let remains = false;
    for (const uri of databaseUris) {
      try {
        if ((await FileSystem.getInfoAsync(uri)).exists) {
          remains = true;
          break;
        }
      } catch (e) {
        lastError = e;
        remains = true;
        break;
      }
    }
    if (!remains) return;
  }
  throw new Error(
    `Локальная база не удалена${lastError instanceof Error ? `: ${lastError.message}` : ''}`
  );
}

export async function profileKvGet(profileId: number, key: string): Promise<string | null> {
  return kvGet(profileScopedKey(profileId, key));
}

export async function profileKvSet(profileId: number, key: string, value: string): Promise<void> {
  return kvSet(profileScopedKey(profileId, key), value);
}

/**
 * v4.32.126 (AUDIT P2): storage-pressure observer.
 * До этого `kv_set_failed` / `outbox_enqueue_failed` молча писались в лог и
 * UI никогда не узнавал, что диск переполнен — сообщения, drafts, новые
 * контакты тихо пропадали. Теперь любой writer ловит известные «out of
 * space» сигнатуры от SQLite и вызывает `notifyStoragePressure()`.
 * UI (SettingsScreen / Toast) может подписаться через
 * `subscribeStoragePressure()` и показать пользователю баннер с призывом
 * освободить место.
 */
export type StoragePressureListener = (kind: StoragePressureKind, context: string) => void;
const storagePressureListeners = new Set<StoragePressureListener>();

export function subscribeStoragePressure(cb: StoragePressureListener): () => void {
  storagePressureListeners.add(cb);
  return () => {
    storagePressureListeners.delete(cb);
  };
}

/**
 * v4.32.300: разбор подписи ошибки переехал в storage/storagePressure — он
 * зависит от платформы, а не от SQLite, и проверяется тестами. Там же правила
 * показа предупреждения на экране.
 */
function notifyIfStoragePressure(e: unknown, context: string): void {
  const kind = classifyStorageError(e);
  if (kind) notifyStoragePressure(kind, context);
}

function notifyStoragePressure(kind: StoragePressureKind, context: string): void {
  for (const cb of [...storagePressureListeners]) {
    try {
      cb(kind, context);
    } catch {
      /* ignore */
    }
  }
}

/**
 * v4.32.474: чтение, у которого провал отличим от «ключа нет».
 *
 * Разница не косметическая — на ней стоят решения о приватности. Отсутствие
 * записи означает «человек переключатель не трогал», и тогда применяется
 * общее правило по умолчанию. Заблокированная база означает «мы не знаем, что
 * он выбрал», и там правильный ответ другой: осторожный. kvGet отвечает на оба
 * случая одинаково — null, — поэтому написанные у вызывающих ветки «не смогли
 * прочитать» не исполнялись ни разу, а решение всякий раз выпадало в сторону
 * «разрешено». Кому ошибка чтения безразлична — тому по-прежнему kvGet.
 *
 * Возвращает `{ value }` при успешном чтении (value может быть null) и `null`,
 * если прочитать не удалось.
 */
export async function kvTryGet(key: string): Promise<{ value: string | null } | null> {
  try {
    // v4.32.17: timing для диагностики SQLite lock contention (2.2с блоки).
    const _t0 = Date.now();
    const d = await db();
    const row = await d.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [key]);
    const _dt = Date.now() - _t0;
    if (_dt > 150) log.info('ui_kv_get_slow', { key, ms: _dt });
    return { value: row?.v ?? null };
  } catch (e) {
    log.warn('kv_get_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function kvGet(key: string): Promise<string | null> {
  return (await kvTryGet(key))?.value ?? null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  await kvSetChecked(key, value);
}

/**
 * Как kvSet, но сообщает, легло ли значение.
 *
 * v4.32.341: kvSet гасит собственную ошибку и возвращает void — правильно для
 * настроек, но не для того, кто на записи строит откат. В publishPost попытка
 * записи вложений обёрнута в try/catch с откатом уже сохранённого поста, и
 * catch не срабатывал никогда: бросать было нечему. Пост оставался в базе с
 * записью о фотографии, которой на диске нет, — ровно то, что этот откат и
 * должен был предотвращать.
 */
export async function kvSetChecked(key: string, value: string): Promise<boolean> {
  try {
    // v4.32.17: timing для диагностики SQLite lock contention (2.2с блоки).
    const _t0 = Date.now();
    const d = await db();
    await d.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [key, value]);
    const _dt = Date.now() - _t0;
    if (_dt > 150) log.info('ui_kv_set_slow', { key, ms: _dt, bytes: value.length });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('kv_set_failed', { err: msg });
    // v4.32.126 (AUDIT P2): surface SQLITE_FULL / ENOSPC to UI so banner
    // can prompt user to free disk space. Previously silent → data loss.
    notifyIfStoragePressure(e, 'kv_set');
    return false;
  }
}

/**
 * Байты вложения ленты (`feed_inline_media:*`, `feed_inline_doc:*`).
 *
 * v4.32.341: лежали открытым base64, пока текст того же поста лежал под enc2 —
 * см. inlineBlobCrypto о том, почему у них свой кодек, а не общий kvSetSecret.
 *
 * Записанное до этой версии дошифровывается при первом же чтении: признак «ещё
 * не зашифровано» несёт сама строка, отдельный флаг миграции не нужен и был бы
 * хуже — он не догнал бы запись, пришедшую позже из восстановленной копии.
 * Не получилось переписать — вложение всё равно отдаётся, следующее чтение
 * попробует снова; хуже провал не делает, открытым остаётся ровно то, что там
 * и так лежало.
 */
export async function kvGetInlineAttachment(key: string): Promise<string | null> {
  const stored = await kvGet(key);
  if (stored == null) return null;
  try {
    const dek = await getOrCreateDataEncryptionKey();
    if (!isInlineBlobEncrypted(stored)) {
      await kvSetChecked(key, encodeInlineBlob(stored, dek));
      return stored;
    }
    return decodeInlineBlob(stored, dek);
  } catch (e) {
    log.warn('kv_inline_get_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Возвращает, легло ли вложение. Открытым текстом взамен не пишем никогда. */
export async function kvSetInlineAttachment(key: string, base64: string): Promise<boolean> {
  try {
    const dek = await getOrCreateDataEncryptionKey();
    return await kvSetChecked(key, encodeInlineBlob(base64, dek));
  } catch (e) {
    log.warn('kv_inline_set_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * kv для содержимого переписки.
 *
 * v4.32.276: таблица kv — обычный plaintext, и это правильно для настроек, но
 * в неё складывается «недавно удалённое»: полный текст удалённых сообщений на
 * 30 дней в личной переписке и на 7 дней в группе. Тот же текст в
 * chat_messages/group_messages лежит под enc2, то есть удаление сообщения
 * ухудшало его защиту вместо того, чтобы её усилить: строка исчезала из
 * зашифрованной колонки и появлялась в открытой.
 *
 * Ключ тот же общий DEK, что и у сообщений: отдельный ничего не добавил бы —
 * оба лежат в одной БД и открываются одним и тем же секретом из хранилища
 * ключей устройства.
 *
 * Старые записи читаются как есть: decryptAtRestString пропускает строку без
 * префикса насквозь. Отдельная миграция не нужна — корзина перезаписывается
 * целиком при первом же удалении или восстановлении, и переживать ошибку
 * миграции ради семидневного списка незачем.
 */
/**
 * Ключи корзины «недавно удалённые». Собираются здесь, а не по месту: их надо
 * знать и экрану переписки, и очистке истории, а разъехавшийся литерал
 * означал бы корзину, которую «Очистить историю» не находит и не стирает.
 *
 * Возвращают ключ БЕЗ префикса профиля. Обращаться к ним надо через
 * kvGetSecretScoped / kvSetSecretScoped / kvDeleteScoped — см. v4.32.278 ниже.
 */
export function recentlyDeletedKey(contactPubB64: string): string {
  return `recently_deleted_${contactPubB64}`;
}

export function recentlyDeletedGroupKey(groupId: string): string {
  return `recently_deleted_grp_${groupId}`;
}

/** Личная заметка о контакте — та же история, что и у корзины. */
export function contactNoteKey(contactPubB64: string): string {
  return `contact_note_${contactPubB64}`;
}

/**
 * v4.32.552: то же чтение, но с различением «пусто» и «не открылось».
 *
 * Нужно всем, кто читает запись, чтобы её дополнить и записать обратно: там
 * пустая строка от `decryptAtRestString` означала «прежнего не было» и уходила
 * в базу поверх чужого шифртекста. Недоступный DEK тоже даёт `unreadable`, а
 * не «пусто»: не открыв запись, разрешать её перезапись нельзя.
 */
export async function kvGetSecretCell(key: string): Promise<AtRestCell> {
  const stored = await kvGet(key);
  if (stored == null) return classifyAtRestCell(null, null);
  try {
    const dek = await getOrCreateDataEncryptionKey();
    return readAtRestCell(stored, dek);
  } catch (e) {
    log.warn('kv_get_secret_failed', { err: e instanceof Error ? e.message : String(e) });
    return classifyAtRestCell(stored, null);
  }
}

export async function kvGetSecret(key: string): Promise<string | null> {
  return cellTextOrNull(await kvGetSecretCell(key));
}

/**
 * Возвращает, записалось ли. Открытым текстом вместо шифртекста не пишем:
 * молчаливый откат к прежнему поведению — ровно та дыра, которую эта пара
 * функций и закрывает. Но и промолчать о том, что не записалось, нельзя:
 * v4.32.293 — вызывающий, который на этом строит перенос или кэш, обязан
 * узнать о провале (см. kvGetSecretScoped ниже: он удалял исходную запись,
 * не проверив, легла ли копия).
 */
export async function kvSetSecret(key: string, value: string): Promise<boolean> {
  try {
    const dek = await getOrCreateDataEncryptionKey();
    // v4.32.435: именно kvSetChecked. Через kvSet ответ был всегда «легло»:
    // kvSet гасит ошибку записи и возвращает void, а этот try/catch ловил бы
    // только провал шифрования. То есть три места, которые с v4.32.293
    // удаляют исходную запись «только если копия действительно легла»,
    // спрашивали слово, которое не бывает отрицательным: на полном диске
    // оригинал стирался, а копии не было.
    return await kvSetChecked(key, encryptAtRestString(value, dek));
  } catch (e) {
    log.warn('kv_set_secret_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * v4.32.306: то же чтение, но с разовым дошифровыванием записи, которая легла
 * открытым текстом до того, как ключ перевели на kvSetSecret.
 *
 * Отдельной миграции с флагом здесь не нужно, и она была бы хуже: признак «ещё
 * не зашифровано» несёт сама строка — префикса enc2 у неё нет. Флаг же
 * выставляется один раз на устройство и не догонит запись, которая придёт
 * позже из восстановленной копии; ровно из-за этого в v4.32.302 завели
 * encryptAtRestIfPlain.
 *
 * Не записалось — значение всё равно возвращается, а следующее чтение
 * попробует снова. Открытым текстом при этом остаётся ровно та строка, что и
 * так там лежала: хуже провал не делает.
 */
export async function kvGetSecretUpgrading(key: string): Promise<string | null> {
  const stored = await kvGet(key);
  if (stored == null) return null;
  if (stored !== '' && !stored.startsWith(AT_REST_PREFIX)) {
    await kvSetSecret(key, stored);
    return stored;
  }
  // v4.32.552: через ту же ячейку, что и kvGetSecret — не открывшийся
  // шифртекст приходит сюда как null, а не как пустая строка.
  return cellTextOrNull(await kvGetSecretCell(key));
}

/**
 * v4.32.278: тот же секретный kv, но в пространстве имён профиля.
 *
 * Корзина «недавно удалённые» и личная заметка о контакте лежали в глобальных
 * ключах. На устройстве с двумя аккаунтами это значило, что второй профиль
 * открывает переписку с тем же человеком и видит и заметку, и тексты,
 * удалённые в чужом аккаунте; а удаление профиля (DELETE FROM kv WHERE k LIKE
 * 'p<id>:%') их не уносило — они переживали и сам аккаунт.
 *
 * Записанное до этой версии достаётся тому профилю, который откроет экран
 * первым, и тут же исчезает из общей области. Разделить старые записи между
 * аккаунтами уже нечем — глобальный ключ не помнит, кто его писал, — так что
 * пусть лучше редкий владелец второго аккаунта потеряет семидневный список,
 * чем увидит чужой.
 */
export async function kvGetSecretCellScoped(profileId: number, key: string): Promise<AtRestCell> {
  const scoped = profileScopedKey(profileId, key);
  const own = await kvGetSecretCell(scoped);
  // v4.32.552: перенос из общей области допустим ровно тогда, когда своей
  // записи нет. Раньше условием было «своё пусто», а пустотой оборачивалась и
  // неудачная расшифровка — и чужая запись ложилась поверх своей нечитаемой.
  if (own.state !== 'absent') return own;
  const legacy = await kvGetSecretCell(key);
  const legacyText = cellTextOrNull(legacy);
  if (legacyText == null) return legacy;
  // v4.32.293: удаляем исходную запись только если копия действительно легла.
  // Раньше провал шифрования (DEK недоступен) заканчивался тем, что старая
  // запись стёрта, а новой нет — заметка о контакте исчезала безвозвратно.
  if (await kvSetSecret(scoped, legacyText)) await kvDelete(key);
  return legacy;
}

export async function kvGetSecretScoped(profileId: number, key: string): Promise<string | null> {
  return cellTextOrNull(await kvGetSecretCellScoped(profileId, key));
}

/** Чем закончилась попытка дополнить секретную запись. */
export type SecretUpdateResult = 'written' | 'unchanged' | 'unreadable' | 'failed';

/**
 * v4.32.552: прочитать секретную запись профиля, дать вызывающему её
 * пересобрать и записать обратно — но только если прежнее содержимое
 * действительно прочиталось.
 *
 * Раньше эти три шага писались по месту (корзина «недавно удалённые» в
 * переписке и в группе, личная заметка), и каждое место одинаково принимало
 * непрочитанный шифртекст за пустоту. `update` получает `null` и на
 * отсутствующей записи, и на пустой — но до него дело доходит только тогда,
 * когда запись разрешено переписывать; вернуть `null` из него значит
 * «передумал, не пиши».
 *
 * Текст отказа для пользователя — `SECRET_UNREADABLE_TEXT`.
 */
export async function kvUpdateSecretScoped(
  profileId: number,
  key: string,
  update: (current: string | null) => string | null
): Promise<SecretUpdateResult> {
  const cell = await kvGetSecretCellScoped(profileId, key);
  const current = cellTextOrNull(cell);
  const next = cell.state === 'unreadable' ? null : update(current);
  const outcome = decideSecretUpdate(cell.state, current, next);
  if (outcome === 'refuse-unreadable') {
    log.warn('kv_secret_update_refused', { key, reason: SECRET_UNREADABLE_TEXT });
    return 'unreadable';
  }
  if (outcome === 'skip-unchanged' || next === null) return 'unchanged';
  return (await kvSetSecretScoped(profileId, key, next)) ? 'written' : 'failed';
}

export async function kvSetSecretScoped(profileId: number, key: string, value: string): Promise<boolean> {
  return await kvSetSecret(profileScopedKey(profileId, key), value);
}

/**
 * Удаляет и запись профиля, и глобальную legacy-запись: иначе удалённое
 * вернулось бы при следующем чтении — kvGetSecretScoped как раз и поднимает
 * legacy-ключ, когда своего нет.
 */
export async function kvDeleteScoped(profileId: number, key: string): Promise<void> {
  await kvDelete(profileScopedKey(profileId, key));
  await kvDelete(key);
}

/**
 * v4.32.71: физическое удаление одной kv-записи по точному ключу. До этой версии
 * код удаления писал `kvSet(key, '')` — строка оставалась в БД с пустым значением,
 * и при следующем чтении `JSON.parse('')` выбрасывал исключение. Теперь есть
 * явный DELETE, чтобы записи не накапливались и listContacts не зависел от того,
 * сконсистентны ли row и contacts_index.
 */
export async function kvDelete(key: string): Promise<void> {
  try {
    const d = await db();
    await d.runAsync('DELETE FROM kv WHERE k = ?', [key]);
  } catch (e) {
    log.warn('kv_delete_failed', { key, err: e instanceof Error ? e.message : String(e) });
  }
}

export async function profileKvDelete(profileId: number, key: string): Promise<void> {
  return kvDelete(profileScopedKey(profileId, key));
}

/**
 * v4.32.49: удалить все kv-ключи, начинающиеся с префикса. Используется
 * при удалении профиля (префикс `p${id}:`) и при cleanup feed inline
 * media/doc'ов (префикс `feed_inline_media:${postId}:` или `feed_inline_doc:...`).
 *
 * LIKE metacharacters (%, _, \) экранируются через `ESCAPE '\'`.
 */
export async function kvDeleteByPrefix(prefix: string): Promise<number> {
  try {
    const d = await db();
    const escaped = prefix
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const res = await d.runAsync(
      "DELETE FROM kv WHERE k LIKE ? ESCAPE '\\'",
      [escaped + '%']
    );
    return res.changes ?? 0;
  } catch (e) {
    log.warn('kv_delete_by_prefix_failed', { prefix, err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/**
 * v4.32.333: то же перечисление, но провал чтения отличим от «ничего не нашлось».
 *
 * Разница не косметическая. Для уборки мусора пустой список безопасен — просто
 * ничего не убрали и попробуем в следующий раз. Но тот же список отвечает на
 * вопрос «на месте ли вложения поста», и там пустой список означает «пропали
 * все», а вызывающий на этом основании УДАЛЯЕТ посты. Заблокированная на
 * секунду база на старте не должна стирать ленту.
 */
export async function kvTryListKeysByPrefix(prefix: string): Promise<string[] | null> {
  try {
    const d = await db();
    const escaped = prefix
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const rows = await d.getAllAsync<{ k: string }>(
      "SELECT k FROM kv WHERE k LIKE ? ESCAPE '\\'",
      [escaped + '%']
    );
    return rows.map((r) => r.k);
  } catch (e) {
    log.warn('kv_list_keys_by_prefix_failed', { prefix, err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * v4.32.137: перечислить все kv-ключи по префиксу. LIKE metacharacters
 * экранируются через ESCAPE '\'. Для вызывающих, которым нечего делать с
 * ошибкой чтения; если по пустому списку принимается решение об удалении —
 * нужен kvTryListKeysByPrefix.
 */
export async function kvListKeysByPrefix(prefix: string): Promise<string[]> {
  return (await kvTryListKeysByPrefix(prefix)) ?? [];
}

/**
 * v4.32.49: атомарно удаляет все строки всех таблиц, привязанных к профилю,
 * плюс profile-scoped kv (`p${profileId}:*`). Вызывается из `profileManager.deleteProfile`.
 *
 * НЕ удаляет `kv[feed_inline_media:*]` / `kv[feed_inline_doc:*]` — за этим
 * отвечает `feedService.cleanupFeedStorageForProfile(profileId)` (у неё есть
 * список postId'ов из feed DB этого профиля).
 */
export async function deleteProfileDataFromLocalDb(profileId: number): Promise<void> {
  const d = await db();
  try {
    await d.withTransactionAsync(async () => {
      // Таблицы с прямым owner_profile_id
      const tables = [
        'chat_messages',
        'conversations',
        'group_members',
        'group_messages',
        'groups',
        'stories',
        // v4.32.576: альбомы историй и их содержимое. Файлы копий подбирает
        // sweepStoryAlbumFiles по списку уцелевших строк — как аватары.
        'story_albums',
        'story_album_items',
        'scheduled_messages',
        'poll_votes',
        'quick_replies',
        'group_join_requests',
        // v4.32.521: очередь отправки. Её строк здесь не было — а это тексты
        // неотправленных сообщений удалённого аккаунта, и лежали они на
        // устройстве ещё неделю, пока их не подберёт TTL в outboxPurgeDead.
        // Всё это время outboxCount считал их вместе с живыми, и баннер
        // «В очереди на отправку» показывал очередь, которая никогда не уйдёт:
        // runSyncIfOnline пропускает чужой профиль, а профиля больше нет.
        'outbox',
        // v4.32.521: курсор синхронизации и отпечатки сущностей. У этих TTL
        // нет вовсе, они оставались навсегда. Хуже, чем занятое место: список
        // профилей живёт в SecureStore, а база — в SQLite, и теряются они
        // порознь. Аккаунт, заведённый под тем же номером после потери списка,
        // продолжил бы синхронизацию с чужого курсора и считал бы, что
        // сущности с такими ревизиями у него уже есть, — то есть молча не
        // забрал бы с сервера собственные данные.
        'sync_state',
        'sync_entity_heads',
      ];
      for (const t of tables) {
        await d.runAsync(`DELETE FROM ${t} WHERE owner_profile_id = ?`, [profileId]);
      }
      // poll_votes_v2 может ещё не быть — если миграция не прошла
      try {
        await d.runAsync('DELETE FROM poll_votes_v2 WHERE owner_profile_id = ?', [profileId]);
      } catch { /* poll_votes_v2 not yet created */ }
      // Profile-scoped kv (contacts index, mute-lists, conversation tips, …)
      await d.runAsync("DELETE FROM kv WHERE k LIKE ? ESCAPE '\\'", [`${profileScopedKey(profileId, '')}%`]);
      // v4.32.483: кэш автоудаления живёт в памяти по номеру профиля — иначе
      // новый аккаунт с тем же номером получил бы таймер удалённого.
      forgetDefaultDisappear(profileId);
      // v4.32.281: блок-лист до этой версии назывался с суффиксом `_p<id>` и
      // под правило выше не подпадал — то есть переживал удаление аккаунта и
      // доставался следующему профилю с тем же номером. Убирается и он, даже
      // если этот профиль ни разу не успел мигрировать на новое имя.
      await d.runAsync('DELETE FROM kv WHERE k = ?', [legacySuffixBlockedKey(profileId)]);
      // v4.32.288: карточка профиля (имя, «о себе», аватар, ссылки) до этой
      // версии лежала одной общей записью — она принадлежит первому
      // профилю, потому что писалась, когда профиль был один. Удаляем её
      // вместе с ним: иначе имя и «о себе» удалённого аккаунта остались бы
      // лежать в базе, хотя аккаунта уже нет.
      if (profileId === 1) {
        // v4.32.325: вместе с карточкой уходят и служебные записи рассылки —
        // «кому какая версия профиля отправлена» и «кому сообщено решение о
        // времени последнего входа». Это списки открытых ключей собеседников;
        // оставленные лежать, они достались бы следующему профилю с тем же
        // номером. Пишутся они с этой версии уже под префиксом, но записи
        // прежних версий надо убрать за собой.
        // v4.32.561: и следы работы в интерфейсе — недавние реакции, недавние
        // эмодзи, язык перевода. Пишутся они с этой версии уже под префиксом,
        // но запись прежних версий принадлежит первому профилю и уходит с ним.
        for (const k of [...OWN_PROFILE_KEYS, ...LEGACY_GLOBAL_SYNC_KEYS, ...PER_PROFILE_UI_KEYS]) {
          await d.runAsync('DELETE FROM kv WHERE k = ?', [k]);
        }
        // v4.32.521: строки очереди, записанные до появления колонки профиля,
        // принадлежат первому профилю — он тогда был единственным. Под условие
        // выше они не попадают: NULL не равен ничему, даже единице. Их же
        // считает своими и runSyncIfOnline, отправляя под активным профилем.
        await d.runAsync('DELETE FROM outbox WHERE owner_profile_id IS NULL');
      }
    });
  } catch (e) {
    log.warn('delete_profile_data_failed', { profileId, err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export type OutboxItem = {
  id: number;
  kind: string;
  payload: string;
  createdAt: number;
  priority: number;
  /** Владелец item'а (профиль). null для legacy items из версий до v4.32.49. */
  ownerProfileId: number | null;
  /** v4.32.124 (AUDIT P1 Block 7): сколько раз sync пытался и провалился. */
  attempts: number;
};

/**
 * v4.32.124 (AUDIT P1 Block 7): лимиты offline-очереди.
 * - OUTBOX_MAX_ROWS — при превышении выталкиваем самые старые (FIFO).
 * - OUTBOX_MAX_ATTEMPTS — после N неуспешных попыток item помечен «дохлым»
 *   (outboxDrain его не вернёт), чтобы не крутился бесконечно.
 * - OUTBOX_MAX_PAYLOAD_BYTES — cap на размер одного payload'а, чтобы не
 *   забить БД из-за бага в enqueue-call-site или вредоносного контакта.
 */
const OUTBOX_MAX_ROWS = 10_000;
const OUTBOX_MAX_ATTEMPTS = 20;
const OUTBOX_MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * v4.32.500: сколько строк очереди поднимается в память за один заход.
 *
 * OUTBOX_MAX_ROWS × OUTBOX_MAX_PAYLOAD_BYTES — это два с половиной гигабайта,
 * и ровно столько outboxDrain был вправе расшифровать одним вызовом. Порция в
 * двести строк ограничивает пик примерно пятьюдесятью мегабайтами в самом
 * худшем случае и обычными единицами мегабайт на практике. Вся очередь
 * при этом остаётся достижимой: вызывающая сторона идёт по ней окном.
 */
export const OUTBOX_DRAIN_LIMIT = 200;

/**
 * Поставить конверт в офлайн-очередь. Отвечает, легла ли строка в базу.
 *
 * v4.32.476: раньше тип был `Promise<void>`, и снаружи три разных исхода —
 * строка записана, payload отброшен как слишком большой, запись упала на
 * ошибке базы — выглядели одинаково. Вызывающая сторона после этого отвечала
 * «поставлено в очередь» и помечала сообщение `sent`: человек видел обычное
 * отправленное сообщение, кнопки повтора у него не было (она есть только у
 * `failed`), а в очереди ничего не лежало и повторять было нечего. Терялись
 * при этом ровно те отправки, что делались при переполненном или сбойном
 * хранилище, то есть в самый неудачный момент.
 */
export async function outboxEnqueue(
  kind: string,
  payload: string,
  priority = 0,
  ownerProfileId: number | null = null
): Promise<boolean> {
  try {
    // P1 Block 7: drop payloads that obviously overflow — typically a bug, never legitimate
    // (actual media lives in IPFS; envelopes are tiny refs).
    if (payload.length > OUTBOX_MAX_PAYLOAD_BYTES) {
      log.warn('outbox_enqueue_oversize_dropped', { kind, size: payload.length });
      return false;
    }
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const enc = encryptAtRestString(payload, dek);
    // P1 Block 7: FIFO eviction when queue bloats. Keeps DB bounded on long
    // offline periods with a misbehaving upstream.
    //
    // v4.32.522: сначала выталкивается очередь ТОГО ЖЕ профиля. Потолок общий
    // — он про место на диске, — а вот вытолкнутая строка это чьё-то не
    // отправленное сообщение, исчезающее совсем беззвучно: отправитель давно
    // увидел «отправлено», кнопки повтора у него нет. Пока выталкивание шло по
    // всей таблице, разошедшийся профиль сжирал квоту и стирал самые старые
    // конверты СОСЕДНЕГО аккаунта, который в это время мог быть просто не
    // открыт. Теперь он в первую очередь ест собственную очередь, и до чужой
    // дело доходит только если своей у него нет вовсе — но потолок соблюдать
    // всё равно надо, иначе беззвучная потеря сменится переполненным диском.
    try {
      const row = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) as n FROM outbox');
      const n = row?.n ?? 0;
      if (n >= OUTBOX_MAX_ROWS) {
        const toDrop = n - OUTBOX_MAX_ROWS + 1;
        // `IS`, а не `=`: у строк, записанных до появления колонки профиля,
        // здесь NULL, и равенство не совпало бы даже с NULL в параметре.
        const own = await d.runAsync(
          `DELETE FROM outbox WHERE id IN (
             SELECT id FROM outbox WHERE owner_profile_id IS ?
             ORDER BY created_at ASC, id ASC LIMIT ?
           )`,
          [ownerProfileId, toDrop]
        );
        const dropped = own.changes ?? 0;
        if (dropped < toDrop) {
          await d.runAsync(
            'DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY created_at ASC, id ASC LIMIT ?)',
            [toDrop - dropped]
          );
        }
        log.warn('outbox_evicted_oldest', { dropped: toDrop, own: dropped, cap: OUTBOX_MAX_ROWS });
      }
    } catch (e) {
      log.warn('outbox_evict_check_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
    await d.runAsync(
      'INSERT INTO outbox (kind, payload, created_at, priority, owner_profile_id) VALUES (?, ?, ?, ?, ?)',
      [kind, enc, Date.now(), priority, ownerProfileId]
    );
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('outbox_enqueue_failed', { err: msg });
    // v4.32.126 (AUDIT P2): same storage-pressure signal as kvSet.
    notifyIfStoragePressure(e, 'outbox_enqueue');
    return false;
  }
}

/**
 * Сколько конвертов ждёт отправки у этого профиля.
 *
 * v4.32.226: считаются только ЖИВЫЕ строки. Исчерпавшие OUTBOX_MAX_ATTEMPTS
 * outboxDrain не выдаёт, повторять их приложение не станет никогда — а
 * посчитанные здесь, они держали баннер «В очереди на отправку: N» навсегда.
 *
 * v4.32.522: и только строки своего профиля. Чужие отсюда не уйдут — разбор
 * очереди пропускает конверты неактивного аккаунта, — то есть баннер снова
 * показывал очередь, которая не убывает. И не просто показывал: пока число
 * больше нуля, OfflineStatus каждые шесть секунд зовёт полную синхронизацию,
 * так что второй профиль с непустой очередью означал вечный опрос сети в
 * фоне. `null` — профилей ещё нет вовсе (установка без сид-фразы): тогда
 * считаем всё, как раньше.
 */
export async function outboxCount(ownerProfileId: number | null): Promise<number> {
  try {
    const d = await db();
    const mine = ownerProfileId === null
      ? ''
      : ' AND (owner_profile_id = ? OR owner_profile_id IS NULL)';
    const args: (number | null)[] = [OUTBOX_MAX_ATTEMPTS];
    if (ownerProfileId !== null) args.push(ownerProfileId);
    const r = await d.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) as n FROM outbox WHERE COALESCE(attempts, 0) < ?${mine}`,
      args
    );
    return r?.n ?? 0;
  } catch (e) {
    log.warn('outbox_count_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/**
 * v4.32.226: purge dead-lettered / expired outbox rows.
 *
 * Two classes of rows can otherwise live forever:
 *  1. attempts >= OUTBOX_MAX_ATTEMPTS — outboxDrain() never returns them, so the
 *     7-day dead-letter TTL inside runSyncIfOnline (which only sees DRAINED rows)
 *     can never reach them. They accumulate and (pre-fix) inflated outboxCount.
 *  2. age > ttlMs — the intended dead-letter sweep, made unreachable for (1).
 *
 * Runs cheaply at the start of each sync. Returns the number of rows deleted.
 */
export async function outboxPurgeDead(ttlMs: number): Promise<number> {
  try {
    const d = await db();
    const now = Date.now();
    const r = await d.runAsync(
      `DELETE FROM outbox
       WHERE COALESCE(attempts, 0) >= ?
          OR (? - created_at) > ?`,
      [OUTBOX_MAX_ATTEMPTS, now, ttlMs]
    );
    const removed = r.changes ?? 0;
    if (removed > 0) log.info('outbox_purge_dead', { removed });
    return removed;
  } catch (e) {
    log.warn('outbox_purge_dead_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/**
 * Путь, которым сообщение ушло к собеседнику (v4.32.563).
 *
 * `ipfs` — опубликовано в сеть и подтверждено CID; `lan` — напрямую по
 * локальной сети, интернет не потребовался; `internet` — через реле;
 * `wifi_direct` — P2P без общей сети. Известен только для своих отправленных
 * сообщений: как до нас добиралось входящее, знает лишь его отправитель.
 */
export type MessageRoute = 'ipfs' | 'lan' | 'internet' | 'wifi_direct';

export type ChatMessageRow = {
  id: string;
  contactPubB64: string;
  cid: string | null;
  text: string;
  direction: 'in' | 'out';
  status: string;
  mediaCids: string | null;
  createdAt: number;
  /** Локальные чаты привязаны к профилю (смена профиля не смешивает истории). */
  ownerProfileId: number;
  /** ID сообщения, на которое это является ответом. */
  replyToId?: string | null;
  /** Превью текста оригинального сообщения (≤100 символов) для отображения цитаты. */
  replyToPreview?: string | null;
  /**
   * Столбец с цитатой не открылся ключом данных (v4.32.598).
   *
   * Пустая строка от неудачной расшифровки не отличалась от «это не ответ»:
   * блок цитаты просто не рисовался, и ответ читался как отдельная реплика.
   * Признак только читается — писать его в строку не нужно. См. unreadableText.
   */
  replyToPreviewUnreadable?: boolean;
  /** Unix ms — когда сообщение было отредактировано (null = не редактировалось). */
  editedAt?: number | null;
  /** JSON: { "❤️": ["did1","did2"], "👍": ["did1"] } */
  reactions?: string | null;
  /**
   * Столбец с реакциями не открылся ключом данных (v4.32.600).
   *
   * Пустая строка от неудачной расшифровки не отличалась от «реакций не
   * было»: плашки просто не рисовались. Писать в такой столбец запрещено с
   * v4.32.544 — значит и молчать о нём нельзя, иначе отказ по нажатию
   * приходит из ниоткуда. См. unreadableText.
   */
  reactionsUnreadable?: boolean;
  /** Пользователь пометил сообщение как избранное. */
  starred?: boolean;
  /**
   * Столбец с текстом не открылся ключом данных (v4.32.559).
   *
   * Раньше такое сообщение приходило сюда пустой строкой и рисовалось пустым
   * пузырём — неотличимо от подписи, которую не написали. См. unreadableText.
   */
  unreadable?: boolean;
  /**
   * Столбец со списком вложений не открылся ключом данных (v4.32.597).
   *
   * Пустая строка от неудачной расшифровки не отличалась от «вложений не
   * было»: сетка снимков просто не рисовалась. У сообщения без текста от него
   * не оставалось ничего — пустой пузырь. См. unreadableText.
   */
  mediaUnreadable?: boolean;
  /** Каким транспортом сообщение ушло; null — путь неизвестен. См. MessageRoute. */
  transport?: MessageRoute | null;
};

export type ConversationRow = {
  contactPubB64: string;
  ownerProfileId: number;
  unreadCount: number;
  draftText: string | null;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  /** Unix ms until which notifications are muted. NULL = muted forever. 0 or past = not muted. */
  mutedUntil: number | null;
  lastMessageAt: number;
  lastMessagePreview: string | null;
  /**
   * v4.32.580: столбец с подписью последней реплики есть, но ключом данных не
   * открывается. Тогда `lastMessagePreview` — null, и это НЕ «переписка без
   * сообщений»: в списке диалогов такая строка выглядела ровно как пустая.
   */
  lastMessagePreviewUnreadable?: boolean;
  /** v4.32.583: черновик не открылся ключом данных — см. draftGuard. */
  draftUnreadable?: boolean;
  lastMessageDirection: 'in' | 'out' | null;
  pinnedMessageId: string | null;
  /** If set, messages in this conversation auto-delete after this many ms (0 = off). */
  disappearAfterMs: number | null;
  /** Цветовая метка чата (hex string, e.g. '#e74c3c'), null = без метки. */
  colorTag: string | null;
};

/**
 * Единственный дом правила «запись сейчас заглушена».
 *
 * Колонка `muted` — это НЕ ответ на вопрос «заглушено ли сейчас». При snooze
 * («Беззвучно на час») строка навсегда остаётся с `muted = 1`, а срок лежит
 * отдельно в `muted_until`. Ответ = `muted = 1 И (muted_until IS NULL ИЛИ
 * muted_until > сейчас)`.
 *
 * Списки диалогов и групп это учитывали, а SQL-счётчики бейджа — нет: они
 * фильтровали по сырому `muted = 0`. Из-за этого истёкший snooze навсегда
 * вычитал непрочитанные из бейджа приложения, хотя в списке чат уже был не
 * заглушён и пуши по нему уже приходили; бейдж «чинился» только явным
 * «Включить звук».
 *
 * Поэтому правило живёт ровно здесь и ровно в двух формах: `NOT_MUTED_SQL`
 * для запросов и `isEffectivelyMuted()` для строк, прочитанных в JS. Оба
 * требуют `now` явным аргументом, так что новый вызов не может «забыть» срок,
 * не продублировав правило руками.
 */
const NOT_MUTED_SQL = '(NOT (muted = 1 AND (muted_until IS NULL OR muted_until > ?)))';

function isEffectivelyMuted(muted: number, mutedUntil: number | null, now: number): boolean {
  return muted === 1 && (mutedUntil === null || mutedUntil > now);
}

export type ChatWriteListener = () => void;
const chatWriteListeners = new Set<ChatWriteListener>();

/** Подписка на успешные изменения чатов/KV диалогов (для отложенного бэка на диск). */
export function subscribeChatWrites(cb: ChatWriteListener): () => void {
  chatWriteListeners.add(cb);
  return () => {
    chatWriteListeners.delete(cb);
  };
}

/**
 * v4.32.124 (AUDIT P1 Block 8): debounce chat-write notifications.
 * Bulk flows (sync loop delivering 50 queued DMs, или massive markAllRead)
 * раньше будили listener'ы на каждой записи — каждая re-query'ила SQLite,
 * re-renderила ChatsListScreen, пушила дисковый бэкап. 50 вставок = 50 циклов.
 * Схлопываем в один тик через микро-debounce.
 */
const CHAT_WRITES_DEBOUNCE_MS = 100;
let chatWritesTimer: ReturnType<typeof setTimeout> | null = null;

function flushChatWrites(): void {
  chatWritesTimer = null;
  for (const cb of [...chatWriteListeners]) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

function emitChatWrites(): void {
  if (chatWritesTimer !== null) return;
  chatWritesTimer = setTimeout(flushChatWrites, CHAT_WRITES_DEBOUNCE_MS);
}

/** Контакты / блок-лист / подсказки переписок — вне chat_messages, но входят в резервную копию диалогов. */
export function notifyChatStorageChanged(): void {
  emitChatWrites();
}

export async function saveChatMessage(row: ChatMessageRow): Promise<void> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const textEnc = encryptAtRestString(row.text, dek);
    const mediaEnc = encryptAtRestNullable(row.mediaCids, dek);
    // v4.32.282: цитата — это кусок чужого сообщения, и лежала она открытым
    // текстом вплотную к зашифрованному. Ответить на сообщение значило
    // выложить его начало в базу в читаемом виде.
    const replyEnc = encryptAtRestNullable(row.replyToPreview ?? null, dek);
    const ownerPid = row.ownerProfileId ?? 1;
    await d.execAsync('BEGIN IMMEDIATE');
    try {
      await d.runAsync(
        `INSERT OR IGNORE INTO chat_messages (id, contact_pub_b64, cid, text, direction, status, media_cids, created_at, owner_profile_id, reply_to_id, reply_to_preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.contactPubB64,
          row.cid,
          textEnc,
          row.direction,
          row.status,
          mediaEnc,
          row.createdAt,
          ownerPid,
          row.replyToId ?? null,
          replyEnc,
        ]
      );
      await d.execAsync('COMMIT');
    } catch (e) {
      try {
        await d.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    emitChatWrites();
  } catch (e) {
    log.warn('chat_message_save_failed', { err: e instanceof Error ? e.message : String(e) });
    // v4.32.300: ошибку записи сообщения наружу не отдаём — вызывающему нечего
    // с ней делать, а переписка не должна падать из-за одной строки. Но именно
    // из-за этого переполненный диск был не виден вообще: сообщение
    // отрисовывалось из памяти и исчезало при следующем открытии чата.
    notifyIfStoragePressure(e, 'chat_message_save');
  }
}

export async function upsertChatMessage(row: ChatMessageRow): Promise<void> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const textEnc = encryptAtRestString(row.text, dek);
    const mediaEnc = encryptAtRestNullable(row.mediaCids, dek);
    const replyEnc = encryptAtRestNullable(row.replyToPreview ?? null, dek);
    const ownerPid = row.ownerProfileId ?? 1;
    await d.execAsync('BEGIN IMMEDIATE');
    try {
      await d.runAsync(
        `INSERT OR REPLACE INTO chat_messages (id, contact_pub_b64, cid, text, direction, status, media_cids, created_at, owner_profile_id, reply_to_id, reply_to_preview, transport)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.contactPubB64,
          row.cid,
          textEnc,
          row.direction,
          row.status,
          mediaEnc,
          row.createdAt,
          ownerPid,
          row.replyToId ?? null,
          replyEnc,
          // v4.32.563: INSERT OR REPLACE переписывает строку целиком. Не
          // перечислить маршрут здесь — значит стирать его при первом же
          // сохранении нового статуса, то есть всегда.
          row.transport ?? null,
        ]
      );
      await d.execAsync('COMMIT');
    } catch (e) {
      try {
        await d.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    emitChatWrites();
  } catch (e) {
    log.warn('chat_message_upsert_failed', { err: e instanceof Error ? e.message : String(e) });
    notifyIfStoragePressure(e, 'chat_message_upsert');
  }
}

/** @param ownerProfileId — считать сообщения только этого профиля; без него — всей БД. */
export async function countChatMessages(ownerProfileId?: number): Promise<number> {
  try {
    const d = await db();
    const r =
      ownerProfileId == null
        ? await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) as n FROM chat_messages')
        : await d.getFirstAsync<{ n: number }>(
            'SELECT COUNT(*) as n FROM chat_messages WHERE owner_profile_id = ?',
            [ownerProfileId]
          );
    return r?.n ?? 0;
  } catch (e) {
    log.warn('chat_messages_count_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/**
 * Строки как в БД (text/media_cids — enc2), без расшифровки.
 * v4.32.280: только сообщения указанного профиля. Раньше выгружалась вся
 * таблица, а импорт всё равно оставляет от неё лишь строки активного профиля,
 * так что чужие переписки лежали в файле мёртвым грузом — и занимали место в
 * лимите на размер копии.
 */
export async function exportRawChatMessageRows(ownerProfileId: number): Promise<
  Array<{
    id: string;
    contact_pub_b64: string;
    cid: string | null;
    text: string;
    direction: string;
    status: string;
    media_cids: string | null;
    created_at: number;
    owner_profile_id: number;
    reply_to_id: string | null;
    reply_to_preview: string | null;
  }>
> {
  try {
    const d = await db();
    return await d.getAllAsync<{
      id: string;
      contact_pub_b64: string;
      cid: string | null;
      text: string;
      direction: string;
      status: string;
      media_cids: string | null;
      created_at: number;
      owner_profile_id: number;
      reply_to_id: string | null;
      reply_to_preview: string | null;
    }>('SELECT * FROM chat_messages WHERE owner_profile_id = ? ORDER BY created_at ASC', [
      ownerProfileId,
    ]);
  } catch (e) {
    log.warn('chat_export_raw_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * @returns сколько строк действительно записано.
 *
 * v4.32.370: раньше было `void`. Проверка отбрасывает строку целиком, и
 * вызывающий — восстановление из копии — отчитывался числом строк В ФАЙЛЕ,
 * потому что другого у него не было. Совпадали эти два числа только пока
 * файл цел; при подменённом или полученном от другого профиля в журнале
 * оставалось «восстановлено 1523 сообщения» при пустом списке чатов. Соседние
 * импортёры (conversationMeta, groupBackup) отдают настоящий счёт с самого
 * начала — этот остался последним.
 */
export async function importRawChatMessageRows(
  input: unknown,
  ownerProfileId?: number,
): Promise<number> {
  // v4.32.192 (Round-22 #1): per-row shape validation — a tampered backup
  // file must not be able to inject foreign-profile rows, huge text blobs,
  // non-integer timestamps, or non-string ids. expectedPid from profileManager.
  // v4.32.370: сама проверка переехала в chatMessageBackup — модуль без
  // зависимостей, границы которого можно проверить тестом.
  // v4.32.519: профиль можно назвать явно. Синхронизация приносит строку
  // вместе с её аккаунтом, а активным в этот момент может быть другой — без
  // явного аргумента чужое сообщение записывалось в открытый сейчас профиль.
  // Соседние ветки того же switch профиль передают, эта одна не передавала.
  const expectedPid = ownerProfileId
    ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id
    ?? 1;
  const { rows: sanitized, dropped } = sanitizeRawChatMessageRows(input, expectedPid, Date.now());
  // Молчаливая потеря строк при восстановлении — худший исход из возможных:
  // человек видит «успешно», а части переписки нет. Хотя бы в журнале след.
  if (dropped > 0) {
    log.warn('chat_import_rows_dropped', {
      dropped,
      total: Array.isArray(input) ? input.length : 0,
    });
  }
  if (!sanitized.length) return 0;
  try {
    const d = await db();
    await d.execAsync('BEGIN IMMEDIATE');
    try {
      for (const r of sanitized) {
        await d.runAsync(
          `INSERT OR REPLACE INTO chat_messages (id, contact_pub_b64, cid, text, direction, status, media_cids, created_at, owner_profile_id, reply_to_id, reply_to_preview)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            r.id,
            r.contact_pub_b64,
            r.cid,
            r.text,
            r.direction,
            r.status,
            r.media_cids,
            r.created_at,
            r.owner_profile_id ?? 1,
            r.reply_to_id ?? null,
            r.reply_to_preview ?? null,
          ]
        );
      }
      await d.execAsync('COMMIT');
    } catch (e) {
      try {
        await d.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    emitChatWrites();
    return sanitized.length;
  } catch (e) {
    log.warn('chat_import_raw_failed', { err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * Сколько символов последнего сообщения показывается в списке чатов.
 * v4.32.280: один литерал на всех, кто пишет превью — личные чаты, группы и
 * восстановление из копии. Разъехавшись, они дали бы список, где строка
 * обрывается по-разному в зависимости от того, кто её последним записал.
 */
const LAST_MESSAGE_PREVIEW_MAX = 120;

/**
 * v4.32.280. Восстановить строки conversations по сообщениям, уже лежащим в БД.
 *
 * Резервная копия диалогов возвращает chat_messages — и только их. А список
 * чатов строится по таблице conversations и по контактам, поэтому после
 * восстановления человек видел пустой экран: сообщения в базе есть, дороги к
 * ним из интерфейса нет.
 *
 * Существующие строки не трогаются (INSERT OR IGNORE): у них могут быть
 * закрепление, архив, беззвучный режим и черновик. Настройки переписок,
 * которых по сообщениям не восстановить, приходят следом отдельным шагом —
 * importConversationMetaRows (v4.32.295).
 *
 * @returns сколько переписок появилось
 */
export async function rebuildConversationsFromMessages(ownerProfileId: number): Promise<number> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{
      contact_pub_b64: string;
      last_at: number;
      text: string;
      direction: string;
    }>(
      `SELECT m.contact_pub_b64 AS contact_pub_b64, m.created_at AS last_at, m.text AS text, m.direction AS direction
         FROM chat_messages m
         JOIN (SELECT contact_pub_b64, MAX(created_at) AS mx
                 FROM chat_messages WHERE owner_profile_id = ?
                GROUP BY contact_pub_b64) t
           ON t.contact_pub_b64 = m.contact_pub_b64 AND t.mx = m.created_at
        WHERE m.owner_profile_id = ?
        GROUP BY m.contact_pub_b64`,
      [ownerProfileId, ownerProfileId]
    );
    if (!rows.length) return 0;
    // DEK берётся до транзакции: обращение к Keystore внутри BEGIN IMMEDIATE
    // держало бы write-lock на сотни миллисекунд (та же причина, что в
    // touchConversation).
    const dek = await getOrCreateDataEncryptionKey();
    const prepared = rows.map((r) => {
      const plain = decryptAtRestString(r.text, dek).slice(0, LAST_MESSAGE_PREVIEW_MAX);
      return {
        contact: r.contact_pub_b64,
        lastAt: r.last_at,
        preview: plain ? encryptAtRestString(plain, dek) : null,
        direction: r.direction === 'in' || r.direction === 'out' ? r.direction : null,
      };
    });
    let created = 0;
    await d.execAsync('BEGIN IMMEDIATE');
    try {
      for (const p of prepared) {
        const res = await d.runAsync(
          `INSERT OR IGNORE INTO conversations
             (contact_pub_b64, owner_profile_id, unread_count, last_message_at, last_message_preview, last_message_direction)
           VALUES (?, ?, 0, ?, ?, ?)`,
          [p.contact, ownerProfileId, p.lastAt, p.preview, p.direction]
        );
        if (res.changes > 0) created += 1;
      }
      await d.execAsync('COMMIT');
    } catch (err) {
      try {
        await d.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    if (created > 0) emitChatWrites();
    return created;
  } catch (e) {
    log.warn('conversations_rebuild_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/**
 * Настройки переписок для копии (v4.32.295): метка, закрепление, архив,
 * тишина, черновик, таймер самоуничтожения. Забираются только строки, где
 * что-то настроено, — остальное восстанавливается по сообщениям.
 */
export async function exportConversationMetaRows(
  ownerProfileId: number
): Promise<ConversationMetaRow[]> {
  try {
    const d = await db();
    return await d.getAllAsync<ConversationMetaRow>(
      `SELECT contact_pub_b64, unread_count, draft_text, pinned, archived, muted, muted_until,
              pinned_message_id, disappear_after_ms, disappear_set_at, color_tag
         FROM conversations
        WHERE owner_profile_id = ?
          AND (pinned = 1 OR archived = 1 OR muted = 1 OR unread_count > 0
               OR draft_text IS NOT NULL OR pinned_message_id IS NOT NULL
               OR disappear_after_ms IS NOT NULL OR color_tag IS NOT NULL)`,
      [ownerProfileId]
    );
  } catch (e) {
    log.warn('conversation_meta_export_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * Вернуть настройки переписок из копии. Вызывается ПОСЛЕ
 * rebuildConversationsFromMessages: строки к этому моменту уже есть, а те, что
 * остались без сообщений (архивная переписка, из которой всё удалено),
 * создаются здесь — иначе они бы просто не вернулись.
 *
 * @returns сколько переписок получили свои настройки обратно
 */
export async function importConversationMetaRows(
  input: unknown,
  ownerProfileId: number
): Promise<number> {
  const { rows, dropped } = sanitizeConversationMetaRows(input);
  // Молчаливая потеря здесь означала бы «таймер самоуничтожения не вернулся, и
  // об этом никто не узнал».
  if (dropped > 0) log.warn('conversation_meta_rows_dropped', { dropped });
  if (!rows.length) return 0;
  try {
    const d = await db();
    await d.execAsync('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        await d.runAsync(
          'INSERT OR IGNORE INTO conversations (contact_pub_b64, owner_profile_id) VALUES (?, ?)',
          [r.contact_pub_b64, ownerProfileId]
        );
        await d.runAsync(
          `UPDATE conversations
              SET unread_count = ?, draft_text = ?, pinned = ?, archived = ?, muted = ?,
                  muted_until = ?, pinned_message_id = ?, disappear_after_ms = ?,
                  disappear_set_at = ?, color_tag = ?
            WHERE contact_pub_b64 = ? AND owner_profile_id = ?`,
          [
            r.unread_count,
            r.draft_text,
            r.pinned,
            r.archived,
            r.muted,
            r.muted_until,
            r.pinned_message_id,
            r.disappear_after_ms,
            r.disappear_set_at,
            r.color_tag,
            r.contact_pub_b64,
            ownerProfileId,
          ]
        );
      }
      await d.execAsync('COMMIT');
    } catch (e) {
      try {
        await d.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    emitChatWrites();
    return rows.length;
  } catch (e) {
    log.warn('conversation_meta_import_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/**
 * Групповая часть резервной копии — строки как есть, шифротекстом.
 *
 * Один снимок на три таблицы: `member_count` лежит в строке группы, а сам
 * состав — в group_members, и сняв их по отдельности можно получить копию, где
 * «12 участников» написано над списком из трёх.
 */
export async function exportGroupBackupRows(ownerProfileId: number): Promise<{
  groups: GroupBackupRow[];
  messages: GroupMessageBackupRow[];
  members: GroupMemberBackupRow[];
}> {
  const empty = { groups: [], messages: [], members: [] };
  try {
    const d = await db();
    const groups = await d.getAllAsync<GroupBackupRow>(
      `SELECT id, name, description, avatar_cid, type, invite_token, is_admin, member_count,
              unread_count, mention_count, muted, muted_until, pinned, archived,
              last_message_at, last_message_preview, last_message_sender_name,
              last_message_sender_pub, pinned_message_id, pinned_message_text, draft_text,
              disappear_after_ms, disappear_set_at, slow_mode_seconds, admin_only_posting,
              admin_only_pinning, anonymous_posting, require_approval, created_at
         FROM groups WHERE owner_profile_id = ?`,
      [ownerProfileId]
    );
    if (!groups.length) return empty;
    const messages = await d.getAllAsync<GroupMessageBackupRow>(
      `SELECT id, group_id, sender_pub_b64, sender_name, text, media_cids, reply_to_id,
              reply_to_preview, reactions, created_at, edited_at, starred, view_count, seen_by
         FROM group_messages WHERE owner_profile_id = ? ORDER BY created_at ASC`,
      [ownerProfileId]
    );
    // v4.32.466: состав отбирается по своей же колонке профиля. До неё копию
    // приходилось собирать через JOIN с groups — и осиротевший состав (группа
    // удалена, строки участников остались) в копию не попадал вовсе.
    const members = await d.getAllAsync<GroupMemberBackupRow>(
      `SELECT group_id, peer_pub_b64, role, display_name, joined_at
         FROM group_members WHERE owner_profile_id = ?`,
      [ownerProfileId]
    );
    return { groups, messages, members };
  } catch (e) {
    log.warn('group_backup_export_failed', { err: e instanceof Error ? e.message : String(e) });
    return empty;
  }
}

/**
 * Вернуть группы из копии. Всё тремя INSERT OR IGNORE в одной транзакции:
 * группа, которая на устройстве уже есть, остаётся своей — её настройки новее
 * тех, что лежали в файле.
 *
 * `owner_profile_id` ставится по активному профилю, а не берётся из файла.
 *
 * @returns сколько строк каждого вида доехало
 */
export async function importGroupBackupRows(
  input: { groups?: unknown; messages?: unknown; members?: unknown },
  ownerProfileId: number
): Promise<{ groups: number; messages: number; members: number }> {
  const none = { groups: 0, messages: 0, members: 0 };
  const groups = sanitizeGroupRows(input.groups);
  if (groups.dropped > 0) log.warn('group_backup_groups_dropped', { dropped: groups.dropped });
  if (!groups.rows.length) return none;
  const ids = new Set(groups.rows.map((g) => g.id));
  const messages = sanitizeGroupMessageRows(input.messages, ids);
  const members = sanitizeGroupMemberRows(input.members, ids);
  // Молчаливая потеря здесь — это «часть переписки не вернулась, и об этом
  // никто не узнал»; хотя бы в журнале след.
  if (messages.dropped > 0) log.warn('group_backup_messages_dropped', { dropped: messages.dropped });
  if (members.dropped > 0) log.warn('group_backup_members_dropped', { dropped: members.dropped });
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    await d.execAsync('BEGIN IMMEDIATE');
    try {
      for (const g of groups.rows) {
        await d.runAsync(
          `INSERT OR IGNORE INTO groups
             (id, owner_profile_id, name, description, avatar_cid, type, invite_token, is_admin,
              member_count, unread_count, mention_count, muted, muted_until, pinned, archived,
              last_message_at, last_message_preview, last_message_sender_name,
              last_message_sender_pub, pinned_message_id, pinned_message_text, draft_text,
              disappear_after_ms, disappear_set_at, slow_mode_seconds, admin_only_posting,
              admin_only_pinning, anonymous_posting, require_approval, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            g.id, ownerProfileId, g.name, g.description, g.avatar_cid, g.type, g.invite_token,
            g.is_admin, g.member_count, g.unread_count, g.mention_count, g.muted, g.muted_until,
            g.pinned, g.archived, g.last_message_at, g.last_message_preview,
            g.last_message_sender_name, g.last_message_sender_pub, g.pinned_message_id,
            g.pinned_message_text, g.draft_text, g.disappear_after_ms, g.disappear_set_at,
            g.slow_mode_seconds, g.admin_only_posting, g.admin_only_pinning, g.anonymous_posting,
            g.require_approval, g.created_at,
          ]
        );
      }
      for (const m of messages.rows) {
        await d.runAsync(
          `INSERT OR IGNORE INTO group_messages
             (id, group_id, sender_pub_b64, sender_name, text, media_cids, reply_to_id,
              reply_to_preview, reactions, created_at, owner_profile_id, edited_at, starred,
              view_count, seen_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id, m.group_id, m.sender_pub_b64, m.sender_name, m.text, m.media_cids,
            m.reply_to_id, m.reply_to_preview, encryptAtRestIfPlain(m.reactions, dek), m.created_at, ownerProfileId,
            m.edited_at, m.starred, m.view_count, encryptAtRestIfPlain(m.seen_by, dek),
          ]
        );
      }
      for (const p of members.rows) {
        await d.runAsync(
          `INSERT OR IGNORE INTO group_members (group_id, peer_pub_b64, role, display_name, joined_at, owner_profile_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [p.group_id, p.peer_pub_b64, p.role, p.display_name, p.joined_at, ownerProfileId]
        );
      }
      await d.execAsync('COMMIT');
    } catch (e) {
      try {
        await d.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    emitChatWrites();
    return { groups: groups.rows.length, messages: messages.rows.length, members: members.rows.length };
  } catch (e) {
    log.warn('group_backup_import_failed', { err: e instanceof Error ? e.message : String(e) });
    return none;
  }
}

/** Apply one remote group child row without requiring the whole group archive. */
export async function applySyncGroupMessage(
  row: GroupMessageBackupRow,
  ownerProfileId: number,
): Promise<void> {
  if (!validSyncProfileId(ownerProfileId)) throw new Error('Invalid sync profile id');
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    `INSERT INTO group_messages
       (id, group_id, sender_pub_b64, sender_name, text, media_cids, reply_to_id,
        reply_to_preview, reactions, created_at, owner_profile_id, edited_at, starred,
        view_count, seen_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id, owner_profile_id) DO UPDATE SET
       group_id = excluded.group_id,
       sender_pub_b64 = excluded.sender_pub_b64,
       sender_name = excluded.sender_name,
       text = excluded.text,
       media_cids = excluded.media_cids,
       reply_to_id = excluded.reply_to_id,
       reply_to_preview = excluded.reply_to_preview,
       reactions = excluded.reactions,
       created_at = excluded.created_at,
       edited_at = excluded.edited_at,
       starred = excluded.starred,
       view_count = excluded.view_count,
       seen_by = excluded.seen_by`,
    [
      row.id,
      row.group_id,
      row.sender_pub_b64,
      row.sender_name,
      row.text,
      row.media_cids,
      row.reply_to_id,
      row.reply_to_preview,
      encryptAtRestIfPlain(row.reactions, dek),
      row.created_at,
      ownerProfileId,
      row.edited_at,
      row.starred,
      row.view_count,
      encryptAtRestIfPlain(row.seen_by, dek),
    ],
  );
  emitChatWrites();
}

export async function applySyncGroupMember(
  row: GroupMemberBackupRow,
  ownerProfileId: number,
): Promise<void> {
  if (!validSyncProfileId(ownerProfileId)) throw new Error('Invalid sync profile id');
  const d = await db();
  await d.runAsync(
    `INSERT INTO group_members (group_id, peer_pub_b64, role, display_name, joined_at, owner_profile_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (group_id, peer_pub_b64, owner_profile_id) DO UPDATE SET
       role = excluded.role,
       display_name = excluded.display_name,
       joined_at = excluded.joined_at`,
    [row.group_id, row.peer_pub_b64, row.role, row.display_name, row.joined_at, ownerProfileId],
  );
  emitChatWrites();
}

export async function deleteSyncEntity(
  entityKind: string,
  entityId: string,
  ownerProfileId: number,
): Promise<void> {
  if (!validSyncProfileId(ownerProfileId)) throw new Error('Invalid sync profile id');
  const d = await db();
  switch (entityKind) {
    case 'message':
      await d.runAsync('DELETE FROM chat_messages WHERE id = ? AND owner_profile_id = ?', [entityId, ownerProfileId]);
      break;
    case 'conversation':
      await d.runAsync('DELETE FROM conversations WHERE contact_pub_b64 = ? AND owner_profile_id = ?', [entityId, ownerProfileId]);
      break;
    case 'group':
      await d.runAsync('DELETE FROM groups WHERE id = ? AND owner_profile_id = ?', [entityId, ownerProfileId]);
      break;
    case 'group_message':
      await d.runAsync('DELETE FROM group_messages WHERE id = ? AND owner_profile_id = ?', [entityId, ownerProfileId]);
      break;
    case 'group_member': {
      const separator = entityId.indexOf('\u0000');
      if (separator > 0) {
        await d.runAsync(
          'DELETE FROM group_members WHERE group_id = ? AND peer_pub_b64 = ? AND owner_profile_id = ?',
          [entityId.slice(0, separator), entityId.slice(separator + 1), ownerProfileId],
        );
      }
      break;
    }
    case 'setting':
      if (dialogBackupLogicalKey(entityId)) {
        await d.runAsync('DELETE FROM kv WHERE k = ?', [profileScopedKey(ownerProfileId, entityId)]);
      }
      break;
    case 'profile':
      if ((OWN_PROFILE_KEYS as readonly string[]).includes(entityId)
        || (PRIVACY_PREF_KEYS as readonly string[]).includes(entityId)) {
        await d.runAsync('DELETE FROM kv WHERE k = ?', [profileScopedKey(ownerProfileId, entityId)]);
      }
      break;
    default:
      break;
  }
  emitChatWrites();
}

/** KV для списка чатов: контакты и подсказки переписок. */
export async function exportDialogKvSnapshot(profileId: number): Promise<Array<{ k: string; v: string }>> {
  try {
    const d = await db();
    // Что забирать — решает dialogBackupKeySelectors: правило одно и на экспорт,
    // и на импорт. Старые глобальные ключи входят только в копию первого
    // профиля — копия, снятая на установке, где миграция контактов ещё не
    // отработала, всё равно должна что-то содержать.
    const { exact, like } = dialogBackupKeySelectors(profileId);
    const where = [
      ...exact.map(() => 'k = ?'),
      ...like.map(() => 'k LIKE ?'),
    ].join(' OR ');
    const rows = await d.getAllAsync<{ k: string; v: string }>(
      `SELECT k, v FROM kv WHERE ${where}`,
      [...exact, ...like]
    );
    // Запись профиля важнее одноимённой глобальной: глобальная — это остаток
    // до миграции, и она заведомо не новее.
    const out = new Map<string, string>();
    for (const r of rows ?? []) {
      const logical = dialogBackupLogicalKey(r.k);
      if (!logical) continue;
      if (hasProfilePrefix(r.k)) out.set(logical, r.v);
      else if (!out.has(logical)) out.set(logical, r.v);
    }
    return [...out].map(([k, v]) => ({ k, v }));
  } catch (e) {
    log.warn('dialog_kv_export_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * @returns сколько записей действительно записано.
 *
 * v4.32.370: как и у сообщений — раньше `void`, а отбрасывались записи молча
 * и даже без строки в журнале. Здесь это заметнее: в снимке едут настройки
 * переписок, и «восстановилось» с потерянной половиной ключей выглядит ровно
 * как полное восстановление.
 */
export async function importDialogKvSnapshot(
  input: unknown,
  profileId: number
): Promise<number> {
  if (!Array.isArray(input)) return 0;
  // v4.32.193 (Round-23 #4): shape validation + key allowlist. Without these,
  // a tampered backup could overwrite ANY kv key (profile_active_id,
  // wallet_blocked, theme, etc.). Match the SELECT filter in the export path.
  const MAX_V = 1 << 20; // 1MB per entry
  const sanitized: Array<{ k: string; v: string }> = [];
  let dropped = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') { dropped++; continue; }
    const e = raw as { k?: unknown; v?: unknown };
    if (typeof e.k !== 'string' || typeof e.v !== 'string') { dropped++; continue; }
    if (e.v.length > MAX_V) { dropped++; continue; }
    const logical = dialogBackupLogicalKey(e.k);
    if (!logical) { dropped++; continue; }
    sanitized.push({ k: dialogBackupStoredKey(profileId, logical), v: e.v });
  }
  if (dropped > 0) log.warn('dialog_kv_import_dropped', { dropped, total: input.length });
  if (!sanitized.length) return 0;
  try {
    const d = await db();
    await d.execAsync('BEGIN IMMEDIATE');
    try {
      for (const e of sanitized) {
        await d.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [e.k, e.v]);
      }
      await d.execAsync('COMMIT');
    } catch (err) {
      try {
        await d.execAsync('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    emitChatWrites();
    return sanitized.length;
  } catch (e) {
    log.warn('dialog_kv_import_failed', { err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** Profile card and privacy settings are account entities, not device UI prefs. */
export async function exportSyncProfileSettings(
  profileId: number,
): Promise<Array<{ k: string; v: string }>> {
  if (!validSyncProfileId(profileId)) throw new Error('Invalid sync profile id');
  const keys = [...OWN_PROFILE_KEYS, ...PRIVACY_PREF_KEYS];
  const d = await db();
  const rows = await d.getAllAsync<{ k: string; v: string }>(
    `SELECT k, v FROM kv WHERE k IN (${keys.map(() => '?').join(', ')})`,
    keys.map((key) => profileScopedKey(profileId, key)),
  );
  return rows.map((row) => ({
    k: row.k.slice(`p${profileId}:`.length),
    v: row.v,
  }));
}

export async function importSyncProfileSetting(
  input: unknown,
  profileId: number,
): Promise<boolean> {
  if (!validSyncProfileId(profileId) || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const row = input as { k?: unknown; v?: unknown };
  const allowed = new Set<string>([...OWN_PROFILE_KEYS, ...PRIVACY_PREF_KEYS]);
  if (typeof row.k !== 'string' || !allowed.has(row.k) || typeof row.v !== 'string' || row.v.length > (1 << 20)) {
    return false;
  }
  const d = await db();
  await d.runAsync(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
    [profileScopedKey(profileId, row.k), row.v],
  );
  return true;
}

/**
 * Есть ли уже такое сообщение у этого профиля.
 *
 * v4.32.519: профиль обязателен. Это отсев повторов на приёме: раньше он
 * спрашивал про весь телефон, и конверт, уже сохранённый первым аккаунтом,
 * для второго считался повтором и отбрасывался до расшифровки — сообщение не
 * доходило до второго аккаунта никогда, без ошибки и без следа в журнале.
 * Составной ключ этого сам не чинит: строки-то нет, а «повтор» решался здесь.
 */
export async function chatMessageExists(id: string, ownerProfileId: number): Promise<boolean> {
  try {
    const d = await db();
    const r = await d.getFirstAsync<{ n: number }>(
      'SELECT 1 as n FROM chat_messages WHERE id = ? AND owner_profile_id = ? LIMIT 1',
      [id, ownerProfileId]
    );
    return !!r;
  } catch (e) {
    log.warn('chat_message_exists_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
  * v4.32.430: страница диалога запрашивается объектом, а не четырьмя позициями.
  * Причина — измерение: из 79 функций этого файла, принимающих ownerProfileId,
  * 50 ждут его последним, а 29 — вторым. Двух соседних соглашений хватило,
  * чтобы в GroupsScreen написали `listGroupMessages(group.id, pid, 0, 500)`:
  * подпись сестринской функции `listGroupJoinRequests(groupId, pid, status)`
  * стоит строкой выше в том же экране. Три числа подряд (limit, offset,
  * ownerProfileId) тип-система различить не может, поэтому журнал админа
  * молча спрашивал owner_profile_id = 500 и всегда был пуст. Имена в объекте
  * делают эту перестановку ошибкой компиляции.
  */
export type ChatMessagePage = {
  contactPubB64: string;
  limit: number;
  offset: number;
  ownerProfileId: number;
  /**
   * Взять строго старше этой строки вместо отсчёта по `OFFSET` (v4.32.539).
   *
   * `OFFSET` считает строки, а их число меняется под ногами: пришедшее в этот
   * момент сообщение сдвигает всё окно и ровно столько самых старых строк
   * следующей страницы не показывается никогда. См. `chatPageCursor.ts`.
   */
  before?: ChatPageCursor;
};

export async function listChatMessages(
  { contactPubB64, limit, offset, ownerProfileId, before }: ChatMessagePage
): Promise<ChatMessageRow[]> {
  return (await listChatMessagesPage({ contactPubB64, limit, offset, ownerProfileId, before })) ?? [];
}

/**
 * Та же страница, но со сбоем в типе (v4.32.604).
 *
 * `listChatMessages` гасит сбой пустым списком — так его читают живой экран и
 * служба переписки, и менять им договор этот раунд не берётся. А вот полному
 * чтению переписки пустая страница-сбой означает «дальше ничего нет», и молча
 * усечённая выгрузка уходит в файл. См. listAllGroupMessages, v4.32.532.
 */
async function listChatMessagesPage(
  { contactPubB64, limit, offset, ownerProfileId, before }: ChatMessagePage
): Promise<ChatMessageRow[] | null> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{
      id: string;
      contact_pub_b64: string;
      cid: string | null;
      text: string;
      direction: string;
      status: string;
      media_cids: string | null;
      created_at: number;
      owner_profile_id: number;
      reply_to_id: string | null;
      reply_to_preview: string | null;
      edited_at: number | null;
      reactions: string | null;
      starred: number;
      transport: string | null;
    }>(
      before
        ? 'SELECT * FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ?'
          + ' AND (created_at < ? OR (created_at = ? AND id < ?))'
          + ' ORDER BY created_at DESC, id DESC LIMIT ?'
        : 'SELECT * FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      before
        ? [contactPubB64, ownerProfileId, before.createdAt, before.createdAt, before.id, limit]
        : [contactPubB64, ownerProfileId, limit, offset]
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => {
      // v4.32.559: «не прочиталось» отделено от «пусто» до того, как строка
      // уйдёт на экран, — иначе на экране они выглядят одинаково.
      const cell = readAtRestCell(r.text, dek);
      return {
      id: r.id,
      contactPubB64: r.contact_pub_b64,
      cid: r.cid,
      text: cell.state === 'plain' ? cell.text : '',
      unreadable: unreadableFromCellState(cell.state),
      direction: r.direction as 'in' | 'out',
      status: r.status,
      ...readMediaCell(r.media_cids, dek),
      createdAt: r.created_at,
      ownerProfileId: r.owner_profile_id,
      replyToId: r.reply_to_id ?? null,
      ...readReplyCell(r.reply_to_preview ?? null, dek),
      editedAt: r.edited_at ?? null,
      ...readReactionsCell(r.reactions ?? null, dek),
      starred: Boolean(r.starred),
      transport: (r.transport as MessageRoute | null) ?? null,
      };
    });
  } catch (e) {
    log.warn('chat_messages_list_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Read a complete dialog without handing SQLite an unbounded LIMIT.
 *
 * Export and contact-info screens used to request 9,999/99,999 rows at once.
 * Besides allocating the whole decrypted conversation, that made one large
 * native call monopolize the JS/native bridge long enough to look like a
 * frozen app. Keep the public result identical, but page the work and yield
 * between pages so input can be processed while a large archive is exported.
 */
export async function listAllChatMessages(
  { contactPubB64, ownerProfileId }: Pick<ChatMessagePage, 'contactPubB64' | 'ownerProfileId'>
): Promise<DbRead<ChatMessageRow>> {
  const pageSize = 500;
  const out: ChatMessageRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await listChatMessagesPage({ contactPubB64, ownerProfileId, limit: pageSize, offset });
    // v4.32.604: сбой на любой странице обрывает целое — выгружаем либо всё,
    // либо ничего. Прежде провалившаяся страница приходила пустой и читалась
    // как конец переписки.
    if (page === null) return null;
    out.push(...page);
    if (page.length < pageSize) return out;
    offset += page.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Lightweight contact-info stats; it deliberately avoids decrypting history. */
export async function getChatMessageStats(
  contactPubB64: string,
  ownerProfileId: number,
): Promise<{ messageCount: number; sentCount: number; firstMessageAt: number | null }> {
  try {
    const d = await db();
    const row = await d.getFirstAsync<{
      message_count: number;
      sent_count: number;
      first_message_at: number | null;
    }>(
      `SELECT COUNT(*) AS message_count,
              COALESCE(SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END), 0) AS sent_count,
              MIN(created_at) AS first_message_at
       FROM chat_messages
       WHERE contact_pub_b64 = ? AND owner_profile_id = ?`,
      [contactPubB64, ownerProfileId],
    );
    return {
      messageCount: row?.message_count ?? 0,
      sentCount: row?.sent_count ?? 0,
      firstMessageAt: row?.first_message_at ?? null,
    };
  } catch (e) {
    log.warn('chat_message_stats_failed', { err: e instanceof Error ? e.message : String(e) });
    return { messageCount: 0, sentCount: 0, firstMessageAt: null };
  }
}

/** Префикс kv-ключа «опрос завершён». Имя ключа — одно, в kvKeys. */
const POLL_CLOSED_KEY_PREFIX = pollClosedKey('');

/**
 * v4.32.253: следы опроса живут отдельно от строки сообщения — poll_votes
 * хранит, КТО и за что проголосовал, а kv — отметку о завершении. Удаление
 * сообщения их не трогало, поэтому «Удалить у всех», очистка истории и
 * автоудаление стирали текст опроса, но оставляли поимённый список голосов в
 * базе навсегда.
 *
 * Вызывается после удаления строк, поэтому чистит по списку id, а не по
 * условию: id опроса и обычного сообщения снаружи неотличимы, лишний DELETE
 * по несуществующим ключам ничего не стоит.
 *
 * ownerProfileId ограничивает удаление голосов своим профилем: id сообщения
 * приходит от отправителя, поэтому одна и та же строка вполне может лежать в
 * двух профилях сразу, и удаление «у себя» не должно стирать чужие голоса.
 * v4.32.484: отметка о завершении теперь тоже принадлежит профилю, поэтому
 * снимается его запись — и заодно общая, оставшаяся от версий до 484.
 */
async function deletePollArtifacts(
  d: SQLite.SQLiteDatabase,
  messageIds: string[],
  ownerProfileId?: number
): Promise<void> {
  if (!messageIds.length) return;
  // SQLite ограничивает число параметров (по умолчанию 999) — режем с запасом.
  const CHUNK = 400;
  const scope = ownerProfileId === undefined ? '' : ' AND owner_profile_id = ?';
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const ids = messageIds.slice(i, i + CHUNK);
    const marks = ids.map(() => '?').join(',');
    await d.runAsync(
      `DELETE FROM poll_votes WHERE message_id IN (${marks})${scope}`,
      ownerProfileId === undefined ? ids : [...ids, ownerProfileId]
    );
    const closedKeys = ids.map((id) => POLL_CLOSED_KEY_PREFIX + id);
    const scopedKeys =
      ownerProfileId === undefined
        ? []
        : closedKeys.map((k) => profileScopedKey(ownerProfileId, k));
    const allKeys = [...closedKeys, ...scopedKeys];
    await d.runAsync(
      `DELETE FROM kv WHERE k IN (${allKeys.map(() => '?').join(',')})`,
      allKeys
    );
  }
}

/**
 * То же для массовых удалений (очистка истории, автоудаление, выход из группы):
 * список id заранее неизвестен, поэтому следы опросов сносятся подзапросом по
 * тем же строкам, что вот-вот удалятся.
 *
 * Вызывать СТРОГО ДО удаления самих сообщений — после подзапрос вернёт пусто.
 * Подзапросом, а не «удалить всё, для чего нет сообщения»: голос вполне может
 * прийти раньше самого опроса, и такая уборка стёрла бы его на ровном месте.
 *
 * ownerProfileId передаётся отдельным параметром, а не берётся из idSelect:
 * подзапрос отбирает СООБЩЕНИЯ, а условие нужно наложить на ГОЛОСА — это
 * разные таблицы, и без него чистка в одном профиле сносила бы голоса того же
 * сообщения в другом.
 */
async function deletePollArtifactsBySelect(
  d: SQLite.SQLiteDatabase,
  idSelect: string,
  params: SQLite.SQLiteBindValue[],
  ownerProfileId: number
): Promise<void> {
  await d.runAsync(
    `DELETE FROM poll_votes WHERE message_id IN (${idSelect}) AND owner_profile_id = ?`,
    [...params, ownerProfileId]
  );
  // Общая запись — от версий до v4.32.484, своя — нынешняя.
  await d.runAsync(
    `DELETE FROM kv WHERE k IN (SELECT '${POLL_CLOSED_KEY_PREFIX}' || id FROM (${idSelect}))`,
    params
  );
  await d.runAsync(
    `DELETE FROM kv WHERE k IN (SELECT '${profileScopedKey(ownerProfileId, POLL_CLOSED_KEY_PREFIX)}' || id FROM (${idSelect}))`,
    params
  );
}

/**
 * Удалить сообщение локально — строку одного профиля.
 *
 * v4.32.519: профиль стал обязательным. Раньше второй аргумент можно было не
 * передавать, и удаление шло «по id, глобально уникальному messageId». С
 * составным ключом эта посылка перестала быть верной: чужая метка об удалении
 * стирала бы сообщение сразу во всех аккаунтах телефона. Все вызывающие и так
 * передавали профиль — теперь этого требует и подпись.
 */
/**
 * Удалить одно сообщение из своей переписки.
 *
 * v4.32.555: возвращает, получилось ли. Раньше отказ съедался `catch`, функция
 * молча возвращала `void`, и «Удалить у всех» показывало «Сообщение удалено у
 * вас» независимо от того, ушла ли строка из базы.
 */
export async function deleteChatMessage(id: string, ownerProfileId: number): Promise<boolean> {
  try {
    const d = await db();
    // v4.32.272: удаление одного сообщения тоже обязано уносить его вложение из
    // кэша — «удалить у меня» для снимка не должно означать «спрятать из
    // списка». Дорогая часть (проход по переписке) включается только если файл
    // для этого вложения на диске действительно есть.
    const dek = await getOrCreateDataEncryptionKey();
    const doomed = newAttachmentRefs();
    await collectAttachmentRefs(
      d,
      dek,
      'SELECT text, media_cids FROM chat_messages WHERE id = ? AND owner_profile_id = ?',
      [id, ownerProfileId],
      doomed,
    );
    await d.runAsync('DELETE FROM chat_messages WHERE id = ? AND owner_profile_id = ?', [
      id,
      ownerProfileId,
    ]);
    await deletePollArtifacts(d, [id], ownerProfileId);
    await dropOrphanBlobCache(doomed);
    emitChatWrites();
    return true;
  } catch (e) {
    log.warn('chat_message_delete_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * v4.32.186 (Round-16 #1,#2,#3): return contactPubB64 + direction for a given
 * message id so peer-sent delete/edit/read_receipt can verify authorship
 * before mutating local rows. Previously any peer could wipe/edit ANY local
 * message by guessing the id.
 */
export async function getChatMessageAuthor(
  id: string,
  ownerProfileId: number,
): Promise<{ contactPubB64: string; direction: string } | null> {
  try {
    const d = await db();
    const row = await d.getFirstAsync<{ contact_pub_b64: string; direction: string }>(
      'SELECT contact_pub_b64, direction FROM chat_messages WHERE id = ? AND owner_profile_id = ? LIMIT 1',
      [id, ownerProfileId]
    );
    return row ? { contactPubB64: row.contact_pub_b64, direction: row.direction } : null;
  } catch (e) {
    log.warn('get_chat_message_author_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * v4.32.276: clearChatMessages удалён. Это была вторая, ничем не вызываемая
 * «очистка переписки» рядом с clearChatHistory — и копии уже разошлись:
 * clearChatHistory ещё и сбрасывает строку conversations (счётчик непрочитанных,
 * превью, черновик), а clearChatMessages оставлял её как есть. Каждая новая
 * чистка (артефакты опросов, кэш вложений, корзина) требовала правки в двух
 * местах, и половина этой работы уходила в мёртвый код.
 */

export async function updateChatMessageStatus(
  id: string,
  status: string,
  ownerProfileId: number
): Promise<void> {
  try {
    const d = await db();
    await d.runAsync(
      'UPDATE chat_messages SET status = ? WHERE id = ? AND owner_profile_id = ?',
      [status, id, ownerProfileId]
    );
    emitChatWrites();
  } catch (e) {
    log.warn('chat_message_status_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * v4.32.181 (Round-11 #3): Boot-time sweep for orphan 'sending' messages.
 * If the process crashed / was killed mid-flush, rows get stuck in 'sending'
 * status forever and the UI shows an eternal spinner. Mark anything older than
 * 60s as 'failed' so the user can retry.
 */
export async function sweepOrphanSendingMessages(): Promise<void> {
  try {
    const d = await db();
    const cutoff = Date.now() - 60_000;
    const res = await d.runAsync(
      "UPDATE chat_messages SET status = 'failed' WHERE status = 'sending' AND created_at < ?",
      [cutoff]
    );
    if (res.changes > 0) {
      log.info('sweep_orphan_sending', { marked_failed: res.changes });
      emitChatWrites();
    }
  } catch (e) {
    log.warn('sweep_orphan_sending_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Изменить текст существующего сообщения (редактирование). */
/**
 * Заменить текст своего сообщения.
 *
 * v4.32.555: возвращает, получилось ли — по той же причине, что и
 * `deleteChatMessage`.
 */
export async function updateChatMessageText(
  id: string,
  newText: string,
  ownerProfileId: number
): Promise<boolean> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const textEnc = encryptAtRestString(newText, dek);
    await d.runAsync(
      'UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ? AND owner_profile_id = ?',
      [textEnc, Date.now(), id, ownerProfileId]
    );
    emitChatWrites();
    return true;
  } catch (e) {
    log.warn('chat_message_edit_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Читает outbox БЕЗ удаления — вызывай `outboxDeleteById` после успешной доставки каждого item.
 * Раньше DELETE происходил сразу, и при краше во время sync все сообщения терялись безвозвратно.
 *
 * v4.32.500. Потолка у выборки не было. Каждая строка проходит через
 * decryptAtRestString, то есть весь ответ живёт в памяти расшифрованным, и
 * накопившаяся за неделю офлайна очередь укладывала приложение по памяти ровно
 * в ту минуту, когда телефон наконец поймал сеть, — а затем повторяла это при
 * каждом следующем подключении, потому что ни одна строка не успевала уйти.
 *
 * Теперь выдаётся окно: `limit` строк начиная с `offset`. Порядок выдачи
 * (priority DESC, id ASC) детерминирован, так что вызывающая сторона обходит
 * очередь целиком, сдвигая offset на число строк, которые остались лежать на
 * своих местах.
 */
export async function outboxDrain(
  limit: number = OUTBOX_DRAIN_LIMIT,
  offset: number = 0,
  ownerProfileId: number | null = null
): Promise<OutboxItem[]> {
  try {
    const d = await db();
    // v4.32.522: чужие строки отсеиваются запросом, а не после расшифровки.
    // Разбор всё равно их пропускал, но сначала поднимал в память и расшифровывал
    // — а главное, они занимали место в окне. Окон за один заход ограниченное
    // число, поэтому длинная очередь неактивного аккаунта просто не давала
    // дойти до конвертов активного: его сообщения не уходили вовсе, и чем
    // дольше сосед копил очередь, тем прочнее.
    const mine = ownerProfileId === null
      ? ''
      : ' AND (owner_profile_id = ? OR owner_profile_id IS NULL)';
    const args: (number | null)[] = [OUTBOX_MAX_ATTEMPTS];
    if (ownerProfileId !== null) args.push(ownerProfileId);
    // Мусор в аргументах не должен превращаться в выборку без потолка.
    args.push(
      Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), OUTBOX_MAX_ROWS) : OUTBOX_DRAIN_LIMIT,
      Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    );
    // P1 Block 7: skip items that have already failed OUTBOX_MAX_ATTEMPTS times.
    const rows = await d.getAllAsync<{
      id: number;
      kind: string;
      payload: string;
      created_at: number;
      priority: number | null;
      owner_profile_id: number | null;
      attempts: number | null;
    }>(
      `SELECT id, kind, payload, created_at, priority, owner_profile_id, attempts
       FROM outbox
       WHERE COALESCE(attempts, 0) < ?${mine}
       ORDER BY priority DESC, id ASC
       LIMIT ? OFFSET ?`,
      args
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: decryptAtRestString(r.payload, dek),
      createdAt: r.created_at,
      priority: r.priority ?? 0,
      ownerProfileId: r.owner_profile_id ?? null,
      attempts: r.attempts ?? 0,
    }));
  } catch (e) {
    log.warn('outbox_drain_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Удалить конкретный outbox-элемент после успешной доставки. */
export async function outboxDeleteById(id: number): Promise<void> {
  try {
    const d = await db();
    await d.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
  } catch (e) {
    log.warn('outbox_delete_by_id_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * v4.32.124 (AUDIT P1 Block 7): вызывать из sync-loop при неуспешной доставке.
 * Когда счётчик перешагнёт OUTBOX_MAX_ATTEMPTS, outboxDrain перестанет возвращать
 * этот item — он остаётся в БД для диагностики, но больше не трогается.
 *
 * Возвращает true, пока строка ещё будет выдаваться outboxDrain. Ответ нужен
 * разбору очереди: окно сдвигается на число строк, оставшихся лежать на своих
 * местах, а строка, исчерпавшая попытки, из следующей выборки уже исключена
 * запросом — считать её «оставшейся» значит перепрыгнуть через один живой
 * конверт (v4.32.581). Сбой самого UPDATE тоже даёт true: счётчик не вырос,
 * строка никуда не делась.
 */
export async function outboxIncrementAttempts(id: number): Promise<boolean> {
  try {
    const d = await db();
    await d.runAsync(
      'UPDATE outbox SET attempts = COALESCE(attempts, 0) + 1 WHERE id = ?',
      [id]
    );
    const row = await d.getFirstAsync<{ attempts: number | null }>(
      'SELECT attempts FROM outbox WHERE id = ?',
      [id]
    );
    // Строки нет — её успели удалить; «оставшейся на месте» она тем более не является.
    if (!row) return false;
    return (row.attempts ?? 0) < OUTBOX_MAX_ATTEMPTS;
  } catch (e) {
    log.warn('outbox_increment_attempts_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return true;
  }
}

// ─── Conversations ───────────────────────────────────────────────────────────

/** Список диалогов для данного профиля, отсортированных по закреплённым + времени. */
export async function listConversations(ownerProfileId: number): Promise<ConversationRow[]> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{
      contact_pub_b64: string;
      owner_profile_id: number;
      unread_count: number;
      draft_text: string | null;
      pinned: number;
      archived: number;
      muted: number;
      muted_until: number | null;
      last_message_at: number;
      last_message_preview: string | null;
      last_message_direction: string | null;
      pinned_message_id: string | null;
      disappear_after_ms: number | null;
      color_tag: string | null;
    }>(
      `SELECT * FROM conversations
       WHERE owner_profile_id = ? AND archived = 0
       ORDER BY pinned DESC, last_message_at DESC`,
      [ownerProfileId]
    );
    const now = Date.now();
    // v4.32.218 (CRIT-4 part 2): transparently decrypt preview/draft. Rows
    // written before v218 are still plaintext — decryptAtRestNullable passes
    // them through (no enc2: prefix), so migration is implicit on next write.
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => {
      const mutedUntil = r.muted_until ?? null;
      const effectiveMuted = isEffectivelyMuted(r.muted, mutedUntil, now);
      // v4.32.580: подпись последней реплики читается тремя состояниями.
      // decryptAtRestNullable сводил непрочитанный столбец к пустой строке, и
      // строка списка выглядела как переписка, в которой ничего не писали.
      const prevCell = readAtRestCell(r.last_message_preview, dek);
      /**
       * v4.32.583: черновик читается тремя состояниями. Непрочитанный столбец
       * приходил пустой строкой, а она проходит проверку «черновика нет»: ни
       * подписи в списке, ни текста в поле ввода — и первая же отложенная
       * запись затирала его пустотой (см. draftGuard).
       */
      const draftCell = readAtRestCell(r.draft_text, dek);
      return {
        contactPubB64: r.contact_pub_b64,
        ownerProfileId: r.owner_profile_id,
        unreadCount: r.unread_count,
        draftText: cellTextOrNull(draftCell),
        draftUnreadable: unreadableFromCellState(draftCell.state),
        pinned: r.pinned === 1,
        archived: r.archived === 1,
        muted: effectiveMuted,
        mutedUntil,
        lastMessageAt: r.last_message_at,
        lastMessagePreview: cellTextOrNull(prevCell),
        lastMessagePreviewUnreadable: unreadableFromCellState(prevCell.state),
        lastMessageDirection: (r.last_message_direction as 'in' | 'out' | null) ?? null,
        pinnedMessageId: r.pinned_message_id ?? null,
        disappearAfterMs: r.disappear_after_ms ?? null,
        colorTag: r.color_tag ?? null,
      };
    });
  } catch (e) {
    log.warn('conversations_list_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Список архивированных диалогов. */
export async function listArchivedConversations(ownerProfileId: number): Promise<ConversationRow[]> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{
      contact_pub_b64: string;
      owner_profile_id: number;
      unread_count: number;
      draft_text: string | null;
      pinned: number;
      archived: number;
      muted: number;
      muted_until: number | null;
      last_message_at: number;
      last_message_preview: string | null;
      last_message_direction: string | null;
      pinned_message_id: string | null;
      disappear_after_ms: number | null;
      color_tag: string | null;
    }>(
      `SELECT * FROM conversations
       WHERE owner_profile_id = ? AND archived = 1
       ORDER BY last_message_at DESC`,
      [ownerProfileId]
    );
    const now = Date.now();
    // v4.32.218 (CRIT-4 part 2): decrypt preview/draft at rest.
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => {
      const mutedUntil = r.muted_until ?? null;
      const effectiveMuted = isEffectivelyMuted(r.muted, mutedUntil, now);
      // v4.32.580: тем же правилом, что в списке выше.
      const prevCell = readAtRestCell(r.last_message_preview, dek);
      // v4.32.583: черновик — тем же правилом (см. draftGuard).
      const draftCell = readAtRestCell(r.draft_text, dek);
      return {
        contactPubB64: r.contact_pub_b64,
        ownerProfileId: r.owner_profile_id,
        unreadCount: r.unread_count,
        draftText: cellTextOrNull(draftCell),
        draftUnreadable: unreadableFromCellState(draftCell.state),
        pinned: r.pinned === 1,
        archived: r.archived === 1,
        muted: effectiveMuted,
        mutedUntil,
        lastMessageAt: r.last_message_at,
        lastMessagePreview: cellTextOrNull(prevCell),
        lastMessagePreviewUnreadable: unreadableFromCellState(prevCell.state),
        lastMessageDirection: (r.last_message_direction as 'in' | 'out' | null) ?? null,
        pinnedMessageId: r.pinned_message_id ?? null,
        disappearAfterMs: r.disappear_after_ms ?? null,
        colorTag: r.color_tag ?? null,
      };
    });
  } catch (e) {
    log.warn('conversations_archived_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Обновить/создать запись диалога после отправки/получения сообщения. */

export async function touchConversation(
  contactPubB64: string,
  ownerProfileId: number,
  preview: string,
  direction: 'in' | 'out',
  incrementUnread: boolean
): Promise<void> {
  try {
    const d = await db();
    // v4.32.218 (Paranoid CRIT-4 part 2): encrypt message preview at rest.
    // v4.32.224 (Paranoid re-audit): fetch the DEK BEFORE opening the
    // BEGIN IMMEDIATE transaction. Previously getOrCreateDataEncryptionKey()
    // ran inside the tx — it hits SecureStore/Keystore via a serialised queue,
    // holding the SQLite write lock for up to hundreds of ms on cold start
    // and starving concurrent writers.
    const previewTrunc = preview.slice(0, LAST_MESSAGE_PREVIEW_MAX);
    const dek = await getOrCreateDataEncryptionKey();
    const previewEnc = previewTrunc ? encryptAtRestString(previewTrunc, dek) : '';
    // Читаем ДО BEGIN IMMEDIATE по той же причине, что и DEK: внутри
    // транзакции этот запрос держал бы write-lock.
    const defaultDisappear = await getDefaultDisappearMsFor(ownerProfileId);
    // v4.32.134 (AUDIT P1): the SELECT-then-UPDATE/INSERT dance races with
    // itself when two deliveries for a new contact land concurrently (e.g.
    // LAN + internet retry). Wrapping in BEGIN IMMEDIATE serialises
    // observers, so either both see "missing" and one INSERT wins cleanly,
    // or one sees the row the other just inserted and UPDATEs it.
    await d.execAsync('BEGIN IMMEDIATE;');
    try {
      const existing = await d.getFirstAsync<{
        unread_count: number;
        disappear_after_ms: number | null;
        last_message_at: number | null;
      }>(
        'SELECT unread_count, disappear_after_ms, last_message_at FROM conversations WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
        [contactPubB64, ownerProfileId]
      );
      // Значение по умолчанию ставится ровно один раз — при первом сообщении в
      // разговоре. Строка могла появиться и раньше (закрепление/архив/черновик
      // для контакта без переписки), поэтому «новизна» определяется отсутствием
      // сообщений, а не отсутствием строки. NULL здесь означает «пользователь
      // ничего не выбирал»: явное «Выкл» пишется как 0, иначе настройка
      // переустанавливала бы таймер, который человек только что снял.
      const applyDefault = shouldApplyDefaultAutoDelete({
        defaultMs: defaultDisappear,
        exists: !!existing,
        currentMs: existing?.disappear_after_ms ?? null,
        lastMessageAt: existing?.last_message_at ?? null,
      });
      const now = Date.now();
      if (existing) {
        const newUnread = incrementUnread ? existing.unread_count + 1 : existing.unread_count;
        if (previewTrunc) {
          await d.runAsync(
            `UPDATE conversations SET last_message_at = ?, last_message_preview = ?, last_message_direction = ?, unread_count = ?
             WHERE contact_pub_b64 = ? AND owner_profile_id = ?`,
            [now, previewEnc, direction, newUnread, contactPubB64, ownerProfileId]
          );
        } else {
          // BLE presence ping — only update timestamp and unread, preserve existing preview
          await d.runAsync(
            `UPDATE conversations SET last_message_at = ?, unread_count = ?
             WHERE contact_pub_b64 = ? AND owner_profile_id = ?`,
            [now, newUnread, contactPubB64, ownerProfileId]
          );
        }
      } else {
        await d.runAsync(
          `INSERT OR IGNORE INTO conversations (contact_pub_b64, owner_profile_id, unread_count, last_message_at, last_message_preview, last_message_direction)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [contactPubB64, ownerProfileId, incrementUnread ? 1 : 0, now, previewTrunc ? previewEnc : null, direction]
        );
      }
      if (applyDefault) {
        await d.runAsync(
          `UPDATE conversations SET disappear_after_ms = ?, disappear_set_at = ?
           WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND disappear_after_ms IS NULL`,
          [defaultDisappear, now, contactPubB64, ownerProfileId]
        );
      }
      await d.execAsync('COMMIT;');
    } catch (inner) {
      try { await d.execAsync('ROLLBACK;'); } catch { /* ignore */ }
      throw inner;
    }
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_touch_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Сбросить счётчик непрочитанных для диалога (открыли чат). */
export async function markConversationRead(
  contactPubB64: string,
  ownerProfileId: number
): Promise<void> {
  try {
    const d = await db();
    // v4.32.526: `AND unread_count != 0` — не ради экономии записи, а ради
    // честного changes: UPDATE, кладущий в колонку то же значение, SQLite
    // всё равно считает изменением, и сигнал ниже уходил бы вхолостую.
    const res = await d.runAsync(
      'UPDATE conversations SET unread_count = 0 WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND unread_count != 0',
      [contactPubB64, ownerProfileId]
    );
    if (anyChanged(res)) emitChatWrites();
  } catch (e) {
    log.warn('conversation_mark_read_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Пометить все диалоги профиля как прочитанные. */
export async function markAllConversationsRead(ownerProfileId: number): Promise<void> {
  try {
    const d = await db();
    const convs = await d.runAsync(
      'UPDATE conversations SET unread_count = 0 WHERE owner_profile_id = ? AND unread_count != 0',
      [ownerProfileId]
    );
    const grps = await d.runAsync(
      `UPDATE groups SET unread_count = 0, mention_count = 0
       WHERE owner_profile_id = ? AND (unread_count != 0 OR mention_count != 0)`,
      [ownerProfileId]
    );
    // Достаточно одного настоящего изменения в любой из двух таблиц.
    if (anyChanged(convs, grps)) emitChatWrites();
  } catch (e) {
    log.warn('mark_all_read_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Пометить диалог как непрочитанный (ставит unread_count = 1 если было 0). */
export async function markConversationUnread(
  contactPubB64: string,
  ownerProfileId: number
): Promise<void> {
  try {
    const d = await db();
    // v4.32.526: условие переехало из CASE в WHERE. Смысл тот же — «поднять
    // до единицы, только если было ноль», — но теперь строка, которой менять
    // нечего, не попадает под запрос вовсе, и changes перестал врать.
    const res = await d.runAsync(
      'UPDATE conversations SET unread_count = 1 WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND unread_count = 0',
      [contactPubB64, ownerProfileId]
    );
    if (anyChanged(res)) emitChatWrites();
  } catch (e) {
    log.warn('conversation_mark_unread_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Сохранить черновик сообщения (null = очистить). */
export async function setConversationDraft(
  contactPubB64: string,
  ownerProfileId: number,
  draft: string | null
): Promise<void> {
  try {
    const d = await db();
    const exists = await d.getFirstAsync<{ contact_pub_b64: string }>(
      'SELECT contact_pub_b64 FROM conversations WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
      [contactPubB64, ownerProfileId]
    );
    // v4.32.218: encrypt draft at rest (see CRIT-4 part 2 note in touchConversation).
    const dek = await getOrCreateDataEncryptionKey();
    const draftEnc = encryptAtRestNullable(draft, dek);
    if (exists) {
      await d.runAsync(
        'UPDATE conversations SET draft_text = ? WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
        [draftEnc, contactPubB64, ownerProfileId]
      );
    } else {
      await d.runAsync(
        'INSERT INTO conversations (contact_pub_b64, owner_profile_id, draft_text) VALUES (?, ?, ?)',
        [contactPubB64, ownerProfileId, draftEnc]
      );
    }
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_draft_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Закрепить / открепить диалог. */
export async function setConversationPinned(
  contactPubB64: string,
  ownerProfileId: number,
  pinned: boolean
): Promise<void> {
  try {
    const d = await db();
    // v4.32.173: atomic upsert. Раньше SELECT→if→INSERT/UPDATE давал гонку:
    // два параллельных pin-тогла могли оба пройти SELECT (нет строки) и оба
    // сделать INSERT → UNIQUE constraint violation.
    await d.runAsync(
      `INSERT INTO conversations (contact_pub_b64, owner_profile_id, pinned) VALUES (?, ?, ?)
       ON CONFLICT(contact_pub_b64, owner_profile_id) DO UPDATE SET pinned = excluded.pinned`,
      [contactPubB64, ownerProfileId, pinned ? 1 : 0]
    );
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_pin_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Архивировать / разархивировать диалог. */
export async function setConversationArchived(
  contactPubB64: string,
  ownerProfileId: number,
  archived: boolean
): Promise<void> {
  try {
    const d = await db();
    await d.runAsync(
      `INSERT INTO conversations (contact_pub_b64, owner_profile_id, archived) VALUES (?, ?, ?)
       ON CONFLICT(contact_pub_b64, owner_profile_id) DO UPDATE SET archived = excluded.archived`,
      [contactPubB64, ownerProfileId, archived ? 1 : 0]
    );
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_archive_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Беззвучный режим / включить звук для диалога. */
export async function setConversationMuted(
  contactPubB64: string,
  ownerProfileId: number,
  muted: boolean
): Promise<void> {
  try {
    const d = await db();
    const exists = await d.getFirstAsync<{ contact_pub_b64: string }>(
      'SELECT contact_pub_b64 FROM conversations WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
      [contactPubB64, ownerProfileId]
    );
    if (exists) {
      await d.runAsync(
        'UPDATE conversations SET muted = ?, muted_until = NULL WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
        [muted ? 1 : 0, contactPubB64, ownerProfileId]
      );
    } else {
      await d.runAsync(
        'INSERT INTO conversations (contact_pub_b64, owner_profile_id, muted) VALUES (?, ?, ?)',
        [contactPubB64, ownerProfileId, muted ? 1 : 0]
      );
    }
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_mute_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Беззвучный режим с таймером.
 * @param until null = навсегда, Date.now()+ms = до указанного времени
 * Передайте until=0 или вызовите setConversationMuted(…, false) для отключения.
 */
export async function setConversationMutedUntil(
  contactPubB64: string,
  ownerProfileId: number,
  until: number | null
): Promise<void> {
  try {
    const d = await db();
    const exists = await d.getFirstAsync<{ contact_pub_b64: string }>(
      'SELECT contact_pub_b64 FROM conversations WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
      [contactPubB64, ownerProfileId]
    );
    if (exists) {
      await d.runAsync(
        'UPDATE conversations SET muted = 1, muted_until = ? WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
        [until, contactPubB64, ownerProfileId]
      );
    } else {
      await d.runAsync(
        'INSERT INTO conversations (contact_pub_b64, owner_profile_id, muted, muted_until) VALUES (?, ?, 1, ?)',
        [contactPubB64, ownerProfileId, until]
      );
    }
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_mute_until_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Установить/сбросить таймер автоудаления сообщений для диалога.
 *
 * Вместе с таймером записывается момент его включения: удаляются только
 * сообщения, написанные после этого момента (см. purgeDisappearedMessages).
 * Строка разговора может ещё не существовать — например, таймер выставили в
 * чате, где не отправлено ни одного сообщения, — поэтому INSERT OR IGNORE.
 */
export async function setConversationDisappearTimer(
  contactPubB64: string,
  ownerProfileId: number,
  disappearAfterMs: number | null
): Promise<void> {
  try {
    const d = await db();
    const setAt = disappearAfterMs != null && disappearAfterMs > 0 ? Date.now() : null;
    await d.runAsync(
      'INSERT OR IGNORE INTO conversations (contact_pub_b64, owner_profile_id) VALUES (?, ?)',
      [contactPubB64, ownerProfileId]
    );
    await d.runAsync(
      'UPDATE conversations SET disappear_after_ms = ?, disappear_set_at = ? WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
      [disappearAfterMs, setAt, contactPubB64, ownerProfileId]
    );
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_disappear_timer_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Привести строку диалога в соответствие с оставшимися сообщениями.
 *
 * v4.32.238. Автоудаление стирало сами сообщения, но не следы от них:
 * last_message_preview продолжал показывать текст удалённого сообщения в
 * списке диалогов, закреплённое сообщение оставалось в баннере, а badge
 * считал непрочитанные, которых уже нет. Для функции, смысл которой —
 * не оставлять переписку на устройстве, это дыра, а не косметика.
 */
async function refreshConversationAfterPurge(
  d: SQLite.SQLiteDatabase,
  dek: Uint8Array,
  contactPubB64: string,
  ownerProfileId: number
): Promise<void> {
  const last = await d.getFirstAsync<{ text: string; created_at: number; direction: string }>(
    'SELECT text, created_at, direction FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ? ORDER BY created_at DESC LIMIT 1',
    [contactPubB64, ownerProfileId]
  );
  if (last) {
    // v4.32.556: подпись пересобирается ТОЛЬКО из прочитанного текста. Если
    // столбец не открылся, `decryptAtRestString` вернул бы пустую строку, и
    // она легла бы поверх прежней подписи — а прежняя верна: её сложили,
    // когда сообщение ещё читалось. См. unreadableCell.previewAction.
    const cell = readAtRestCell(last.text, dek);
    const action = previewAction(true, cell.state === 'plain');
    // unread_count — счётчик, а не выборка, поэтому его нельзя пересчитать;
    // но он не вправе быть больше числа доживших входящих сообщений.
    const inbox = await d.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) as n FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND direction = 'in'",
      [contactPubB64, ownerProfileId]
    );
    if (mayWritePreview(action)) {
      const preview = previewLabelForText(cell.state === 'plain' ? cell.text : '').slice(0, LAST_MESSAGE_PREVIEW_MAX);
      await d.runAsync(
        `UPDATE conversations SET last_message_at = ?, last_message_preview = ?, last_message_direction = ?, unread_count = MIN(unread_count, ?)
         WHERE contact_pub_b64 = ? AND owner_profile_id = ?`,
        [last.created_at, encryptAtRestString(preview, dek), last.direction, inbox?.n ?? 0, contactPubB64, ownerProfileId]
      );
    } else {
      log.warn('conversation_preview_kept_unreadable', { ownerProfileId });
      await d.runAsync(
        `UPDATE conversations SET last_message_at = ?, last_message_direction = ?, unread_count = MIN(unread_count, ?)
         WHERE contact_pub_b64 = ? AND owner_profile_id = ?`,
        [last.created_at, last.direction, inbox?.n ?? 0, contactPubB64, ownerProfileId]
      );
    }
  } else {
    await d.runAsync(
      `UPDATE conversations SET last_message_at = 0, last_message_preview = NULL, last_message_direction = NULL, unread_count = 0
       WHERE contact_pub_b64 = ? AND owner_profile_id = ?`,
      [contactPubB64, ownerProfileId]
    );
  }
  await d.runAsync(
    `UPDATE conversations SET pinned_message_id = NULL
     WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND pinned_message_id IS NOT NULL
       AND pinned_message_id NOT IN (SELECT id FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ?)`,
    [contactPubB64, ownerProfileId, contactPubB64, ownerProfileId]
  );
}

/** То же для группы: превью, счётчики и текст закреплённого сообщения. */
async function refreshGroupAfterPurge(
  d: SQLite.SQLiteDatabase,
  dek: Uint8Array,
  groupId: string,
  ownerProfileId: number
): Promise<void> {
  const last = await d.getFirstAsync<{
    text: string;
    created_at: number;
    sender_name: string | null;
    sender_pub_b64: string;
  }>(
    'SELECT text, created_at, sender_name, sender_pub_b64 FROM group_messages WHERE group_id = ? AND owner_profile_id = ? ORDER BY created_at DESC LIMIT 1',
    [groupId, ownerProfileId]
  );
  const left = await d.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM group_messages WHERE group_id = ? AND owner_profile_id = ?',
    [groupId, ownerProfileId]
  );
  const remaining = left?.n ?? 0;
  if (last) {
    // То же правило, что и в диалоге (v4.32.556): непрочитанный текст не
    // становится пустой подписью и не затирает прежнюю.
    const cell = readAtRestCell(last.text, dek);
    if (mayWritePreview(previewAction(true, cell.state === 'plain'))) {
      const preview = previewLabelForText(cell.state === 'plain' ? cell.text : '').slice(0, LAST_MESSAGE_PREVIEW_MAX);
      await d.runAsync(
        `UPDATE groups SET last_message_at = ?, last_message_preview = ?, last_message_sender_name = ?, last_message_sender_pub = ?,
                unread_count = MIN(unread_count, ?), mention_count = MIN(mention_count, ?)
         WHERE id = ? AND owner_profile_id = ?`,
        // sender_name переносится как есть: обе колонки шифруются одним ключом,
        // так что расшифровывать и зашифровывать обратно незачем.
        [last.created_at, encryptAtRestString(preview, dek), last.sender_name, last.sender_pub_b64, remaining, remaining, groupId, ownerProfileId]
      );
    } else {
      log.warn('group_preview_kept_unreadable', { ownerProfileId });
      await d.runAsync(
        `UPDATE groups SET last_message_at = ?, last_message_sender_name = ?, last_message_sender_pub = ?,
                unread_count = MIN(unread_count, ?), mention_count = MIN(mention_count, ?)
         WHERE id = ? AND owner_profile_id = ?`,
        [last.created_at, last.sender_name, last.sender_pub_b64, remaining, remaining, groupId, ownerProfileId]
      );
    }
  } else {
    await d.runAsync(
      `UPDATE groups SET last_message_at = 0, last_message_preview = NULL, last_message_sender_name = NULL, last_message_sender_pub = NULL,
              unread_count = 0, mention_count = 0
       WHERE id = ? AND owner_profile_id = ?`,
      [groupId, ownerProfileId]
    );
  }
  // pinned_message_text хранит копию текста, поэтому одного обнуления id мало:
  // без второй колонки закреплённое сообщение осталось бы в баннере целиком.
  await d.runAsync(
    `UPDATE groups SET pinned_message_id = NULL, pinned_message_text = NULL
     WHERE id = ? AND owner_profile_id = ? AND pinned_message_id IS NOT NULL
       AND pinned_message_id NOT IN (SELECT id FROM group_messages WHERE group_id = ? AND owner_profile_id = ?)`,
    [groupId, ownerProfileId, groupId, ownerProfileId]
  );
}

/**
 * Delete messages older than their conversation's disappear_after_ms timer.
 * Call periodically (e.g. every 60s) from App.tsx.
 */
/**
 * Файлы, за которые отвечает сообщение: расшифрованные вложения (по id) и
 * собственная запись голосового (по адресу в кэше приложения).
 */
type AttachmentRefs = {
  ids: Set<string>;
  uris: Set<string>;
  /**
   * v4.32.564: сколько строк обошли и скольким ячейкам не смогли заглянуть
   * внутрь. Без этого счёта короткий список ссылок был неотличим от честного
   * короткого списка — см. refScanTally.
   */
  scan: RefScanTally;
};

function newAttachmentRefs(): AttachmentRefs {
  return { ids: new Set<string>(), uris: new Set<string>(), scan: emptyRefScanTally() };
}

/**
 * Ссылки на файлы из строк, которые вот-вот будут удалены.
 *
 * Текст и media_cids лежат зашифрованными, поэтому отобрать нужное запросом
 * нельзя — строки читаются и расшифровываются тем же условием, что и DELETE
 * ниже, чтобы множества совпадали ровно.
 */
async function collectAttachmentRefs(
  d: SQLite.SQLiteDatabase,
  dek: Uint8Array,
  sql: string,
  params: SQLite.SQLiteBindValue[],
  into: AttachmentRefs
): Promise<void> {
  const rows = await d.getAllAsync<{ text: string | null; media_cids: string | null }>(sql, params);
  for (const r of rows) {
    countScannedRow(into.scan);
    // v4.32.564: читаем состоянием, а не строкой. decryptAtRestString отдаёт
    // на неудаче пустую строку, из которой не вынимается ни одного имени, —
    // то есть непрочитанная строка молча заявляла, что ни на какие файлы не
    // ссылается, и её вложение тут же объявлялось сиротой.
    const textCell = readAtRestCell(r.text ?? null, dek);
    countScannedCell(into.scan, textCell.state);
    const text = textCell.state === 'plain' ? textCell.text : null;
    for (const id of blobCacheIdsIn(text)) into.ids.add(id);
    for (const uri of voiceFileUrisIn(text)) into.uris.add(uri);
    const cidsCell = readAtRestCell(r.media_cids ?? null, dek);
    countScannedCell(into.scan, cidsCell.state);
    for (const id of blobCacheIdsIn(cidsCell.state === 'plain' ? cidsCell.text : null)) into.ids.add(id);
  }
}

/**
 * Все таблицы, чьи строки могут ссылаться на файл в кэше вложений.
 *
 * v4.32.518: раньше «живыми» считались ссылки только из chat_messages и
 * group_messages. Отложенное сообщение с фотографией, сторис и конверт,
 * ждущий отправки в outbox, в этот список не входили — и файл, нужный им и
 * только им, объявлялся сиротой. Все перечисленные колонки зашифрованы одним
 * и тем же ключом, поэтому читаются одинаково.
 *
 * Условия WHERE нет намеренно: кэш один на приложение, а профилей на нём
 * несколько. Ссылка из чужого профиля — такая же живая ссылка.
 */
const ATTACHMENT_REF_SOURCES: string[] = [
  'SELECT text, media_cids FROM chat_messages',
  'SELECT text, media_cids FROM group_messages',
  'SELECT text, media_cids FROM scheduled_messages',
  'SELECT text, media_uri AS media_cids FROM stories',
  'SELECT payload AS text, NULL AS media_cids FROM outbox',
];

/**
 * Ссылки на файлы вложений из всех уцелевших строк базы.
 *
 * Нужна двум местам сразу: уборке кэша по возрасту (sweepMediaCache) и
 * удалению файлов вслед за удалёнными сообщениями (dropOrphanBlobCache).
 * Оба решают один вопрос — «нужен ли ещё этот файл кому-нибудь», — и
 * отвечать на него двумя разными списками таблиц значило бы, что одно из
 * двух мест однажды сотрёт нужное.
 *
 * Стоит полной расшифровки переписки, поэтому зовётся только там, где на
 * диске действительно есть что удалять.
 */
export async function liveAttachmentRefs(): Promise<AttachmentRefs> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  const alive = newAttachmentRefs();
  for (const sql of ATTACHMENT_REF_SOURCES) {
    await collectAttachmentRefs(d, dek, sql, [], alive);
  }
  return alive;
}

/**
 * То же самое для уборщика кэша вложений: ему нужны только id.
 *
 * Отдельная функция, а не `.ids` на месте вызова, — чтобы у mediaBlob не
 * появилось знания о форме AttachmentRefs: там решают судьбу файла по имени,
 * и множество строк для этого достаточно.
 */
export async function liveAttachmentBlobIds(): Promise<ReadonlySet<string>> {
  const alive = await liveAttachmentRefs();
  // v4.32.564: неполный обход — не короткий список, а отсутствие ответа.
  // sweepMediaCache уже умеет останавливаться, когда живых ссылок получить не
  // удалось; до этой версии ей просто не о чем было узнать.
  if (!mayDeleteUnreferenced(alive.scan)) {
    throw new Error(`ref_scan_incomplete:${alive.scan.unreadableCells}/${alive.scan.rows}`);
  }
  return alive.ids;
}

/**
 * Стереть файлы, на которые больше не ссылается ни одна уцелевшая строка.
 *
 * Кэш общий на приложение, поэтому удалять файл можно только убедившись, что на
 * него не ссылается ни одна уцелевшая строка: при пересылке одно и то же
 * вложение попадает в два сообщения, и стереть его вместе с первым значило бы
 * сломать второе. Полный проход стоит расшифровки всех строк, поэтому зовётся
 * только там, где сообщения действительно удалены, и только если удаляемый
 * файл на диске вообще есть.
 */
async function dropOrphanBlobCache(doomed: AttachmentRefs): Promise<void> {
  if (doomed.ids.size === 0 && doomed.uris.size === 0) return;
  try {
    const { cachedBlobIdsPresent, cachedFileUrisPresent, deleteCachedBlobs, deleteCachedFileUris } =
      await import('../media/mediaBlob');
    // Сначала дешёвая проверка диска: у текстового сообщения ни вложений, ни
    // записи нет, и платить проходом по всей переписке не за что.
    const [presentIds, presentUris] = await Promise.all([
      cachedBlobIdsPresent(doomed.ids),
      cachedFileUrisPresent(doomed.uris),
    ]);
    if (presentIds.length === 0 && presentUris.length === 0) return;
    const alive = await liveAttachmentRefs();
    // v4.32.564: то же правило, что и у суточной уборки. Файл, которого нет в
    // неполном списке, может быть нужен непрочитанной строке — и как раз она
    // не может об этом сказать.
    if (!mayDeleteUnreferenced(alive.scan)) {
      log.warn('blob_cache_sweep_skipped_incomplete', refScanReport(alive.scan));
      return;
    }
    const idsToDelete = presentIds.filter((id) => !alive.ids.has(id));
    const urisToDelete = presentUris.filter((u) => !alive.uris.has(u));
    if (idsToDelete.length > 0) await deleteCachedBlobs(idsToDelete);
    if (urisToDelete.length > 0) await deleteCachedFileUris(urisToDelete);
  } catch (e) {
    log.warn('blob_cache_sweep_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * v4.32.443: стирание — одна транзакция, файлы — только после её успеха.
 *
 * «Очистить историю», «очистить всю историю», «очистить сообщения группы» и
 * «выйти из группы» — это не по одному DELETE, а по четыре-шесть подряд:
 * голоса в опросах, отметки о завершении, сами сообщения, состав группы,
 * корзина «недавно удалённые», следы в строке списка. Раньше они шли
 * последовательно и без транзакции. Любой сбой посередине — заблокированная
 * база, нехватка места, битая строка, а на Android ещё и убийство процесса —
 * оставлял стирание наполовину: уже выполненные DELETE зафиксированы, а
 * оставшийся шифротекст лежит на диске дальше. Хуже всего был выход из
 * группы: строка `groups` удалялась ПЕРВОЙ, и переписка, пережившая сбой,
 * становилась недостижимой из интерфейса — стереть её было уже нечем.
 *
 * Здесь `rows` целиком выполняется под BEGIN IMMEDIATE: либо стёрто всё,
 * либо ROLLBACK и не стёрто ничего — и тогда действие можно просто повторить.
 * `files` (снос расшифрованных вложений из кэша) обязателен отдельным
 * аргументом и зовётся ТОЛЬКО после COMMIT: удаление файла не откатывается,
 * поэтому оно не имеет права опередить фиксацию строк. Пропустить его молча
 * тоже нельзя — параметр не опциональный.
 */
async function eraseAtomically(
  d: SQLite.SQLiteDatabase,
  label: string,
  rows: () => Promise<void>,
  files: () => Promise<void>
): Promise<void> {
  await d.execAsync('BEGIN IMMEDIATE');
  try {
    await rows();
    await d.execAsync('COMMIT');
  } catch (e) {
    try {
      await d.execAsync('ROLLBACK');
    } catch {
      /* ignore */
    }
    log.warn('erase_rolled_back', { label, err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  await files();
}

/**
 * Срок жизни исчезающих сообщений — свойство переписки, а не того, кто сейчас
 * вошёл.
 *
 * v4.32.444: раньше сюда передавался id активного профиля, и чистка шла только
 * по его строкам. Таймер же один на приложение и заводится в App.tsx под
 * текущую личность. Значит, у второго аккаунта исчезающие сообщения не
 * исчезали вовсе, пока открыт первый: они лежали на диске сколько угодно
 * долго и пропадали разом в момент переключения профиля. Для функции, которая
 * обещает «сообщение исчезнет через N минут», это не задержка, а невыполненное
 * обещание — причём тем дольше, чем реже человек заходит во второй аккаунт.
 *
 * Поэтому параметра больше нет: пройтись можно только по всем профилям сразу,
 * а область удаления каждая строка задаёт сама — своим owner_profile_id. Так
 * сохраняется прежнее правило (таймер одной переписки не трогает переписку с
 * тем же контактом в другом профиле) и при этом ни один вызов не может сузить
 * чистку до одной личности.
 *
 * Транзакции здесь намеренно нет: порядок «сначала артефакты опросов, потом
 * сами сообщения» делает прерванный проход самовосстанавливающимся — остаются
 * лишние сообщения, которые удалит следующий тик, а не осиротевшие голоса.
 */
export async function purgeDisappearedMessages(): Promise<void> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    let purged = false;
    // v4.32.272: вложения исчезнувших сообщений. Строка уходит из БД, а
    // расшифрованный снимок/голосовое/документ оставался в кэше приложения до
    // суточной чистки — открытым текстом. Собираем id до удаления строк.
    const doomedBlobs = newAttachmentRefs();
    const convs = await d.getAllAsync<{
      contact_pub_b64: string;
      owner_profile_id: number;
      disappear_after_ms: number;
      disappear_set_at: number | null;
    }>(
      'SELECT contact_pub_b64, owner_profile_id, disappear_after_ms, disappear_set_at FROM conversations WHERE disappear_after_ms IS NOT NULL AND disappear_after_ms > 0',
      []
    );
    for (const c of convs) {
      const cutoff = Date.now() - c.disappear_after_ms;
      // Нижняя граница — момент включения таймера: прошлая переписка под него
      // не попадает. Без неё «1 минута» означала бы «стереть всю историю
      // сейчас», в том числе по команде собеседника. У строк, доживших с
      // прежних версий, момент неизвестен — там поведение прежнее (0).
      // owner_profile_id обязателен: без него таймер одного профиля вычищал
      // переписку с тем же контактом во всех остальных профилях (у групп
      // ниже это условие было с самого начала). Берётся он из самой строки —
      // именно поэтому проход по всем профилям остаётся безопасным.
      const disappearScope = [c.contact_pub_b64, c.owner_profile_id, cutoff, c.disappear_set_at ?? 0];
      await collectAttachmentRefs(
        d,
        dek,
        'SELECT text, media_cids FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND created_at < ? AND created_at >= ?',
        disappearScope,
        doomedBlobs
      );
      await deletePollArtifactsBySelect(
        d,
        'SELECT id FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND created_at < ? AND created_at >= ?',
        disappearScope,
        c.owner_profile_id
      );
      const res = await d.runAsync(
        'DELETE FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND created_at < ? AND created_at >= ?',
        disappearScope
      );
      if (!res.changes) continue;
      purged = true;
      await refreshConversationAfterPurge(d, dek, c.contact_pub_b64, c.owner_profile_id);
    }
    // Also purge group messages with disappear timers
    const groups = await d.getAllAsync<{
      id: string;
      owner_profile_id: number;
      disappear_after_ms: number;
      disappear_set_at: number | null;
    }>(
      'SELECT id, owner_profile_id, disappear_after_ms, disappear_set_at FROM groups WHERE disappear_after_ms IS NOT NULL AND disappear_after_ms > 0',
      []
    );
    for (const g of groups) {
      const cutoff = Date.now() - g.disappear_after_ms;
      // Та же нижняя граница, что и у диалогов выше: с появлением рассылки
      // таймера его включает администратор, и без границы одно нажатие
      // стирало бы всю историю группы у каждого участника.
      const grpScope = [g.id, g.owner_profile_id, cutoff, g.disappear_set_at ?? 0];
      await collectAttachmentRefs(
        d,
        dek,
        'SELECT text, media_cids FROM group_messages WHERE group_id = ? AND owner_profile_id = ? AND created_at < ? AND created_at >= ?',
        grpScope,
        doomedBlobs
      );
      await deletePollArtifactsBySelect(
        d,
        'SELECT id FROM group_messages WHERE group_id = ? AND owner_profile_id = ? AND created_at < ? AND created_at >= ?',
        grpScope,
        g.owner_profile_id
      );
      const res = await d.runAsync(
        'DELETE FROM group_messages WHERE group_id = ? AND owner_profile_id = ? AND created_at < ? AND created_at >= ?',
        grpScope
      );
      if (!res.changes) continue;
      purged = true;
      await refreshGroupAfterPurge(d, dek, g.id, g.owner_profile_id);
    }
    // Раньше событие слалось при самом наличии таймера — то есть каждую минуту
    // без единого удаления, дёргая перерисовку всех списков впустую.
    if (purged) {
      emitChatWrites();
      await dropOrphanBlobCache(doomedBlobs);
    }
  } catch (e) {
    log.warn('purge_disappeared_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Разовая уборка служебных конвертов, осевших в переписке.
 *
 * v4.32.247. Реакции, закрепления, таймеры, управление группой и прочие
 * управляющие сообщения уходят через тот же sendMessage, что и обычный текст,
 * и до этой версии сохранялись исходящей строкой (см. sendMessageWork). У тех,
 * кто пользовался приложением раньше, эти пузыри с сырым JSON — где видны
 * чужие публичные ключи и адреса вложений — остались лежать в базе, и сама
 * правка отправки их не уберёт.
 *
 * Отбор идёт по расшифрованному тексту, поэтому SQL здесь бессилен: строки
 * читаются порциями по rowid, чтобы не поднимать всю переписку в память.
 * Чистить при каждом чтении (в listChatMessages) нельзя — там LIMIT/OFFSET,
 * и выброшенные строки сдвинули бы постраничную загрузку.
 */
export async function purgeControlEnvelopeMessages(): Promise<void> {
  const DONE_KEY = 'purge:control_envelopes_v1';
  try {
    if (await kvGet(DONE_KEY)) return;
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const affected = new Map<string, { contact: string; owner: number }>();
    let cursor = 0;
    let removed = 0;
    for (;;) {
      const batch = await d.getAllAsync<{
        rowid: number;
        id: string;
        contact_pub_b64: string;
        owner_profile_id: number;
        text: string;
      }>(
        'SELECT rowid, id, contact_pub_b64, owner_profile_id, text FROM chat_messages WHERE rowid > ? ORDER BY rowid LIMIT 500',
        [cursor]
      );
      if (!batch.length) break;
      cursor = batch[batch.length - 1].rowid;
      // v4.32.519: строки помечаются rowid, а не id. Пакет читается по всем
      // профилям сразу, и удаление по одному id уносило бы вместе со служебным
      // конвертом настоящее сообщение соседнего аккаунта с тем же id — причём
      // его диалог даже не пересчитывался бы, и в списке остался бы прежний
      // текст последней реплики.
      const doomed: number[] = [];
      for (const r of batch) {
        let plain: string;
        try {
          plain = decryptAtRestString(r.text, dek);
        } catch {
          // Строка от другого ключа — не наша забота, уборка не вправе её трогать.
          continue;
        }
        if (!isControlOnlyText(plain)) continue;
        doomed.push(r.rowid);
        affected.set(`${r.owner_profile_id}:${r.contact_pub_b64}`, {
          contact: r.contact_pub_b64,
          owner: r.owner_profile_id,
        });
      }
      if (!doomed.length) continue;
      const marks = doomed.map(() => '?').join(',');
      const res = await d.runAsync(`DELETE FROM chat_messages WHERE rowid IN (${marks})`, doomed);
      removed += res.changes;
    }
    // Подпись последней реплики и счётчик непрочитанных пересчитываются по
    // выжившим строкам: иначе в списке диалогов осталось бы «Системное
    // сообщение» вместо настоящего последнего сообщения.
    for (const a of affected.values()) {
      await refreshConversationAfterPurge(d, dek, a.contact, a.owner);
    }
    await kvSet(DONE_KEY, String(Date.now()));
    if (removed) {
      log.info('purge_control_envelopes', { removed, conversations: affected.size });
      emitChatWrites();
    }
  } catch (e) {
    // Флаг не ставим: неудачная попытка повторится при следующем запуске.
    log.warn('purge_control_envelopes_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Установить/сбросить таймер автоудаления сообщений для группы.
 *
 * disappear_set_at запоминает момент включения: удаляются только сообщения,
 * написанные после него (см. purgeDisappearedMessages).
 */
export async function setGroupDisappearTimer(
  groupId: string,
  ownerProfileId: number,
  disappearAfterMs: number | null
): Promise<void> {
  const d = await db();
  const setAt = disappearAfterMs != null && disappearAfterMs > 0 ? Date.now() : null;
  await d.runAsync(
    'UPDATE groups SET disappear_after_ms = ?, disappear_set_at = ? WHERE id = ? AND owner_profile_id = ?',
    [disappearAfterMs, setAt, groupId, ownerProfileId]
  );
  emitChatWrites();
}

/** Закрепить/открепить сообщение в диалоге. */
export async function setConversationPinnedMessage(
  contactPubB64: string,
  ownerProfileId: number,
  messageId: string | null
): Promise<void> {
  try {
    const d = await db();
    await d.runAsync(
      'UPDATE conversations SET pinned_message_id = ? WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
      [messageId, contactPubB64, ownerProfileId]
    );
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_pin_msg_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function setConversationColorTag(
  contactPubB64: string,
  ownerProfileId: number,
  colorTag: string | null
): Promise<void> {
  // v4.32.295: метка — это ещё и ключ, под которым лежит название папки
  // (chatFolders). Правило «что бывает меткой» одно и на запись, и на чтение:
  // разъехавшись, они дали бы метку, для которой папку не назвать.
  if (colorTag != null && !isColorTag(colorTag)) {
    log.warn('conversation_color_tag_rejected', { len: colorTag.length });
    return;
  }
  try {
    const d = await db();
    await d.runAsync(
      'UPDATE conversations SET color_tag = ? WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
      [colorTag, contactPubB64, ownerProfileId]
    );
    emitChatWrites();
  } catch (e) {
    log.warn('conversation_color_tag_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Общий счётчик непрочитанных по всем диалогам профиля (для badge). */
export async function getTotalUnreadCount(ownerProfileId: number): Promise<number> {
  try {
    const d = await db();
    const r = await d.getFirstAsync<{ n: number }>(
      `SELECT SUM(unread_count) as n FROM conversations WHERE owner_profile_id = ? AND ${NOT_MUTED_SQL}`,
      [ownerProfileId, Date.now()]
    );
    return r?.n ?? 0;
  } catch (e) {
    log.warn('total_unread_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

export async function getTotalGroupUnreadCount(ownerProfileId: number): Promise<number> {
  try {
    const d = await db();
    const r = await d.getFirstAsync<{ n: number }>(
      `SELECT SUM(unread_count) as n FROM groups WHERE owner_profile_id = ? AND ${NOT_MUTED_SQL}`,
      [ownerProfileId, Date.now()]
    );
    return r?.n ?? 0;
  } catch (e) {
    log.warn('total_group_unread_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

// ─── Reactions ────────────────────────────────────────────────────────────────

// v4.32.301: updateMessageReactions (слепая перезапись всей карты реакций)
// удалена — её вытеснила toggleReaction ниже. Слепая запись здесь и была
// проблемой: реакция приходит и от нас, и по конверту '\x0freact:', и тот, кто
// перезаписал бы карту целиком, стёр бы чужую реакцию, пришедшую между его
// чтением и записью.

/**
 * Read-modify-write одной реакции. Общая часть для локального нажатия и для
 * входящего конверта '\x0freact:' — иначе логика разбора/склейки карты
 * дублировалась бы в ChatScreen, GroupsScreen и обработчике приёма, и они бы
 * разошлись.
 *
 * actorKey — base64 публичный ключ автора реакции. on='toggle' переключает по
 * текущему состоянию за одно чтение — без него вызывающему пришлось бы читать
 * ячейку отдельно, и два быстрых нажатия могли разъехаться.
 *
 * Возвращает null, если строки с таким id нет (реакция на неизвестное
 * сообщение) — чтобы вызывающий не рассылал fanout вхолостую. С v4.32.343 то же
 * null означает и «сообщение не из этой переписки»: область обязательна и
 * входит в условие запроса (см. reactionScope). С v4.32.509 — ещё и «упёрлись
 * в потолок карты реакций» (reactionMapPolicy); во всех трёх случаях в базу
 * ничего не записано и рассылать нечего.
 */
export async function toggleReaction(
  messageId: string,
  emoji: string,
  actorKey: string,
  on: boolean | 'toggle',
  scope: ReactionScope
): Promise<ReactionWriteResult> {
  const isGroup = scope.group;
  try {
    const d = await db();
    const { table, where, params } = reactionScopeSql(messageId, scope);
    const dek = await getOrCreateDataEncryptionKey();
    const row = await d.getFirstAsync<{ reactions: string | null }>(
      `SELECT reactions FROM ${table} WHERE ${where}`,
      params
    );
    if (!row) return { ok: false, reason: 'missing' };
    // v4.32.544: столбец, который не открылся нашим ключом, раньше приходил
    // сюда пустой строкой — неотличимо от «реакций не было». Из неё
    // получалась пустая карта, к ней добавлялась одна новая реакция, и запись
    // ниже стирала ВСЕ прежние. Необратимо: старый шифртекст перетёрт.
    const cell = readAtRestCell(row.reactions, dek);
    if (!mayOverwrite(cell)) {
      log.warn('reaction_column_unreadable', { group: isGroup });
      return { ok: false, reason: 'unreadable' };
    }
    const map = parseReactionMap(cellTextOrNull(cell));
    // v4.32.509: до этой версии число различных эмодзи на одном сообщении
    // ничем не ограничивалось. Сам эмодзи проверяется белым списком
    // (reactionEnvelope), а количество ключей — нет: участник, приславший
    // несколько тысяч разных валидных эмодзи, раздувал ячейку в базе и вешал
    // отрисовку пузыря у всех остальных. Потолки живут в reactionMapPolicy.
    const applied = applyReaction(map, emoji, actorKey, on);
    if (!applied) {
      log.warn('reaction_rejected_limit', { group: isGroup, actor: actorKey.slice(0, 8) });
      return { ok: false, reason: 'limit' };
    }
    const next = applied.on;
    const json = serializeReactionMap(applied.map);
    // group_messages всю жизнь писали сюда '{}' вместо NULL — сохраняем как
    // было, чтобы не менять поведение чтения на той стороне.
    await d.runAsync(
      `UPDATE ${table} SET reactions = ? WHERE ${where}`,
      [encryptAtRestNullable(isGroup ? (json ?? '{}') : json, dek), ...params]
    );
    emitChatWrites();
    return { ok: true, on: next };
  } catch (e) {
    log.warn('toggle_reaction_failed', { group: isGroup, err: e instanceof Error ? e.message : String(e) });
    return { ok: false, reason: 'failed' };
  }
}

// ─── Groups & Channels ────────────────────────────────────────────────────────

export type GroupType = 'group' | 'channel' | 'supergroup';
export type MemberRole = 'owner' | 'admin' | 'member' | 'restricted' | 'banned';

export type GroupRow = {
  id: string;
  ownerProfileId: number;
  name: string;
  /**
   * v4.32.577: столбец с названием есть, но ключом данных не открывается.
   * Тогда `name` — пустая строка, и это НЕ «группа без названия»: сравнивать
   * с ней присланное название нельзя (см. groupMetaEvents).
   */
  nameUnreadable?: boolean;
  description: string | null;
  /**
   * v4.32.579: столбец с описанием есть, но ключом данных не открывается.
   * Тогда `description` — null, и это НЕ «описания нет»: ни показывать пустоту,
   * ни затирать столбец пустой строкой нельзя (см. groupMetaEvents).
   */
  descriptionUnreadable?: boolean;
  avatarCid: string | null;
  /** v4.32.577: столбец с аватаром не открылся ключом данных. */
  avatarCidUnreadable?: boolean;
  type: GroupType;
  /**
   * v4.32.303: секрет пригласительной ссылки. Есть только у тех, кто вправе
   * приглашать: у создателя группы и у администраторов, которым его прислали
   * конвертом 'meta'. null — сверять предъявленный токен не с чем (группа
   * создана до этой версии либо мы обычный участник).
   */
  inviteToken: string | null;
  /**
   * Столбец с токеном не открылся ключом данных (v4.32.601).
   *
   * Пустая строка от неудачной расшифровки была неотличима от «токена нет», а
   * «токена нет» означает «сверять нечем, пускаем по общим правилам». Так
   * отозванная ссылка снова начинала пускать в группу. См. groupInviteToken.
   */
  inviteTokenUnreadable?: boolean;
  isAdmin: boolean;
  memberCount: number;
  unreadCount: number;
  mentionCount: number;
  draftText: string | null;
  disappearAfterMs: number | null;
  muted: boolean;
  /** Unix ms until which notifications are muted. NULL = forever. */
  mutedUntil: number | null;
  /** Seconds a member must wait between messages (0 = off). */
  slowModeSeconds: number;
  pinned: boolean;
  archived: boolean;
  lastMessageAt: number;
  lastMessagePreview: string | null;
  /** v4.32.580: подпись последней реплики не открылась — см. ConversationRow. */
  lastMessagePreviewUnreadable?: boolean;
  /** v4.32.583: черновик группы не открылся ключом данных — см. draftGuard. */
  draftUnreadable?: boolean;
  lastMessageSenderName: string | null;
  /**
   * Подпись автора последней реплики не открылась ключом данных (v4.32.602).
   *
   * Пустая строка от неудачной расшифровки была неотличима от «подписи нет», а
   * «подписи нет» — законный случай, и строка списка просто рисуется без неё.
   * Так реплика соседа по группе теряла автора без единого признака.
   */
  lastMessageSenderNameUnreadable?: boolean;
  lastMessageSenderPub: string | null;
  createdAt: number;
  pinnedMessageId: string | null;
  pinnedMessageText: string | null;
  /**
   * Текст закрепления не открылся ключом данных (v4.32.603).
   *
   * Пустая строка от неудачной расшифровки была неотличима от «ничего не
   * закреплено», и полоса закрепления не рисовалась вовсе — объявление группы
   * исчезало вместе со способом его открепить. Ср. PinnedEntry.unreadable, где
   * то же самое уже разобрано для нового списка закреплений (v4.32.576).
   */
  pinnedMessageTextUnreadable?: boolean;
  /** When true, only admins/owner may post (regular group equivalent of channel restriction). */
  adminOnlyPosting: boolean;
  /** When true, new members must be approved by an admin before joining. */
  requireApproval: boolean;
  /** When true, messages are shown without the sender's name/identity. */
  anonymousPosting: boolean;
  /** When true, only admins/owner may pin messages. Default for new groups. */
  adminOnlyPinning: boolean;
};

export type GroupMemberRow = {
  groupId: string;
  peerPubB64: string;
  role: MemberRole;
  displayName: string | null;
  joinedAt: number;
  /** Профиль, которому принадлежит эта строка состава (v4.32.466). */
  ownerProfileId: number;
  /**
   * Столбец с именем участника не открылся ключом данных (v4.32.595).
   *
   * Поле необязательное: его проставляет только чтение состава. Записи
   * (`upsertGroupMember`) о нём не знают и знать не должны — в базу уходит
   * `displayName`, а это поле описывает не участника, а нашу способность
   * прочитать его имя.
   */
  displayNameUnreadable?: boolean;
};

export type GroupMessageRow = {
  id: string;
  groupId: string;
  senderPubB64: string;
  senderName: string | null;
  text: string;
  mediaCids: string | null;
  replyToId: string | null;
  replyToPreview: string | null;
  /**
   * Столбец с цитатой не открылся ключом данных (v4.32.598).
   *
   * Пустая строка от неудачной расшифровки не отличалась от «это не ответ»:
   * блок цитаты просто не рисовался, и ответ читался как отдельная реплика.
   * Признак только читается — писать его в строку не нужно. См. unreadableText.
   */
  replyToPreviewUnreadable?: boolean;
  reactions: string | null;
  /**
   * Столбец с реакциями не открылся ключом данных (v4.32.600).
   *
   * Пустая строка от неудачной расшифровки не отличалась от «реакций не
   * было»: плашки просто не рисовались. Писать в такой столбец запрещено с
   * v4.32.544 — значит и молчать о нём нельзя, иначе отказ по нажатию
   * приходит из ниоткуда. См. unreadableText.
   */
  reactionsUnreadable?: boolean;
  createdAt: number;
  ownerProfileId: number;
  editedAt?: number | null;
  starred?: boolean;
  viewCount?: number;
  /** JSON-массив pubB64 участников, прочитавших сообщение */
  seenBy?: string[] | null;
  /**
   * Столбец с прочитавшими не открылся ключом данных (v4.32.591).
   * Отличает «список пуст» от «список неизвестен»: без этого своё сообщение
   * показывало «Никто ещё не прочитал» при записанных прочтениях, а починить
   * это было нельзя — писать в непрочитанный столбец запрещено с v4.32.544.
   */
  seenUnreadable?: boolean;
  /** Столбец с текстом не открылся ключом данных (v4.32.559). */
  unreadable?: boolean;
  /** Столбец с именем отправителя не открылся ключом данных (v4.32.593). */
  senderUnreadable?: boolean;
  /**
   * Столбец со списком вложений не открылся ключом данных (v4.32.597).
   *
   * Пустая строка от неудачной расшифровки не отличалась от «вложений не
   * было»: сетка снимков просто не рисовалась. У сообщения без текста от него
   * не оставалось ничего — пустой пузырь. См. unreadableText.
   */
  mediaUnreadable?: boolean;
};

/**
 * Имя из зашифрованного столбца тремя состояниями (v4.32.593).
 *
 * `nameOrNull(decryptAtRestNullable(...))` возвращал `null` и когда имени нет,
 * и когда ключ не открыл столбец. Разница видна на экране: в первом случае
 * подпись коротким ключом честна, во втором она умалчивает, что имя есть, но
 * прочитать его не вышло. Четыре места читали имя отправителя одинаково —
 * лента группы, два поиска и «Избранное»; теперь одинаково и правильно.
 */
function readNameCell(stored: string | null, dek: Uint8Array): { name: string | null; unreadable: boolean } {
  const cell = readAtRestCell(stored, dek);
  return { name: nameOrNull(cellTextOrNull(cell)), unreadable: unreadableFromCellState(cell.state) };
}

/**
 * Пригласительный токен группы тремя состояниями (v4.32.601).
 *
 * `decryptAtRestNullable` отдаёт на неудаче пустую строку, а `isInviteToken`
 * читает её как «токена нет» — то есть как «сверять нечем, решаем без него».
 * На устройстве администратора, чей ключ перестал открывать этот столбец,
 * любая давно отозванная ссылка снова начинала пускать в группу.
 */
function readTokenCell(
  stored: string | null,
  dek: Uint8Array
): { inviteToken: string | null; inviteTokenUnreadable: boolean } {
  const cell = readAtRestCell(stored, dek);
  return { inviteToken: cellTextOrNull(cell), inviteTokenUnreadable: unreadableFromCellState(cell.state) };
}

/**
 * Реакции сообщения тремя состояниями (v4.32.600).
 *
 * `decryptAtRestNullable` отдаёт на неудаче пустую строку, из неё выходит
 * пустая карта — и плашки не рисуются вовсе, неотличимо от «на это никто не
 * реагировал». Запись в такой столбец запрещена с v4.32.544, так что нажатие
 * на эмодзи получает отказ; без признака сказать, откуда он взялся, нечем.
 * Восемь мест читали столбец одинаково; теперь одинаково и правильно.
 */
function readReactionsCell(
  stored: string | null,
  dek: Uint8Array
): { reactions: string | null; reactionsUnreadable: boolean } {
  const cell = readAtRestCell(stored, dek);
  return { reactions: cellTextOrNull(cell), reactionsUnreadable: unreadableFromCellState(cell.state) };
}

/**
 * Цитата в ответе тремя состояниями (v4.32.598).
 *
 * `decryptAtRestNullable` отдаёт на неудаче пустую строку, а блок цитаты
 * рисуется по `replyToId && replyPreview` — пустая строка через это условие
 * не проходит. Ответ выглядел обычным сообщением: ни рамки, ни того, на что
 * он отвечает, — а разговор от этого читается наоборот. Восемь мест читали
 * столбец одинаково; теперь одинаково и правильно.
 */
function readReplyCell(
  stored: string | null,
  dek: Uint8Array
): { replyToPreview: string | null; replyToPreviewUnreadable: boolean } {
  const cell = readAtRestCell(stored, dek);
  return { replyToPreview: cellTextOrNull(cell), replyToPreviewUnreadable: unreadableFromCellState(cell.state) };
}

/**
 * Список вложений сообщения тремя состояниями (v4.32.597).
 *
 * `decryptAtRestNullable` отдаёт на неудаче пустую строку, а `if (mediaCids)`
 * её не замечает: сообщение рисуется так, будто вложений не было. Восемь мест
 * читали столбец одинаково — лента чата, лента группы, четыре поиска и
 * «Избранное» дважды; теперь одинаково и правильно.
 */
function readMediaCell(stored: string | null, dek: Uint8Array): { mediaCids: string | null; mediaUnreadable: boolean } {
  const cell = readAtRestCell(stored, dek);
  return { mediaCids: cellTextOrNull(cell), mediaUnreadable: unreadableFromCellState(cell.state) };
}

/**
 * Имя участника состава — сразу в том виде, в каком его ждёт `GroupMemberRow`
 * (v4.32.595).
 *
 * Отдельно от `readNameCell` только ради имён полей: строка состава называет
 * их `displayName`/`displayNameUnreadable`, и подставлять их россыпью в четырёх
 * местах было бы легко забыть.
 */
function readMemberName(
  stored: string | null,
  dek: Uint8Array
): { displayName: string | null; displayNameUnreadable: boolean } {
  const cell = readNameCell(stored, dek);
  return { displayName: cell.name, displayNameUnreadable: cell.unreadable };
}

/**
 * Наследный текст закрепления группы тремя состояниями (v4.32.603).
 *
 * Это колонка групп, а не строка списка закреплений: у групп, заведённых до
 * v4.32.4xx, объявление лежит здесь. Пустая строка от неудачной расшифровки
 * читалась экраном как «ничего не закреплено», и полоса исчезала целиком.
 */
function readPinnedCell(
  stored: string | null,
  dek: Uint8Array
): { pinnedMessageText: string | null; pinnedMessageTextUnreadable: boolean } {
  const cell = readAtRestCell(stored, dek);
  return {
    pinnedMessageText: cellTextOrNull(cell),
    pinnedMessageTextUnreadable: unreadableFromCellState(cell.state),
  };
}

/**
 * Подпись автора последней реплики — сразу в том виде, в каком её ждёт
 * `GroupRow` (v4.32.602). Как и `readMemberName`, отдельно от `readNameCell`
 * только ради имён полей.
 */
function readLastSenderName(
  stored: string | null,
  dek: Uint8Array
): { lastMessageSenderName: string | null; lastMessageSenderNameUnreadable: boolean } {
  const cell = readNameCell(stored, dek);
  return { lastMessageSenderName: cell.name, lastMessageSenderNameUnreadable: cell.unreadable };
}

// v4.32.218 (CRIT-4 part 2): rowToGroup now takes the DEK so draft/preview/
// pinned text are transparently decrypted. Legacy plaintext rows (no enc2:
// prefix) pass through unchanged, so migration is implicit on next write.
function rowToGroup(r: Record<string, unknown>, dek: Uint8Array): GroupRow {
  const mutedUntil = (r.muted_until as number | null) ?? null;
  const now = Date.now();
  const effectiveMuted = isEffectivelyMuted((r.muted as number) ? 1 : 0, mutedUntil, now);
  // v4.32.577: название и аватар читаются с различением «не открылось» и
  // «пусто». Раньше обе беды сводились к пустой строке, и разбор meta-конверта
  // принимал непрочитанное название за старое: печаталось «Группа
  // переименована в «X»» о переименовании, которого не было.
  const nameCell = readAtRestCell((r.name as string | null) ?? null, dek);
  const avatarCell = readAtRestCell((r.avatar_cid as string | null) ?? null, dek);
  // v4.32.579: описание — тем же правилом. До этой версии оно читалось через
  // decryptAtRestNullable, и непрочитанный столбец приходил пустотой:
  // карточка группы показывала «описания нет», а разбор конверта считал,
  // что описание уже совпадает, и нечитаемый столбец не лечился никогда.
  const descCell = readAtRestCell((r.description as string | null) ?? null, dek);
  // v4.32.580: подпись последней реплики группы — тем же правилом, что в
  // списке диалогов: непрочитанная подпись не «в группе не писали».
  const prevCell = readAtRestCell((r.last_message_preview as string | null) ?? null, dek);
  // v4.32.583: черновик группы — тем же правилом, что в списке диалогов:
  // пустая строка от неудачи означала «черновика нет» и стиралась первой же
  // отложенной записью (см. draftGuard).
  const draftCell = readAtRestCell((r.draft_text as string | null) ?? null, dek);
  return {
    id: r.id as string,
    ownerProfileId: r.owner_profile_id as number,
    name: cellTextOrNull(nameCell) ?? '',
    nameUnreadable: unreadableFromCellState(nameCell.state),
    description: cellTextOrNull(descCell),
    descriptionUnreadable: unreadableFromCellState(descCell.state),
    // v4.32.304: `nb:`-дескриптор аватара несёт ключ расшифровки файла
    // (blobRef.ts). Строка без префикса enc2: — ещё не переведённая; она
    // возвращается как есть (см. ensureGroupAvatarCidEncrypted).
    avatarCid: cellTextOrNull(avatarCell),
    avatarCidUnreadable: unreadableFromCellState(avatarCell.state),
    type: (r.type as GroupType) ?? 'group',
    ...readTokenCell((r.invite_token as string | null) ?? null, dek),
    isAdmin: !!(r.is_admin as number),
    memberCount: r.member_count as number,
    unreadCount: r.unread_count as number,
    mentionCount: (r.mention_count as number) || 0,
    draftText: cellTextOrNull(draftCell),
    draftUnreadable: unreadableFromCellState(draftCell.state),
    disappearAfterMs: (r.disappear_after_ms as number | null) ?? null,
    muted: effectiveMuted,
    mutedUntil,
    slowModeSeconds: (r.slow_mode_seconds as number) || 0,
    pinned: !!(r.pinned as number),
    archived: !!(r.archived as number),
    lastMessageAt: r.last_message_at as number,
    lastMessagePreview: cellTextOrNull(prevCell),
    lastMessagePreviewUnreadable: unreadableFromCellState(prevCell.state),
    ...readLastSenderName((r.last_message_sender_name as string | null) ?? null, dek),
    lastMessageSenderPub: (r.last_message_sender_pub as string | null) ?? null,
    createdAt: r.created_at as number,
    pinnedMessageId: (r.pinned_message_id as string | null) ?? null,
    ...readPinnedCell((r.pinned_message_text as string | null) ?? null, dek),
    adminOnlyPosting: !!(r.admin_only_posting as number),
    requireApproval: !!(r.require_approval as number),
    anonymousPosting: !!(r.anonymous_posting as number),
    // Колонки может не быть только у строки, прочитанной до миграции; тогда
    // безопасное значение — «только админы», а не «все».
    adminOnlyPinning: r.admin_only_pinning === undefined ? true : !!(r.admin_only_pinning as number),
  };
}

export async function createGroup(
  id: string,
  ownerProfileId: number,
  name: string,
  type: GroupType = 'group',
  description?: string,
  /**
   * v4.32.231: раньше is_admin жёстко ставился в 1 — то есть КАЖДЫЙ, кто
   * вступил по ссылке-приглашению, видел у себя полный набор админских
   * кнопок (кик, бан, переименование, «только для админов»). Нажатия
   * применялись только к его собственной БД и ни на кого не влияли —
   * чистая имитация прав. Теперь флаг задаёт вызывающий: true только для
   * того, кто создаёт группу.
   */
  isAdmin = true
): Promise<void> {
  const d = await db();
  // v4.32.284: название и описание группы шифруются вместе с черновиком и
  // превью — они и есть самое говорящее, что о группе можно узнать, не читая
  // ни одного сообщения. По названию в SQL никто не сортирует и не ищет
  // (ORDER BY идёт по pinned/last_message_at), так что шифрование ничего не
  // ломает; поиск по группам работает в памяти, уже над расшифрованным.
  const dek = await getOrCreateDataEncryptionKey();
  /**
   * v4.32.303: токен пригласительной ссылки рождается вместе с группой — но
   * только у того, кто её создаёт.
   *
   * Вступившему по ссылке (isAdmin=false) свой токен не просто не нужен — он
   * вреден: сверять чужие ссылки он стал бы со случайной строкой, которой нет
   * ни у кого, и отбрасывал бы каждого следующего вступающего как пришедшего
   * по отозванной ссылке. Токен — право приглашать, и он есть ровно у тех, у
   * кого это право есть.
   */
  const inviteToken = isAdmin ? makeInviteToken(randomBytes) : null;
  await d.runAsync(
    `INSERT OR IGNORE INTO groups (id, owner_profile_id, name, type, description, is_admin, invite_token, created_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ownerProfileId, encryptAtRestString(name, dek), type, encryptAtRestNullable(description ?? null, dek),
     isAdmin ? 1 : 0, encryptAtRestNullable(inviteToken, dek), Date.now(), Date.now()]
  );
}

export async function listGroups(ownerProfileId: number): Promise<GroupRow[]> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM groups WHERE owner_profile_id = ? AND archived = 0 ORDER BY pinned DESC, last_message_at DESC`,
      [ownerProfileId]
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => rowToGroup(r, dek));
  } catch (e) {
    log.warn('list_groups_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

export async function listArchivedGroups(ownerProfileId: number): Promise<GroupRow[]> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM groups WHERE owner_profile_id = ? AND archived = 1 ORDER BY last_message_at DESC`,
      [ownerProfileId]
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => rowToGroup(r, dek));
  } catch (e) {
    log.warn('list_archived_groups_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * Прочитать группу, отличая «нет такой» от «не смогли прочитать» (v4.32.548).
 *
 * `getGroup` отвечал `null` в обоих случаях, и вызывающий строил на этом
 * решение: переход по уведомлению просто не срабатывал, а человеку не
 * говорили ничего. Отказ базы — не пустота, и молчать о нём нельзя.
 */
export async function getGroupRead(
  id: string,
  ownerProfileId: number
): Promise<LookupResult<GroupRow>> {
  try {
    const d = await db();
    const r = await d.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM groups WHERE id = ? AND owner_profile_id = ?',
      [id, ownerProfileId]
    );
    if (!r) return missingResult();
    const dek = await getOrCreateDataEncryptionKey();
    return foundResult(rowToGroup(r, dek));
  } catch (e) {
    log.warn('group_read_failed', { group: id.slice(0, 16), err: e instanceof Error ? e.message : String(e) });
    return failedResult();
  }
}

export async function getGroup(id: string, ownerProfileId: number): Promise<GroupRow | null> {
  return lookupValue(await getGroupRead(id, ownerProfileId));
}

/**
 * Заведена ли группа с таким идентификатором у этого профиля (v4.32.463,
 * профильный с v4.32.467).
 *
 * Вопрос задаётся про один аккаунт, а не про всю базу: с v4.32.467 первичный
 * ключ `groups` составной — (id, owner_profile_id), — и группа соседнего
 * профиля больше не занимает идентификатор у нас. Раньше занимала: `INSERT OR
 * IGNORE` тихо не делал ничего, и группа по ссылке не появлялась ни в одном
 * профиле, кроме занявшего id первым.
 *
 * Ответ 'unknown' — не «свободен»: на этот ответ стоит решение о доверии
 * (см. groupInviteApply), и молчаливый отказ базы не должен читаться как
 * разрешение.
 */
export type GroupIdState =
  | { kind: 'free' }
  | { kind: 'taken' }
  | { kind: 'unknown' };

export async function groupIdState(id: string, ownerProfileId: number): Promise<GroupIdState> {
  try {
    const d = await db();
    const r = await d.getFirstAsync<{ n: number }>(
      'SELECT 1 as n FROM groups WHERE id = ? AND owner_profile_id = ? LIMIT 1',
      [id, ownerProfileId]
    );
    return r ? { kind: 'taken' } : { kind: 'free' };
  } catch (e) {
    log.warn('group_id_state_failed', { err: e instanceof Error ? e.message : String(e) });
    return { kind: 'unknown' };
  }
}

export async function updateGroupMeta(
  id: string,
  ownerProfileId: number,
  patch: Partial<Pick<GroupRow, 'name' | 'description' | 'avatarCid' | 'inviteToken' | 'memberCount' | 'adminOnlyPosting' | 'requireApproval' | 'anonymousPosting' | 'adminOnlyPinning' | 'isAdmin'>>
): Promise<void> {
  const d = await db();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const dek = await getOrCreateDataEncryptionKey();
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(encryptAtRestString(patch.name, dek)); }
  if (patch.description !== undefined) { sets.push('description = ?'); vals.push(encryptAtRestNullable(patch.description, dek)); }
  if (patch.avatarCid !== undefined) { sets.push('avatar_cid = ?'); vals.push(encryptAtRestNullable(patch.avatarCid, dek)); }
  if (patch.inviteToken !== undefined) { sets.push('invite_token = ?'); vals.push(encryptAtRestNullable(patch.inviteToken, dek)); }
  if (patch.memberCount !== undefined) { sets.push('member_count = ?'); vals.push(patch.memberCount); }
  if (patch.adminOnlyPosting !== undefined) { sets.push('admin_only_posting = ?'); vals.push(patch.adminOnlyPosting ? 1 : 0); }
  if (patch.requireApproval !== undefined) { sets.push('require_approval = ?'); vals.push(patch.requireApproval ? 1 : 0); }
  if (patch.anonymousPosting !== undefined) { sets.push('anonymous_posting = ?'); vals.push(patch.anonymousPosting ? 1 : 0); }
  if (patch.adminOnlyPinning !== undefined) { sets.push('admin_only_pinning = ?'); vals.push(patch.adminOnlyPinning ? 1 : 0); }
  /**
   * v4.32.512: `is_admin` — «я здесь администратор». До этой версии колонку
   * писал только createGroup, в момент появления группы, и повышение или
   * понижение её не трогали: роль менялась в group_members, а флаг оставался
   * прежним навсегда. Своя роль теперь читается из таблицы участников
   * (ownGroupRole), но флаг остаётся запасным ответом, пока список не
   * прочитан, — и потому обязан за ролью успевать.
   */
  if (patch.isAdmin !== undefined) { sets.push('is_admin = ?'); vals.push(patch.isAdmin ? 1 : 0); }
  if (!sets.length) return;
  vals.push(id, ownerProfileId);
  await d.runAsync(`UPDATE groups SET ${sets.join(', ')} WHERE id = ? AND owner_profile_id = ?`, vals as SQLite.SQLiteBindValue[]);
}

export async function touchGroupConversation(
  groupId: string,
  ownerProfileId: number,
  preview: string,
  incrementUnread: boolean,
  senderName?: string | null,
  incrementMention?: boolean,
  senderPubB64?: string | null
): Promise<void> {
  try {
    const d = await db();
    // v4.32.218 (CRIT-4 part 2): encrypt group preview at rest.
    // v4.32.224 (re-audit): prep encryption BEFORE BEGIN IMMEDIATE so the
    // async Keystore fetch doesn't starve the SQLite write lock.
    const previewTrunc = preview.slice(0, LAST_MESSAGE_PREVIEW_MAX);
    const dek = await getOrCreateDataEncryptionKey();
    const previewEnc = previewTrunc ? encryptAtRestString(previewTrunc, dek) : null;
    // v4.32.285: имя автора последней реплики — тоже имя; шифруется вместе с
    // превью, которое оно подписывает.
    const senderNameEnc = encryptAtRestNullable(senderName ?? null, dek);
    // v4.32.141 (AUDIT P1): mirror touchConversation — SELECT-then-UPDATE
    // races with itself when two deliveries for the same group land
    // concurrently (LAN + internet retry, or two senders). Both readers see
    // the same counters, both write old+1, one increment is lost. BEGIN
    // IMMEDIATE serialises writers so the second read sees the first update.
    await d.execAsync('BEGIN IMMEDIATE;');
    try {
      const existing = await d.getFirstAsync<{ unread_count: number; mention_count: number }>(
        'SELECT unread_count, mention_count FROM groups WHERE id = ? AND owner_profile_id = ?',
        [groupId, ownerProfileId]
      );
      if (!existing) {
        await d.execAsync('COMMIT;');
        return;
      }
      const newUnread = incrementUnread ? existing.unread_count + 1 : existing.unread_count;
      const newMention = incrementMention ? (existing.mention_count || 0) + 1 : (existing.mention_count || 0);
      await d.runAsync(
        `UPDATE groups SET last_message_at = ?, last_message_preview = ?, unread_count = ?, last_message_sender_name = ?, mention_count = ?, last_message_sender_pub = ?
         WHERE id = ? AND owner_profile_id = ?`,
        [Date.now(), previewEnc, newUnread, senderNameEnc, newMention, senderPubB64 ?? null, groupId, ownerProfileId]
      );
      await d.execAsync('COMMIT;');
    } catch (inner) {
      try { await d.execAsync('ROLLBACK;'); } catch { /* ignore */ }
      throw inner;
    }
    emitChatWrites();
  } catch (e) {
    log.warn('touch_group_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Снять непрочитанные с группы.
 *
 * v4.32.526: сигнал подписчикам — только на настоящем изменении. Прежняя
 * версия будила их всегда, а GroupsScreen на каждый сигнал перечитывает
 * переписку и в конце чтения зовёт сюда же — круг замыкался и крутился с
 * периодом дебаунса. Подробности в writeEcho.ts.
 */
export async function markGroupRead(groupId: string, ownerProfileId: number): Promise<void> {
  try {
    const d = await db();
    const res = await d.runAsync(
      `UPDATE groups SET unread_count = 0, mention_count = 0
       WHERE id = ? AND owner_profile_id = ? AND (unread_count != 0 OR mention_count != 0)`,
      [groupId, ownerProfileId]
    );
    if (anyChanged(res)) emitChatWrites();
  } catch (e) {
    // v4.32.526: было `catch { }` — сбой снятия непрочитанных не оставлял
    // следа нигде, и «счётчик не гаснет» было нечем объяснить.
    log.warn('mark_group_read_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function markAllGroupsRead(ownerProfileId: number): Promise<void> {
  try {
    const d = await db();
    const res = await d.runAsync(
      `UPDATE groups SET unread_count = 0, mention_count = 0
       WHERE owner_profile_id = ? AND (unread_count != 0 OR mention_count != 0)`,
      [ownerProfileId]
    );
    if (anyChanged(res)) emitChatWrites();
  } catch (e) {
    log.warn('mark_all_groups_read_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function markGroupUnread(groupId: string, ownerProfileId: number): Promise<void> {
  try {
    const d = await db();
    // Прежний вариант поднимал счётчик до единицы функцией максимума: на
    // строке, где он уже не ноль, запрос ничего не менял, но исправно будил
    // подписчиков. Условие перенесено в WHERE.
    const res = await d.runAsync(
      'UPDATE groups SET unread_count = 1 WHERE id = ? AND owner_profile_id = ? AND unread_count = 0',
      [groupId, ownerProfileId]
    );
    if (anyChanged(res)) emitChatWrites();
  } catch (e) {
    log.warn('mark_group_unread_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Сохранить черновик сообщения для группы (null = очистить). */
export async function setGroupDraft(groupId: string, ownerProfileId: number, draft: string | null): Promise<void> {
  try {
    const d = await db();
    // v4.32.218 (CRIT-4 part 2): encrypt group draft at rest.
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync(
      'UPDATE groups SET draft_text = ? WHERE id = ? AND owner_profile_id = ?',
      [encryptAtRestNullable(draft, dek), groupId, ownerProfileId]
    );
  } catch (e) {
    log.warn('set_group_draft_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function setGroupPinned(id: string, ownerProfileId: number, pinned: boolean): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE groups SET pinned = ? WHERE id = ? AND owner_profile_id = ?', [pinned ? 1 : 0, id, ownerProfileId]);
  emitChatWrites();
}

export async function setGroupMuted(id: string, ownerProfileId: number, muted: boolean): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE groups SET muted = ?, muted_until = NULL WHERE id = ? AND owner_profile_id = ?', [muted ? 1 : 0, id, ownerProfileId]);
  emitChatWrites();
}

/** Беззвучный режим группы с таймером. until=null → навсегда. */
export async function setGroupMutedUntil(id: string, ownerProfileId: number, until: number | null): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE groups SET muted = 1, muted_until = ? WHERE id = ? AND owner_profile_id = ?', [until, id, ownerProfileId]);
  emitChatWrites();
}

/** Медленный режим: seconds=0 → выключен. */
export async function setGroupSlowMode(id: string, ownerProfileId: number, seconds: number): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE groups SET slow_mode_seconds = ? WHERE id = ? AND owner_profile_id = ?', [seconds, id, ownerProfileId]);
  emitChatWrites();
}

export async function setGroupArchived(id: string, ownerProfileId: number, archived: boolean): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE groups SET archived = ? WHERE id = ? AND owner_profile_id = ?', [archived ? 1 : 0, id, ownerProfileId]);
  emitChatWrites();
}

export async function setGroupPinnedMessage(
  groupId: string,
  ownerProfileId: number,
  messageId: string | null,
  messageText: string | null
): Promise<void> {
  const d = await db();
  // v4.32.218 (CRIT-4 part 2): encrypt pinned message text at rest.
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    'UPDATE groups SET pinned_message_id = ?, pinned_message_text = ? WHERE id = ? AND owner_profile_id = ?',
    [messageId, encryptAtRestNullable(messageText, dek), groupId, ownerProfileId]
  );
  emitChatWrites();
}

export async function deleteGroup(id: string, ownerProfileId: number): Promise<void> {
  const d = await db();
  // v4.32.272: до удаления строк — какие вложения они держали. Иначе выход из
  // группы уносил переписку, а расшифрованные снимки и голосовые оставались
  // лежать в кэше приложения ещё сутки.
  const dek = await getOrCreateDataEncryptionKey();
  const doomed = newAttachmentRefs();
  await collectAttachmentRefs(
    d,
    dek,
    'SELECT text, media_cids FROM group_messages WHERE group_id = ? AND owner_profile_id = ?',
    [id, ownerProfileId],
    doomed
  );
  await eraseAtomically(
    d,
    'delete_group',
    async () => {
      await d.runAsync('DELETE FROM groups WHERE id = ? AND owner_profile_id = ?', [id, ownerProfileId]);
      await d.runAsync(
        'DELETE FROM group_members WHERE group_id = ? AND owner_profile_id = ?',
        [id, ownerProfileId]
      );
      await deletePollArtifactsBySelect(
        d,
        'SELECT id FROM group_messages WHERE group_id = ? AND owner_profile_id = ?',
        [id, ownerProfileId],
        ownerProfileId
      );
      await d.runAsync('DELETE FROM group_messages WHERE group_id = ? AND owner_profile_id = ?', [id, ownerProfileId]);
      await kvDeleteScoped(ownerProfileId, recentlyDeletedGroupKey(id));
    },
    () => dropOrphanBlobCache(doomed)
  );
  emitChatWrites();
}

// Members

export async function upsertGroupMember(member: GroupMemberRow): Promise<void> {
  const d = await db();
  // v4.32.298: имя участника шифруется. В v4.32.285 зашифровали sender_name в
  // сообщениях — именно затем, чтобы по одной колонке не читался состав группы;
  // здесь лежал тот же состав, целиком и независимо от того, писал человек
  // хоть раз.
  const dek = await getOrCreateDataEncryptionKey();
  // v4.32.382: INSERT OR REPLACE переписывал строку целиком, а joined_at сюда
  // приходит из конверта — из того же ts, что и у события. Значит, каждый бан,
  // разбан и смена роли ставили участнику НОВУЮ дату вступления: после первой
  // же выдачи прав человек становился самым молодым в группе. Дата вступления
  // задаётся один раз, при вступлении, и обновлению не подлежит — поэтому
  // здесь ON CONFLICT, обновляющий только роль и имя.
  await d.runAsync(
    `INSERT INTO group_members (group_id, peer_pub_b64, role, display_name, joined_at, owner_profile_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, peer_pub_b64, owner_profile_id) DO UPDATE SET
       role = excluded.role,
       display_name = excluded.display_name`,
    [
      member.groupId,
      member.peerPubB64,
      member.role,
      encryptAtRestNullable(member.displayName ?? null, dek),
      // Время из чужого конверта — по общему правилу (см. social/envelopeTime).
      // Шести местам в groupMessaging, откуда оно сюда приходит, договариваться
      // об этом по отдельности не нужно: запись в таблицу одна.
      clampJoinedAt(member.joinedAt),
      member.ownerProfileId,
    ]
  );
}

export async function listGroupMembers(
  groupId: string,
  ownerProfileId: number
): Promise<GroupMemberRow[]> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{
      group_id: string; peer_pub_b64: string; role: string;
      display_name: string | null; joined_at: number;
    }>(
      // v4.32.468: порядок по старшинству, а не по алфавиту названий ролей
      // (см. MEMBER_ROLE_ORDER — там же разобрано, как это выглядело).
      `SELECT * FROM group_members WHERE group_id = ? AND owner_profile_id = ?
        ORDER BY ${MEMBER_ROLE_ORDER_SQL} ASC, joined_at ASC`,
      [groupId, ownerProfileId]
    );
    // Строка без префикса enc2: — ещё не переведённая; decryptAtRestNullable
    // возвращает её как есть (см. ensureGroupMemberNamesEncrypted).
    const dek = await getOrCreateDataEncryptionKey();
    const now = Date.now();
    // v4.32.382: даты, записанные до появления правила, уже лежат в базе, и
    // переписывать их миграцией незачем — достаточно не верить им на чтении.
    // Пересортировка здесь по той же причине: SQL отсортировал по сырой
    // колонке, то есть 1970-й всё ещё стоял бы первым.
    return rows
      .map((r) => ({
        groupId: r.group_id,
        peerPubB64: r.peer_pub_b64,
        role: r.role as MemberRole,
        ...readMemberName(r.display_name, dek),
        joinedAt: clampJoinedAt(r.joined_at, now),
        ownerProfileId,
      }))
      .sort((a, b) =>
        a.role === b.role
          ? a.joinedAt - b.joinedAt || a.peerPubB64.localeCompare(b.peerPubB64)
          : a.role.localeCompare(b.role)
      );
  } catch {
    return [];
  }
}

/**
 * Пересчитывает member_count по таблице group_members и возвращает результат.
 *
 * v4.32.267: единственный способ изменить число участников. Раньше его вели
 * арифметикой ±1 в восьми местах от четырёх разных оснований, и любое
 * расхождение оставалось навсегда — пересчитать было нечем. Правило «кто
 * считается» — countsAsMember, то же самое, по которому список на экране
 * прячет забаненных.
 */
export async function recountGroupMembers(groupId: string, ownerProfileId: number): Promise<number> {
  const n = countMembers(await listGroupMembers(groupId, ownerProfileId));
  await updateGroupMeta(groupId, ownerProfileId, { memberCount: n });
  return n;
}

export async function removeGroupMember(
  groupId: string,
  peerPubB64: string,
  ownerProfileId: number
): Promise<void> {
  const d = await db();
  await d.runAsync(
    'DELETE FROM group_members WHERE group_id = ? AND peer_pub_b64 = ? AND owner_profile_id = ?',
    [groupId, peerPubB64, ownerProfileId]
  );
}

export async function updateGroupMemberRole(
  groupId: string,
  peerPubB64: string,
  role: MemberRole,
  ownerProfileId: number
): Promise<void> {
  const d = await db();
  await d.runAsync(
    'UPDATE group_members SET role = ? WHERE group_id = ? AND peer_pub_b64 = ? AND owner_profile_id = ?',
    [role, groupId, peerPubB64, ownerProfileId]
  );
}

// Group messages

/**
 * Записать групповое сообщение. `true` — строка действительно появилась.
 *
 * v4.32.581. Возвращаемое значение тут не для удобства: запрос — `INSERT OR
 * IGNORE`, а ошибки эта функция гасит сама, поэтому снаружи «повтор по msgId»
 * и «запись не удалась» выглядели точно так же, как успех. Приёмник на этом
 * основании поднимал счётчик непрочитанных и заново выносил на экран
 * блокировки сообщение, которое человек прочитал вчера, — а во втором случае
 * показывал уведомление о сообщении, которого в группе нет. В личной
 * переписке этого не было: там повтор отсекается через `chatMessageExists`
 * ДО записи, и счётчик трогается только на новом сообщении.
 */
export async function insertGroupMessage(msg: GroupMessageRow): Promise<boolean> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const textEnc = encryptAtRestString(msg.text, dek);
    // v4.32.279: media_cids шифруется — как в chat_messages. Дескриптор `nb:`
    // НЕСЁТ КЛЮЧ РАСШИФРОВКИ вложения (см. blobRef.ts), так что открытый
    // media_cids сводит на нет шифрование самого файла: текст сообщения лежал
    // шифртекстом, а ключ к прикреплённой к нему фотографии — рядом, открыто.
    const mediaEnc = encryptAtRestNullable(msg.mediaCids ?? null, dek);
    // v4.32.282: цитата — кусок чужого сообщения; шифруется как и всё остальное.
    const replyEnc = encryptAtRestNullable(msg.replyToPreview ?? null, dek);
    // v4.32.285: имя отправителя человек указывает сам, и в группе оно обычно
    // настоящее — по одной колонке `sender_name` читался весь состав группы и
    // кто в ней сколько говорит, при полностью зашифрованных сообщениях.
    const senderEnc = encryptAtRestNullable(msg.senderName ?? null, dek);
    const res = await d.runAsync(
      `INSERT OR IGNORE INTO group_messages
         (id, group_id, sender_pub_b64, sender_name, text, media_cids, reply_to_id, reply_to_preview, reactions, created_at, owner_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [msg.id, msg.groupId, msg.senderPubB64, senderEnc, textEnc,
       mediaEnc, msg.replyToId ?? null, replyEnc,
       encryptAtRestNullable(msg.reactions ?? null, dek), msg.createdAt, msg.ownerProfileId]
    );
    emitChatWrites();
    // `changes === 0` — сработало OR IGNORE, то есть строка с таким id уже
    // лежит: это повтор конверта, а не новое сообщение.
    return (res.changes ?? 0) > 0;
  } catch (e) {
    log.warn('insert_group_message_failed', { err: e instanceof Error ? e.message : String(e) });
    notifyIfStoragePressure(e, 'group_message_save');
    return false;
  }
}

/** Страница сообщений группы. Объектом, а не позициями — см. `ChatMessagePage`. */
export type GroupMessagePage = {
  groupId: string;
  limit: number;
  offset: number;
  ownerProfileId: number;
};

/**
 * Страница сообщений группы либо `null` — прочитать не удалось.
 *
 * v4.32.532: раньше здесь стоял `return []`, и сбой чтения был неотличим от
 * пустой группы. Экран на этом ставил `hasMore = false`, показывал «Нет
 * сообщений» и отмечал группу прочитанной — то есть одна секундная блокировка
 * базы стирала счётчик непрочитанного и прятала переписку без единого слова
 * об ошибке. Третий исход теперь в типе — см. `readResult.ts`.
 */
export async function listGroupMessages(
  { groupId, limit, offset, ownerProfileId }: GroupMessagePage
): Promise<DbRead<GroupMessageRow>> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const rows = await d.getAllAsync<{
      id: string; group_id: string; sender_pub_b64: string; sender_name: string | null;
      text: string; media_cids: string | null; reply_to_id: string | null;
      reply_to_preview: string | null; reactions: string | null;
      created_at: number; owner_profile_id: number; edited_at: number | null; starred: number;
      view_count: number; seen_by: string | null;
    }>(
      // v4.32.533: без id порядок не воспроизводим на сообщениях, поделивших
      // миллисекунду (догон после сети, восстановление из копии), и соседние
      // страницы теряли одни сообщения, показывая другие дважды.
      `SELECT * FROM group_messages WHERE group_id = ? AND owner_profile_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [groupId, ownerProfileId, limit, offset]
    );
    return rows.map((r) => {
      // v4.32.559: см. listChatMessages — то же различие нужно и группам.
      const cell = readAtRestCell(r.text, dek);
      // v4.32.591: список прочитавших — тоже три состояния, а не два.
      const seenCell = readAtRestCell(r.seen_by, dek);
      const seenList = parseViewerList(cellTextOrNull(seenCell), unreadableFromCellState(seenCell.state));
      const sender = readNameCell(r.sender_name, dek);
      return {
      id: r.id,
      groupId: r.group_id,
      senderPubB64: r.sender_pub_b64,
      senderName: sender.name,
      senderUnreadable: sender.unreadable,
      text: cell.state === 'plain' ? cell.text : '',
      unreadable: unreadableFromCellState(cell.state),
      ...readMediaCell(r.media_cids, dek),
      replyToId: r.reply_to_id,
      ...readReplyCell(r.reply_to_preview, dek),
      ...readReactionsCell(r.reactions, dek),
      createdAt: r.created_at,
      ownerProfileId: r.owner_profile_id,
      editedAt: r.edited_at,
      starred: Boolean(r.starred),
      viewCount: r.view_count ?? 0,
      // v4.32.181 (Round-11 #4): разбор seen_by не роняет отрисовку всего
      // списка на одной битой строке.
      // v4.32.591: и не выдаёт непрочитанный столбец за пустой список.
      seenBy: seenList.viewers.length > 0 ? seenList.viewers : null,
      seenUnreadable: !seenList.unknown ? undefined : true,
      };
    });
  } catch (e) {
    log.warn('list_group_messages_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Вся переписка группы страницами — для экспорта и общих медиа.
 *
 * v4.32.532: сбой на любой странице обрывает целое. Прежде провалившаяся
 * страница приходила пустым списком, цикл читал её как «дальше ничего нет» и
 * возвращал усечённый результат молча — экспорт переписки на тысячу сообщений
 * мог выгрузить первые пятьсот и выглядеть полным. Обрезанная выгрузка хуже,
 * чем её отсутствие: её сохраняют и на неё ссылаются.
 */
export async function listAllGroupMessages(
  { groupId, ownerProfileId }: Pick<GroupMessagePage, 'groupId' | 'ownerProfileId'>
): Promise<DbRead<GroupMessageRow>> {
  const pageSize = 500;
  const out: GroupMessageRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await listGroupMessages({ groupId, ownerProfileId, limit: pageSize, offset });
    if (page === null) return null;
    out.push(...page);
    if (page.length < pageSize) return out;
    offset += page.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// v4.32.226 счётчик просмотров группы стал пустышкой: он делал слепой
// `view_count + 1` на каждое открытие чата, без личности читателя и без
// дедупликации, — то есть считал собственные заходы владельца и раздувал
// значок просмотров до тысяч в канале с одним подписчиком. Просмотры с тех пор
// считаются по числу разных читателей в seen_by (по квитанциям о прочтении) —
// значок в GroupsScreen и GroupMessageInfoModal.
//
// v4.32.301: сама пустая функция incrementGroupMessagesViewCount удалена.
// Держали её ради «единообразия экспорта с веб-сборкой», а веб-сборки больше
// нет; вызывающих у неё не осталось ни одного. Восстанавливать инкремент не
// нужно — вернутся и накрутка, и жалобы на неё.

/**
 * Добавить pubB64 читателя к seen_by в конкретном сообщении группы.
 * Вызывается при получении read-receipt от другого участника.
 */
export async function markGroupMessageSeen(
  msgId: string,
  groupId: string,
  ownerProfileId: number,
  viewerPubB64: string
): Promise<void> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const row = await d.getFirstAsync<{ seen_by: string | null }>(
      'SELECT seen_by FROM group_messages WHERE id = ? AND group_id = ? AND owner_profile_id = ?',
      [msgId, groupId, ownerProfileId]
    );
    if (!row) return;
    // v4.32.189 (Round-19 #3): guard against corrupt/non-array seen_by.
    // If a prior partial write stored `{}`, `current.includes` would throw
    // and no row would ever be marked seen; if it stored anything else
    // truthy, `push` on a non-array writes back broken JSON.
    // v4.32.544: непрочитанный столбец больше не выглядит как «никто не
    // читал». Раньше список прочитавших в этом случае перезаписывался одним
    // нынешним читателем.
    const seenCell = readAtRestCell(row.seen_by, dek);
    if (!mayOverwrite(seenCell)) {
      log.warn('group_seen_by_unreadable', {});
      return;
    }
    // v4.32.591: разбор один на все списки ключей — см. social/viewerList.
    const current = parseViewerList(cellTextOrNull(seenCell)).viewers;
    if (current.includes(viewerPubB64)) return; // already recorded
    // v4.32.201 (Round-31 #1): cap seen_by at 1000 to prevent a hostile
    // group member spamming receipts from spoofed pubkeys bloating the row.
    if (current.length >= 1000) return;
    current.push(viewerPubB64);
    await d.runAsync(
      'UPDATE group_messages SET seen_by = ? WHERE id = ? AND group_id = ? AND owner_profile_id = ?',
      [encryptAtRestString(JSON.stringify(current), dek), msgId, groupId, ownerProfileId]
    );
    emitChatWrites();
  } catch (e) {
    log.warn('mark_group_message_seen_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export type GroupStats = {
  totalMessages: number;
  mediaCount: number;
  firstMessageAt: number | null;
  /**
   * v4.32.592: имя больше не строка «как получилось». `name` — прочитанное
   * имя либо `null` (строка без имени или не открывшийся столбец), `pub` —
   * ключ, по которому и шла группировка, так что подписать строку есть чем
   * всегда, `unreadable` — признак «ключ не открыл имя».
   */
  topSenders: Array<{ name: string | null; pub: string; unreadable: boolean; count: number }>;
  dailyActivity: Array<{ date: string; count: number }>;
};

export async function getGroupStats(groupId: string, ownerProfileId: number): Promise<GroupStats> {
  try {
    const d = await db();
    const totals = await d.getFirstAsync<{ total: number; media: number; first_at: number | null }>(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN media_cids IS NOT NULL THEN 1 END) as media,
              MIN(created_at) as first_at
       FROM group_messages WHERE group_id = ? AND owner_profile_id = ?`,
      [groupId, ownerProfileId],
    );
    const statsDek = await getOrCreateDataEncryptionKey();
    const senders = await d.getAllAsync<{ sender_pub_b64: string; sender_name: string | null; cnt: number }>(
      // v4.32.592: ключ отправителя тоже выбирается — по нему подписывается
      // строка, если имени нет. Голое `sender_name` при `GROUP BY` отдавало
      // имя произвольной строки группы и легко попадало на строку без имени
      // при том, что у соседних оно есть; `MAX` от NULL уходит.
      `SELECT sender_pub_b64, MAX(sender_name) as sender_name, COUNT(*) as cnt
       FROM group_messages WHERE group_id = ? AND owner_profile_id = ?
       GROUP BY sender_pub_b64 ORDER BY cnt DESC LIMIT 5`,
      [groupId, ownerProfileId],
    );
    // Daily activity for the last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const dailyRows = await d.getAllAsync<{ day: string; cnt: number }>(
      `SELECT strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch')) as day, COUNT(*) as cnt
       FROM group_messages WHERE group_id = ? AND owner_profile_id = ? AND created_at >= ?
       GROUP BY day ORDER BY day ASC`,
      [groupId, ownerProfileId, sevenDaysAgo],
    );
    // Build full 7-day array
    const dayMap = new Map(dailyRows.map((r) => [r.day, r.cnt]));
    const dailyActivity: Array<{ date: string; count: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d2 = new Date(Date.now() - i * 24 * 3600 * 1000);
      const key = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
      dailyActivity.push({ date: key, count: dayMap.get(key) ?? 0 });
    }
    return {
      totalMessages: totals?.total ?? 0,
      mediaCount: totals?.media ?? 0,
      firstMessageAt: totals?.first_at ?? null,
      // v4.32.592: раньше здесь стояло `decryptAtRestNullable(...) ?? '?'` —
      // и `??` не срабатывал, потому что при неудаче расшифровки приходит не
      // `null`, а пустая строка. В списке «Самые активные» появлялась строка
      // без имени вовсе: ни имени, ни знака вопроса, ни подписи ключом.
      topSenders: senders.map((s) => {
        const cell = readAtRestCell(s.sender_name, statsDek);
        return {
          name: cellTextOrNull(cell),
          pub: s.sender_pub_b64,
          unreadable: unreadableFromCellState(cell.state) === true,
          count: s.cnt,
        };
      }),
      dailyActivity,
    };
  } catch (e) {
    log.warn('get_group_stats_failed', { err: e instanceof Error ? e.message : String(e) });
    return { totalMessages: 0, mediaCount: 0, firstMessageAt: null, topSenders: [], dailyActivity: [] };
  }
}

// ─── Poll votes ───────────────────────────────────────────────────────────────

// Кодек опроса переехал в core/social/pollEnvelope.ts. Здесь он был заперт в
// модуле, который тянет SQLite, — то есть разбор недоверенного JSON нельзя
// было проверить ни одним тестом; и требования сборки с требованиями разбора
// успели разойтись (разбор принимал опрос без вариантов и викторину без
// правильного ответа). Реэкспорт — чтобы импорты из storage/local остались
// на месте.
export {
  POLL_PREFIX,
  POLL_MAX_QUESTION_LENGTH,
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_LENGTH,
  PollValidationError,
  isPollMessage,
  makePollText,
  parsePollText,
} from '../social/pollEnvelope';

export async function setPollVote(
  messageId: string,
  voterPubB64: string,
  optionIndex: number,
  ownerProfileId: number,
  allowMultiple?: boolean,
): Promise<void> {
  // v4.32.199 (Round-29 #7): defense-in-depth — clamp optionIndex to a safe
  // range. feedService callers already validate, but future DM poll paths
  // could hit this primitive with unvalidated wire input; storing
  // optionIndex: 999999 corrupts tallies and grows poll_votes per message.
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 255) return;
  const d = await db();
  if (!allowMultiple) {
    await d.runAsync(
      `DELETE FROM poll_votes WHERE message_id = ? AND voter_pub_b64 = ? AND owner_profile_id = ? AND option_index != ?`,
      [messageId, voterPubB64, ownerProfileId, optionIndex]
    );
  }
  await d.runAsync(
    `INSERT OR REPLACE INTO poll_votes (message_id, voter_pub_b64, option_index, owner_profile_id)
     VALUES (?, ?, ?, ?)`,
    [messageId, voterPubB64, optionIndex, ownerProfileId]
  );
  emitChatWrites();
}

export async function deletePollVote(
  messageId: string,
  voterPubB64: string,
  optionIndex: number,
  ownerProfileId: number
): Promise<void> {
  const d = await db();
  await d.runAsync(
    `DELETE FROM poll_votes WHERE message_id = ? AND voter_pub_b64 = ? AND option_index = ? AND owner_profile_id = ?`,
    [messageId, voterPubB64, optionIndex, ownerProfileId]
  );
  emitChatWrites();
}

export async function getPollVotes(
  messageId: string,
  ownerProfileId: number
): Promise<Array<{ voterPubB64: string; optionIndex: number }>> {
  const d = await db();
  const rows = await d.getAllAsync<{ voter_pub_b64: string; option_index: number }>(
    'SELECT voter_pub_b64, option_index FROM poll_votes WHERE message_id = ? AND owner_profile_id = ?',
    [messageId, ownerProfileId]
  );
  return rows.map((r) => ({ voterPubB64: r.voter_pub_b64, optionIndex: r.option_index }));
}

/**
 * Итог поиска: найденное и счёт того, до чего поиск не смог добраться.
 *
 * v4.32.581. Голого массива было мало: пустая выдача «ничего не найдено» и
 * пустая выдача «всю историю не открыл ключ» выглядели одинаково. Форма
 * повторяет AttachmentRefs — данные и рядом с ними честный счёт неудач.
 */
export type SearchOutcome<T> = {
  items: T[];
  /** Счёт по строкам, до которых поиск дошёл (после limit обход прекращается). */
  scan: SearchScan;
};

export async function searchGroupMessages(
  groupId: string,
  query: string,
  ownerProfileId: number,
  limit = 30
): Promise<SearchOutcome<GroupMessageRow>> {
  if (!query.trim()) return { items: [], scan: emptySearchScan() };
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    // NOTE: text column is XChaCha20-Poly1305 ciphertext. SQL LIKE on ciphertext
    // never matches, so we pull candidates by recency and filter in JS after decrypt.
    const candidateLimit = Math.max(limit * 20, 200);
    if (candidateLimit > 2000) {
      log.warn('search_group_messages_wide_scan', { candidateLimit, groupId });
    }
    const rows = await d.getAllAsync<{
      id: string; group_id: string; sender_pub_b64: string; sender_name: string | null;
      text: string; media_cids: string | null; reply_to_id: string | null;
      reply_to_preview: string | null; reactions: string | null;
      created_at: number; owner_profile_id: number; edited_at: number | null;
    }>(
      `SELECT * FROM group_messages WHERE group_id = ? AND owner_profile_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [groupId, ownerProfileId, candidateLimit]
    );
    // trim здесь, а не у вызывающего: глобальный поиск передавал строку как
    // есть, и один лишний пробел давал пустую выдачу при живых совпадениях.
    const needle = query.trim().toLowerCase();
    const out: GroupMessageRow[] = [];
    const scan = emptySearchScan();
    for (const r of rows) {
      // v4.32.581: раньше здесь стоял decryptAtRestString, и строка, которую
      // ключ данных не открыл, превращалась в пустую — она не совпадала ни с
      // чем и молча выпадала из выдачи, а человеку показывали «ничего не
      // найдено». Теперь такие строки считаются отдельно (см. searchScan).
      const cell = readAtRestCell(r.text, dek);
      noteSearchedRow(scan, cell.state !== 'unreadable');
      if (cell.state === 'unreadable') continue;
      const plain = cellTextOrNull(cell) ?? '';
      // v4.32.239: сравнение с видимым текстом, а не с сырым конвертом — иначе
      // «cid», «lat», «http» находили каждое вложение (см. searchableText.ts).
      if (!matchesSearch(plain, needle)) continue;
      const sender = readNameCell(r.sender_name, dek);
      out.push({
        id: r.id,
        groupId: r.group_id,
        senderPubB64: r.sender_pub_b64,
        senderName: sender.name,
        senderUnreadable: sender.unreadable,
        text: plain,
        ...readMediaCell(r.media_cids, dek),
        replyToId: r.reply_to_id,
        ...readReplyCell(r.reply_to_preview, dek),
        ...readReactionsCell(r.reactions, dek),
        createdAt: r.created_at,
        ownerProfileId: r.owner_profile_id,
        editedAt: r.edited_at,
      });
      if (out.length >= limit) break;
    }
    return { items: out, scan };
  } catch (e) {
    log.warn('search_group_messages_failed', { err: e instanceof Error ? e.message : String(e) });
    return { items: [], scan: emptySearchScan() };
  }
}

// ─── Cross-Group Message Search ───────────────────────────────────────────────

export type GroupMessageSearchResult = {
  message: GroupMessageRow;
  groupId: string;
  groupName: string;
};

/**
 * Full-text search across all group messages for the current profile.
 * Returns up to `limit` most-recent results with the group name resolved.
 */
export async function searchAllGroupMessages(
  query: string,
  ownerProfileId: number,
  limit = 30
): Promise<SearchOutcome<GroupMessageSearchResult>> {
  if (!query.trim()) return { items: [], scan: emptySearchScan() };
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    // NOTE: gm.text is ciphertext; SQL LIKE on it never matches. Fetch recent
    // candidates, decrypt, filter in JS.
    const candidateLimit = Math.max(limit * 20, 200);
    if (candidateLimit > 2000) {
      log.warn('search_all_group_messages_wide_scan', { candidateLimit });
    }
    const rows = await d.getAllAsync<{
      id: string; group_id: string; sender_pub_b64: string; sender_name: string | null;
      text: string; media_cids: string | null; reply_to_id: string | null;
      reply_to_preview: string | null; reactions: string | null;
      created_at: number; owner_profile_id: number; edited_at: number | null;
      group_name: string | null;
    }>(
      `SELECT gm.*, g.name AS group_name
       FROM group_messages gm
       LEFT JOIN groups g ON g.id = gm.group_id AND g.owner_profile_id = gm.owner_profile_id
       WHERE gm.owner_profile_id = ?
       ORDER BY gm.created_at DESC LIMIT ?`,
      [ownerProfileId, candidateLimit]
    );
    // trim здесь, а не у вызывающего: глобальный поиск передавал строку как
    // есть, и один лишний пробел давал пустую выдачу при живых совпадениях.
    const needle = query.trim().toLowerCase();
    const out: GroupMessageSearchResult[] = [];
    const scan = emptySearchScan();
    for (const r of rows) {
      // v4.32.581: раньше здесь стоял decryptAtRestString, и строка, которую
      // ключ данных не открыл, превращалась в пустую — она не совпадала ни с
      // чем и молча выпадала из выдачи, а человеку показывали «ничего не
      // найдено». Теперь такие строки считаются отдельно (см. searchScan).
      const cell = readAtRestCell(r.text, dek);
      noteSearchedRow(scan, cell.state !== 'unreadable');
      if (cell.state === 'unreadable') continue;
      const plain = cellTextOrNull(cell) ?? '';
      // v4.32.239: сравнение с видимым текстом, а не с сырым конвертом — иначе
      // «cid», «lat», «http» находили каждое вложение (см. searchableText.ts).
      if (!matchesSearch(plain, needle)) continue;
      const sender = readNameCell(r.sender_name, dek);
      out.push({
        groupId: r.group_id,
        groupName: r.group_name ?? r.group_id.slice(0, 8),
        message: {
          id: r.id,
          groupId: r.group_id,
          senderPubB64: r.sender_pub_b64,
          senderName: sender.name,
          senderUnreadable: sender.unreadable,
          text: plain,
          ...readMediaCell(r.media_cids, dek),
          replyToId: r.reply_to_id,
          ...readReplyCell(r.reply_to_preview, dek),
          ...readReactionsCell(r.reactions, dek),
          createdAt: r.created_at,
          ownerProfileId: r.owner_profile_id,
          editedAt: r.edited_at,
        },
      });
      if (out.length >= limit) break;
    }
    return { items: out, scan };
  } catch (e) {
    log.warn('search_all_group_messages_failed', { err: e instanceof Error ? e.message : String(e) });
    return { items: [], scan: emptySearchScan() };
  }
}

// v4.32.301: updateGroupMessageReactions удалена по той же причине, что и
// парная ей updateMessageReactions выше — реакции в группе меняет
// toggleReaction(..., { group: true }), за одно чтение-запись.

/** Очистить историю диалога (удаляет все сообщения, сбрасывает метаданные). */
export async function clearChatHistory(
  contactPubB64: string,
  ownerProfileId: number
): Promise<void> {
  const d = await db();
  // v4.32.272: та же чистка кэша вложений, что и у групп, — «очистить историю»
  // не должно оставлять расшифрованные снимки на диске.
  const dek = await getOrCreateDataEncryptionKey();
  const doomed = newAttachmentRefs();
  await collectAttachmentRefs(
    d,
    dek,
    'SELECT text, media_cids FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
    [contactPubB64, ownerProfileId],
    doomed
  );
  await eraseAtomically(
    d,
    'clear_chat_history',
    async () => {
      await deletePollArtifactsBySelect(
        d,
        'SELECT id FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
        [contactPubB64, ownerProfileId],
        ownerProfileId
      );
      await d.runAsync(
        'DELETE FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ?',
        [contactPubB64, ownerProfileId]
      );
      // v4.32.276: корзина «недавно удалённые» переживала очистку истории и держала
      // тексты ещё месяц — то есть «очистить» очищало не всё.
      await kvDeleteScoped(ownerProfileId, recentlyDeletedKey(contactPubB64));
      // v4.32.296: перечень следов — в purgeResidue, один на все три «очистить».
      // Здесь не хватало pinned_message_id: указатель на удалённое сообщение
      // оставался, и шапка переписки пыталась показать то, чего уже нет.
      await d.runAsync(clearTracesSql('conversations', 'row'), [ownerProfileId, contactPubB64]);
    },
    () => dropOrphanBlobCache(doomed)
  );
  emitChatWrites();
}

/**
 * v4.32.377: здесь лежала getGroupMessageSender — «публичный ключ автора
 * сообщения группы», и в её описании было прямо написано, что она нужна для
 * проверки прав на правку и удаление по входящему конверту.
 *
 * Отвечала она только на вопрос «кто написал сообщение с таким id», но не на
 * вопрос «в какой оно группе». Ровно этой недостающей связи и не было в
 * проверке прав до v4.32.342: права считались по группе из конверта, а правилось
 * и удалялось по id сообщения, так что администратор своей группы дотягивался
 * до любого сообщения в любой чужой, зная только его идентификатор. Проверка
 * с тех пор спрашивает getGroupMessageTarget (ниже) и сверяет группу, а
 * прежняя функция осталась лежать рядом — без единого вызова, но с описанием,
 * которое советует брать для проверки прав именно её.
 */

/**
 * Сообщение группы для проверки входящего конверта опроса: в какой группе оно
 * лежит, кто автор и что в тексте.
 *
 * v4.32.342: голоса живут в poll_votes отдельно от сообщения и без ссылки на
 * него, так что по message_id из конверта надо спросить отдельно — иначе голос
 * записывается по любому названному id. Автор нужен конверту завершения (свой
 * опрос либо админ), группа и текст — конверту голоса (см. pollVoteGuard).
 *
 * v4.32.574: текст — `null`, если своя копия не открылась. Раньше здесь стоял
 * decryptAtRestString, который на осечке отдаёт пустую строку, и «своя копия
 * не читается» приходило в проверку неотличимо от «в сообщении пусто» —
 * то есть чужой честный голос отвергался с кодом «это не опрос».
 */
export async function getGroupMessageTarget(
  messageId: string,
  ownerProfileId: number
): Promise<{ groupId: string; senderPubB64: string; text: string | null } | null> {
  try {
    const d = await db();
    const row = await d.getFirstAsync<{ group_id: string; sender_pub_b64: string; text: string }>(
      'SELECT group_id, sender_pub_b64, text FROM group_messages WHERE id = ? AND owner_profile_id = ? LIMIT 1',
      [messageId, ownerProfileId]
    );
    if (!row) return null;
    const dek = await getOrCreateDataEncryptionKey();
    return {
      groupId: row.group_id,
      senderPubB64: row.sender_pub_b64,
      text: cellTextOrNull(readAtRestCell(row.text, dek)),
    };
  } catch (e) {
    log.warn('get_group_message_target_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * То же для личного чата: с кем переписка и что в тексте сообщения.
 * Направление здесь не нужно — голосовать в опросе вправе обе стороны диалога.
 *
 * Текст — `null`, если своя копия не открылась (v4.32.574, см. выше).
 */
export async function getChatMessageTarget(
  messageId: string,
  ownerProfileId: number
): Promise<{ contactPubB64: string; text: string | null } | null> {
  try {
    const d = await db();
    const row = await d.getFirstAsync<{ contact_pub_b64: string; text: string }>(
      'SELECT contact_pub_b64, text FROM chat_messages WHERE id = ? AND owner_profile_id = ? LIMIT 1',
      [messageId, ownerProfileId]
    );
    if (!row) return null;
    const dek = await getOrCreateDataEncryptionKey();
    return {
      contactPubB64: row.contact_pub_b64,
      text: cellTextOrNull(readAtRestCell(row.text, dek)),
    };
  } catch (e) {
    log.warn('get_chat_message_target_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Тексты нескольких сообщений группы по id, расшифрованные.
 *
 * v4.32.233: нужно для списка закреплённых. Раньше превью закреплённого
 * лежало копией в kv открытым текстом — в обход шифрования at-rest, которым
 * закрыты и сами сообщения, и groups.pinned_message_text. Теперь в kv лежат
 * только id, а текст всегда берётся отсюда (заодно он больше не расходится с
 * оригиналом после правки сообщения).
 *
 * v4.32.343: группа обязательна. Список id приходит из недоверенного конверта —
 * закрепления и цитаты, — а выборка шла по одному id, поэтому сообщение из
 * другой группы находилось и его текст попадал сюда как свой. Тем, кто состоит
 * в обеих группах, чужая переписка показывалась в баннере и в цитате. *
 * v4.32.575: значение `null` — строка есть, но своя копия не открывается;
 * отсутствие ключа — своей копии нет вовсе. Раньше и то и другое приходило
 * пустой строкой (decryptAtRestString отдаёт '' на осечке), и вызывающий
 * принимал нечитаемую копию за пустой текст: цитата обнулялась, а проверка
 * «эту строку правит только живая геолокация» сравнивала '' с префиксом.
 */
export async function getGroupMessageTexts(
  messageIds: string[],
  groupId: string,
  ownerProfileId: number
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!messageIds.length) return out;
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = await d.getAllAsync<{ id: string; text: string }>(
      `SELECT id, text FROM group_messages WHERE owner_profile_id = ? AND group_id = ? AND id IN (${placeholders})`,
      [ownerProfileId, groupId, ...messageIds]
    );
    for (const r of rows) out.set(r.id, cellTextOrNull(readAtRestCell(r.text, dek)));
  } catch (e) {
    log.warn('get_group_message_texts_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

/**
 * Тексты нескольких сообщений личного чата по id, расшифрованные.
 *
 * v4.32.235: то же, что getGroupMessageTexts, но для DM. Список закреплённых
 * личного чата хранил в kv копию текста открытым — при том, что
 * chat_messages.text шифруется at-rest. Теперь в kv только id.
 *
 * v4.32.343: собеседник обязателен — по той же причине. Закрепить в личке
 * вправе любая из сторон, и id для этого приходит по сети: без привязки к
 * переписке собеседник закреплял у меня сообщение из моего разговора с
 * третьим человеком и читал его текст в собственном баннере.
 *
 * `null` — своя копия не открывается (v4.32.575, см. getGroupMessageTexts).
 */
export async function getChatMessageTexts(
  messageIds: string[],
  contactPubB64: string,
  ownerProfileId: number
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!messageIds.length) return out;
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = await d.getAllAsync<{ id: string; text: string }>(
      `SELECT id, text FROM chat_messages WHERE owner_profile_id = ? AND contact_pub_b64 = ? AND id IN (${placeholders})`,
      [ownerProfileId, contactPubB64, ...messageIds]
    );
    for (const r of rows) out.set(r.id, cellTextOrNull(readAtRestCell(r.text, dek)));
  } catch (e) {
    log.warn('get_chat_message_texts_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

export async function deleteGroupMessage(
  messageId: string,
  ownerProfileId: number
): Promise<void> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const doomed = newAttachmentRefs();
    await collectAttachmentRefs(
      d,
      dek,
      'SELECT text, media_cids FROM group_messages WHERE id = ? AND owner_profile_id = ?',
      [messageId, ownerProfileId],
      doomed
    );
    await d.runAsync(
      'DELETE FROM group_messages WHERE id = ? AND owner_profile_id = ?',
      [messageId, ownerProfileId]
    );
    await deletePollArtifacts(d, [messageId], ownerProfileId);
    await dropOrphanBlobCache(doomed);
    emitChatWrites();
  } catch (e) {
    log.warn('delete_group_message_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Очистить историю сообщений группы (локально). */
export async function clearGroupMessages(groupId: string, ownerProfileId: number): Promise<void> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const doomed = newAttachmentRefs();
    await collectAttachmentRefs(
      d,
      dek,
      'SELECT text, media_cids FROM group_messages WHERE group_id = ? AND owner_profile_id = ?',
      [groupId, ownerProfileId],
      doomed
    );
    await eraseAtomically(
      d,
      'clear_group_messages',
      async () => {
        await deletePollArtifactsBySelect(
          d,
          'SELECT id FROM group_messages WHERE group_id = ? AND owner_profile_id = ?',
          [groupId, ownerProfileId],
          ownerProfileId
        );
        await d.runAsync(
          'DELETE FROM group_messages WHERE group_id = ? AND owner_profile_id = ?',
          [groupId, ownerProfileId]
        );
        await kvDeleteScoped(ownerProfileId, recentlyDeletedGroupKey(groupId));
        // v4.32.296: строку groups здесь не трогали вовсе. После «очистить
        // историю» в списке оставались превью последнего сообщения и имя того, кто
        // его написал, счётчик непрочитанных не обнулялся, а в шапке продолжал
        // висеть баннер с закреплённым сообщением целиком — pinned_message_text
        // хранит копию текста, и удаление group_messages её не касается.
        await d.runAsync(clearTracesSql('groups', 'row'), [ownerProfileId, groupId]);
      },
      () => dropOrphanBlobCache(doomed)
    );
    emitChatWrites();
  } catch (e) {
    log.warn('clear_group_messages_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Изменить текст сообщения группы (только своё). */
/**
 * v4.32.530: правка сообщения группы отвечает, применилась ли она.
 *
 * Раньше функция возвращала void и глотала собственную ошибку, поэтому экран
 * не мог отличить сохранённую правку от несохранённой: он закрывал редактор,
 * рассылал новый текст всем участникам и перечитывал список — а в базе
 * оставался старый текст. У группы новая версия, у автора старая.
 *
 * Ноль изменённых строк — тоже отказ, а не успех: чужой id или другой профиль
 * означают, что править было нечего. Сигнал о записи идёт только за реальным
 * изменением (см. writeEcho).
 */
export async function updateGroupMessageText(
  messageId: string,
  newText: string,
  ownerProfileId: number
): Promise<boolean> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    const textEnc = encryptAtRestString(newText, dek);
    const res = await d.runAsync(
      'UPDATE group_messages SET text = ?, edited_at = ? WHERE id = ? AND owner_profile_id = ?',
      [textEnc, Date.now(), messageId, ownerProfileId]
    );
    if (!anyChanged(res)) {
      log.warn('update_group_message_text_no_row', { id: messageId.slice(0, 8), pid: ownerProfileId });
      return false;
    }
    emitChatWrites();
    return true;
  } catch (e) {
    log.warn('update_group_message_text_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

export type StoryRow = {
  id: string;
  authorPubB64: string;
  /** local URI or IPFS CID */
  mediaUri: string | null;
  /** 'image' | 'video' — default 'image' */
  mediaType: 'image' | 'video';
  text: string | null;
  expiresAt: number;
  /** JSON array of pubkeys that have viewed this story */
  viewedBy: string | null;
  ownerProfileId: number;
  createdAt: number;
  /** v4.32.586: адрес снимка есть в базе, но ключ его не открывает. */
  mediaUnreadable?: boolean;
  /** v4.32.586: подпись есть в базе, но ключ её не открывает. */
  textUnreadable?: boolean;
  /** v4.32.590: список посмотревших есть в базе, но ключ его не открывает. */
  viewedUnreadable?: boolean;
};

const STORY_TTL_MS = 24 * 3_600_000; // 24 hours

/**
 * v4.32.284: сторис живёт сутки, но её подпись, путь к медиа и список
 * посмотревших лежали открытым текстом всё это время — и оставались в базе
 * после истечения, пока не пройдёт уборщик. `viewed_by` — это список
 * публичных ключей: кто именно смотрел, то есть кусок социального графа
 * рядом с зашифрованной перепиской.
 */
export async function insertStory(row: StoryRow): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    `INSERT OR IGNORE INTO stories
      (id, author_pub_b64, media_uri, media_type, text, expires_at, viewed_by, owner_profile_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [row.id, row.authorPubB64, encryptAtRestNullable(row.mediaUri ?? null, dek), row.mediaType ?? 'image',
     encryptAtRestNullable(row.text ?? null, dek),
     row.expiresAt, encryptAtRestNullable(row.viewedBy ?? null, dek), row.ownerProfileId, row.createdAt]
  );
}

/** Returns non-expired stories for the given ownerProfileId, newest first. */
export async function listActiveStories(ownerProfileId: number): Promise<StoryRow[]> {
  const d = await db();
  const now = Date.now();
  const rows = await d.getAllAsync<{
    id: string; author_pub_b64: string; media_uri: string | null;
    media_type: string | null;
    text: string | null; expires_at: number; viewed_by: string | null;
    owner_profile_id: number; created_at: number;
  }>(
    `SELECT * FROM stories WHERE owner_profile_id = ? AND expires_at > ? ORDER BY created_at DESC`,
    [ownerProfileId, now]
  );
  const dek = await getOrCreateDataEncryptionKey();
  // v4.32.586: читаем состоянием, а не строкой. Непрочитанный снимок и
  // непрочитанная подпись приходили пустотой, и сторис рисовалась пустой
  // чёрной карточкой — неотличимо от сторис, в которой и правда ничего нет.
  return rows.map((r) => {
    const mediaCell = readAtRestCell(r.media_uri, dek);
    const textCell = readAtRestCell(r.text, dek);
    // v4.32.590: список посмотревших приходил пустотой, и чужая сторис
    // навсегда оставалась «новой»: кружок гас только записью в тот же
    // столбец, а писать в непрочитанный столбец нельзя с v4.32.544.
    const viewedCell = readAtRestCell(r.viewed_by, dek);
    return {
      id: r.id,
      authorPubB64: r.author_pub_b64,
      mediaUri: cellTextOrNull(mediaCell),
      mediaType: (r.media_type === 'video' ? 'video' : 'image') as 'image' | 'video',
      text: cellTextOrNull(textCell),
      expiresAt: r.expires_at,
      viewedBy: cellTextOrNull(viewedCell),
      ownerProfileId: r.owner_profile_id,
      createdAt: r.created_at,
      mediaUnreadable: unreadableFromCellState(mediaCell.state),
      textUnreadable: unreadableFromCellState(textCell.state),
      viewedUnreadable: unreadableFromCellState(viewedCell.state),
    };
  });
}

/**
 * Сколько ещё не истёкших сторис есть от этого автора.
 *
 * v4.32.248: нужен для потолка на входящие. Сторис приходит личным сообщением,
 * и её медиа скачивается сразу при получении, поэтому контакт, отправивший
 * тысячу конвертов, означал тысячу строк в базе и тысячу загрузок вложений
 * (до 8 МБ каждое) без единого действия со стороны получателя.
 */
export async function countActiveStoriesByAuthor(
  authorPubB64: string,
  ownerProfileId: number
): Promise<number> {
  const d = await db();
  const row = await d.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM stories WHERE author_pub_b64 = ? AND owner_profile_id = ? AND expires_at > ?',
    [authorPubB64, ownerProfileId, Date.now()]
  );
  return row?.n ?? 0;
}

export async function markStoryViewed(storyId: string, viewerPubB64: string, ownerProfileId?: number): Promise<void> {
  const d = await db();
  const pid = ownerProfileId ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id ?? 1;
  const row = await d.getFirstAsync<{ viewed_by: string | null }>(
    'SELECT viewed_by FROM stories WHERE id = ? AND owner_profile_id = ?', [storyId, pid]
  );
  if (!row) return;
  const dek = await getOrCreateDataEncryptionKey();
  // v4.32.544: то же, что с реакциями и прочитавшими, — непрочитанный столбец
  // не повод объявить, что сторис никто не смотрел, и переписать список одним
  // нынешним зрителем.
  const viewedCell = readAtRestCell(row.viewed_by, dek);
  if (!mayOverwrite(viewedCell)) {
    log.warn('story_viewed_by_unreadable', {});
    return;
  }
  // v4.32.591: разбор один на все списки ключей — см. social/viewerList.
  const viewers = parseViewerList(cellTextOrNull(viewedCell)).viewers;
  // v4.32.201 (Round-31 #2): cap viewers at 500 + array-shape guard.
  if (!viewers.includes(viewerPubB64) && viewers.length < 500) {
    viewers.push(viewerPubB64);
    await d.runAsync('UPDATE stories SET viewed_by = ? WHERE id = ? AND owner_profile_id = ?',
      [encryptAtRestString(JSON.stringify(viewers), dek), storyId, pid]);
  }
}

/**
 * Расшифрованные файлы удалённых сторис.
 *
 * v4.32.361: сторис живёт сутки, а её снимок — расшифрованный, открытым
 * текстом — оставался в кэше приложения и после того, как строка исчезала.
 * Суточная чистка sweepMediaCache подбирала его только при следующем запуске
 * приложения: не перезапускали неделю — неделю он и лежал. Эфемерность,
 * которую видно в интерфейсе, на диске не выполнялась.
 *
 * Стираем только то, что создали сами при расшифровке (`airchat_media_…`):
 * у своей сторис в media_uri лежит снимок, выбранный из галереи, и он
 * принадлежит не нам. deleteCachedFileUris вдобавок держит удаление внутри
 * кэша приложения.
 */
async function dropStoryMediaFiles(
  d: SQLite.SQLiteDatabase,
  dek: Uint8Array,
  doomed: readonly StoryUriCell[],
  ownerProfileId: number
): Promise<void> {
  // v4.32.586: истёкшая строка, чей адрес не открылся, унесла его с собой —
  // стереть файл нечем, и он остаётся до суточного sweepMediaCache. Молчать
  // об этом нельзя: обещанная эфемерность в этот раз не выполнена.
  const lost = lostAddressCount(doomed);
  if (lost > 0) log.warn('story_media_address_unreadable', { lost });
  const ours = doomed
    .filter((c) => c.state === 'plain' && !!c.uri && isDecryptedBlobUri(c.uri))
    .map((c) => c.uri as string);
  if (ours.length === 0) return;
  try {
    // Уцелевшие строки: один и тот же файл может быть у двух сторис (одна и
    // та же приходит от контакта и остаётся своей), и стереть его вместе с
    // первой значило бы опустошить вторую.
    const alive = (await d.getAllAsync<{ media_uri: string | null }>(
      'SELECT media_uri FROM stories WHERE owner_profile_id = ?', [ownerProfileId]
    )).map((r) => storyUriCell(r.media_uri, dek));
    const plan = planStoryMediaSweep(ours, alive);
    if (plan.blocked) {
      log.warn('story_media_cleanup_deferred', { pending: ours.length });
      return;
    }
    if (plan.deletable.length === 0) return;
    const { deleteCachedFileUris } = await import('../media/mediaBlob');
    await deleteCachedFileUris(plan.deletable);
  } catch (e) {
    log.warn('story_media_cleanup_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** v4.32.586: столбец с адресом снимка тремя состояниями, а не строкой. */
function storyUriCell(stored: string | null, dek: Uint8Array): StoryUriCell {
  const cell = readAtRestCell(stored, dek);
  return { state: cell.state, uri: cellTextOrNull(cell) };
}

export async function deleteExpiredStories(ownerProfileId?: number): Promise<void> {
  const d = await db();
  const pid = ownerProfileId ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id ?? 1;
  const now = Date.now();
  // Читаем тем же условием, что и удаляем, и до удаления: иначе адреса файлов
  // уходят из базы вместе со строками, и стирать становится нечего.
  const doomed = await d.getAllAsync<{ media_uri: string | null }>(
    'SELECT media_uri FROM stories WHERE expires_at < ? AND owner_profile_id = ?', [now, pid]);
  await d.runAsync('DELETE FROM stories WHERE expires_at < ? AND owner_profile_id = ?', [now, pid]);
  if (doomed.length === 0) return;
  const dek = await getOrCreateDataEncryptionKey();
  await dropStoryMediaFiles(d, dek, doomed.map((r) => storyUriCell(r.media_uri, dek)), pid);
}

export async function deleteStory(storyId: string, ownerProfileId?: number): Promise<void> {
  const d = await db();
  const pid = ownerProfileId ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id ?? 1;
  const row = await d.getFirstAsync<{ media_uri: string | null }>(
    'SELECT media_uri FROM stories WHERE id = ? AND owner_profile_id = ?', [storyId, pid]);
  await d.runAsync('DELETE FROM stories WHERE id = ? AND owner_profile_id = ?', [storyId, pid]);
  if (!row) return;
  const dek = await getOrCreateDataEncryptionKey();
  await dropStoryMediaFiles(d, dek, [storyUriCell(row.media_uri, dek)], pid);
}

/* ─── Альбомы историй (v4.32.576) ─────────────────────────────────────────── */

export type StoryAlbumRow = {
  id: string;
  title: string;
  createdAt: number;
  /** Сколько историй в альбоме. */
  count: number;
  /** Имя файла обложки — самой новой истории альбома; `null` — альбом пуст. */
  coverFile: string | null;
  /** Название есть в базе, но ключ его не открывает. */
  titleUnreadable?: boolean;
};

export type StoryAlbumItemRow = {
  id: string;
  albumId: string;
  /** Имя файла копии, а не путь: путь живёт до обновления приложения. */
  mediaFile: string | null;
  /** Общий адрес снимка в IPFS: по нему альбом виден на другом устройстве. */
  mediaCid: string | null;
  mediaType: 'image' | 'video';
  text: string | null;
  /** Когда историю опубликовали. */
  createdAt: number;
  /** Когда её положили в альбом. */
  addedAt: number;
  mediaUnreadable?: boolean;
  textUnreadable?: boolean;
};

export async function insertStoryAlbum(
  row: { id: string; title: string; ownerProfileId: number; createdAt: number }
): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    'INSERT OR IGNORE INTO story_albums (id, owner_profile_id, title, created_at) VALUES (?,?,?,?)',
    [row.id, row.ownerProfileId, encryptAtRestString(row.title, dek), row.createdAt]
  );
}

export async function renameStoryAlbum(id: string, title: string, ownerProfileId: number): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    'UPDATE story_albums SET title = ? WHERE id = ? AND owner_profile_id = ?',
    [encryptAtRestString(title, dek), id, ownerProfileId]
  );
}

/** Альбомы профиля, новые сверху, с числом историй и обложкой. */
export async function listStoryAlbums(ownerProfileId: number): Promise<StoryAlbumRow[]> {
  const d = await db();
  const rows = await d.getAllAsync<{
    id: string; title: string; created_at: number; n: number; cover: string | null;
  }>(
    `SELECT a.id, a.title, a.created_at,
       (SELECT COUNT(*) FROM story_album_items i
         WHERE i.album_id = a.id AND i.owner_profile_id = a.owner_profile_id) AS n,
       (SELECT i.media_file FROM story_album_items i
         WHERE i.album_id = a.id AND i.owner_profile_id = a.owner_profile_id
         ORDER BY i.created_at DESC LIMIT 1) AS cover
     FROM story_albums a WHERE a.owner_profile_id = ? ORDER BY a.created_at DESC`,
    [ownerProfileId]
  );
  const dek = await getOrCreateDataEncryptionKey();
  return rows.map((r) => {
    const titleCell = readAtRestCell(r.title, dek);
    const coverCell = readAtRestCell(r.cover, dek);
    return {
      id: r.id,
      // Непрочитанное название — не пустая строка: пустой заголовок на экране
      // неотличим от альбома, который человек так и не назвал.
      title: cellTextOrNull(titleCell) ?? '',
      createdAt: r.created_at,
      count: r.n,
      coverFile: cellTextOrNull(coverCell),
      titleUnreadable: unreadableFromCellState(titleCell.state),
    };
  });
}

export async function insertStoryAlbumItem(row: {
  id: string;
  albumId: string;
  ownerProfileId: number;
  mediaFile: string | null;
  mediaCid: string | null;
  mediaType: 'image' | 'video';
  text: string | null;
  createdAt: number;
  addedAt: number;
}): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    `INSERT OR IGNORE INTO story_album_items
      (id, album_id, owner_profile_id, media_file, media_cid, media_type, text, created_at, added_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [row.id, row.albumId, row.ownerProfileId, encryptAtRestNullable(row.mediaFile, dek),
     encryptAtRestNullable(row.mediaCid, dek),
     row.mediaType, encryptAtRestNullable(row.text, dek), row.createdAt, row.addedAt]
  );
}

type StoryAlbumItemDbRow = {
  id: string; album_id: string; media_file: string | null; media_cid: string | null;
  media_type: string | null; text: string | null; created_at: number; added_at: number;
};

function mapStoryAlbumItemRows(rows: StoryAlbumItemDbRow[], dek: Uint8Array): StoryAlbumItemRow[] {
  return rows.map((r) => {
    const mediaCell = readAtRestCell(r.media_file, dek);
    const cidCell = readAtRestCell(r.media_cid, dek);
    const textCell = readAtRestCell(r.text, dek);
    return {
      id: r.id,
      albumId: r.album_id,
      mediaFile: cellTextOrNull(mediaCell),
      mediaCid: cellTextOrNull(cidCell),
      mediaType: (r.media_type === 'video' ? 'video' : 'image') as 'image' | 'video',
      text: cellTextOrNull(textCell),
      createdAt: r.created_at,
      addedAt: r.added_at,
      // Непрочитанный CID к «нет снимка» не приравнивается: файл на этом
      // телефоне мог остаться, и плитка обязана его показать.
      mediaUnreadable: unreadableFromCellState(mediaCell.state),
      textUnreadable: unreadableFromCellState(textCell.state),
    };
  });
}

/** Содержимое альбома, новые сверху. */
export async function listStoryAlbumItems(
  albumId: string, ownerProfileId: number
): Promise<StoryAlbumItemRow[]> {
  const d = await db();
  const rows = await d.getAllAsync<StoryAlbumItemDbRow>(
    `SELECT * FROM story_album_items
      WHERE album_id = ? AND owner_profile_id = ? ORDER BY created_at DESC`,
    [albumId, ownerProfileId]
  );
  return mapStoryAlbumItemRows(rows, await getOrCreateDataEncryptionKey());
}

/** Все строки альбомов профиля — для выгрузки в облачную копию. */
export async function listAllStoryAlbumItems(ownerProfileId: number): Promise<StoryAlbumItemRow[]> {
  const d = await db();
  const rows = await d.getAllAsync<StoryAlbumItemDbRow>(
    'SELECT * FROM story_album_items WHERE owner_profile_id = ? ORDER BY created_at DESC',
    [ownerProfileId]
  );
  return mapStoryAlbumItemRows(rows, await getOrCreateDataEncryptionKey());
}

/** Одна строка альбома — нужна, чтобы узнать имя копии перед удалением. */
export async function getStoryAlbumItem(
  id: string, ownerProfileId: number
): Promise<StoryAlbumItemRow | null> {
  const d = await db();
  const row = await d.getFirstAsync<StoryAlbumItemDbRow>(
    'SELECT * FROM story_album_items WHERE id = ? AND owner_profile_id = ?',
    [id, ownerProfileId]
  );
  if (!row) return null;
  return mapStoryAlbumItemRows([row], await getOrCreateDataEncryptionKey())[0];
}

/** Название альбома, пришедшее из облачной копии. */
export async function upsertStoryAlbumFromSync(
  row: { id: string; title: string; ownerProfileId: number; createdAt: number }
): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    `INSERT INTO story_albums (id, owner_profile_id, title, created_at) VALUES (?,?,?,?)
       ON CONFLICT(id, owner_profile_id) DO UPDATE SET title = excluded.title`,
    [row.id, row.ownerProfileId, encryptAtRestString(row.title, dek), row.createdAt]
  );
}

/**
 * Строка альбома, пришедшая из облачной копии.
 *
 * media_file не трогается ни на вставке, ни на обновлении: имя файла — примета
 * ЭТОЙ установки, наверх оно не уезжает и в пришедшей строке его нет. Затереть
 * им своё значение означало бы потерять копию, которая лежит рядом на диске.
 */
export async function upsertStoryAlbumItemFromSync(row: {
  id: string;
  albumId: string;
  ownerProfileId: number;
  mediaCid: string | null;
  mediaType: 'image' | 'video';
  text: string | null;
  createdAt: number;
  addedAt: number;
}): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    `INSERT INTO story_album_items
      (id, album_id, owner_profile_id, media_file, media_cid, media_type, text, created_at, added_at)
     VALUES (?,?,?,NULL,?,?,?,?,?)
     ON CONFLICT(id, owner_profile_id) DO UPDATE SET
       album_id = excluded.album_id,
       media_cid = excluded.media_cid,
       media_type = excluded.media_type,
       text = excluded.text,
       added_at = excluded.added_at`,
    [row.id, row.albumId, row.ownerProfileId, encryptAtRestNullable(row.mediaCid, dek),
     row.mediaType, encryptAtRestNullable(row.text, dek), row.createdAt, row.addedAt]
  );
}

/**
 * Лежит ли уже такая строка в альбоме.
 *
 * Идентификатор строки складывается из альбома и истории, поэтому повторное
 * нажатие «в альбом» на той же плитке видно ДО копирования файла: без этой
 * проверки INSERT OR IGNORE тихо промолчал бы, а копия осталась бы на диске
 * без строки — то есть навсегда.
 */
export async function storyAlbumItemExists(id: string, ownerProfileId: number): Promise<boolean> {
  const d = await db();
  const r = await d.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM story_album_items WHERE id = ? AND owner_profile_id = ?',
    [id, ownerProfileId]
  );
  return (r?.n ?? 0) > 0;
}

/**
 * Запомнить имя копии, скачанной по общему адресу.
 *
 * Строка альбома приезжает с другого устройства без имени файла — там его и не
 * может быть. Скачав снимок один раз, устройство кладёт его к себе насовсем:
 * иначе плитка зависела бы от того, жив ли ещё общий адрес, а альбом — это
 * ровно обещание «останется».
 */
export async function setStoryAlbumItemMediaFile(
  id: string, ownerProfileId: number, name: string
): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    'UPDATE story_album_items SET media_file = ? WHERE id = ? AND owner_profile_id = ?',
    [encryptAtRestString(name, dek), id, ownerProfileId]
  );
}

export async function deleteStoryAlbumItem(id: string, ownerProfileId: number): Promise<void> {
  const d = await db();
  await d.runAsync(
    'DELETE FROM story_album_items WHERE id = ? AND owner_profile_id = ?', [id, ownerProfileId]);
}

export async function deleteStoryAlbum(id: string, ownerProfileId: number): Promise<void> {
  const d = await db();
  await d.runAsync(
    'DELETE FROM story_album_items WHERE album_id = ? AND owner_profile_id = ?', [id, ownerProfileId]);
  await d.runAsync(
    'DELETE FROM story_albums WHERE id = ? AND owner_profile_id = ?', [id, ownerProfileId]);
}

/**
 * Имена файлов всех альбомов — по всем профилям сразу: файлы лежат в общем
 * каталоге, и «оставить» решается по всей базе, а не по одному аккаунту.
 *
 * `complete` — вышло ли прочитать ВСЕ адреса. Непрочитанная строка означает
 * файл, который в списке не назван, а на диске лежит: уборка по такому списку
 * снесла бы историю, оставленную человеком навсегда. Отсюда признак: sweep
 * зовут только при `complete`.
 */
export async function storyAlbumFileNames(): Promise<{ names: string[]; complete: boolean }> {
  const d = await db();
  const rows = await d.getAllAsync<{ media_file: string | null }>(
    'SELECT media_file FROM story_album_items');
  const dek = await getOrCreateDataEncryptionKey();
  const names: string[] = [];
  let complete = true;
  for (const r of rows) {
    const cell = readAtRestCell(r.media_file, dek);
    const name = cellTextOrNull(cell);
    if (name) names.push(name);
    else if (cell.state !== 'plain') complete = false;
  }
  return { names, complete };
}

export { STORY_TTL_MS };

// ─── Global Message Search ────────────────────────────────────────────────────

export type MessageSearchResult = {
  message: ChatMessageRow;
  contactPubB64: string;
};

/**
 * Full-text search across all chat messages for the current profile.
 * Returns up to `limit` most-recent results.
 */
export async function searchMessages(
  query: string,
  ownerProfileId: number,
  limit = 50
): Promise<SearchOutcome<MessageSearchResult>> {
  if (!query.trim()) return { items: [], scan: emptySearchScan() };
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    // NOTE: chat_messages.text is ciphertext. SQL LIKE on it never matches, so
    // we fetch recent candidates by created_at and filter in JS after decrypt.
    const candidateLimit = Math.max(limit * 20, 200);
    if (candidateLimit > 2000) {
      log.warn('search_messages_wide_scan', { candidateLimit });
    }
    const rows = await d.getAllAsync<{
      id: string; contact_pub_b64: string; cid: string | null;
      text: string; direction: string; status: string;
      media_cids: string | null; created_at: number;
      owner_profile_id: number; reply_to_id: string | null;
      reply_to_preview: string | null; edited_at: number | null;
      reactions: string | null;
    }>(
      `SELECT * FROM chat_messages
       WHERE owner_profile_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [ownerProfileId, candidateLimit]
    );
    // trim здесь, а не у вызывающего: глобальный поиск передавал строку как
    // есть, и один лишний пробел давал пустую выдачу при живых совпадениях.
    const needle = query.trim().toLowerCase();
    const out: MessageSearchResult[] = [];
    const scan = emptySearchScan();
    for (const r of rows) {
      // v4.32.581: раньше здесь стоял decryptAtRestString, и строка, которую
      // ключ данных не открыл, превращалась в пустую — она не совпадала ни с
      // чем и молча выпадала из выдачи, а человеку показывали «ничего не
      // найдено». Теперь такие строки считаются отдельно (см. searchScan).
      const cell = readAtRestCell(r.text, dek);
      noteSearchedRow(scan, cell.state !== 'unreadable');
      if (cell.state === 'unreadable') continue;
      const plain = cellTextOrNull(cell) ?? '';
      // v4.32.239: сравнение с видимым текстом, а не с сырым конвертом — иначе
      // «cid», «lat», «http» находили каждое вложение (см. searchableText.ts).
      if (!matchesSearch(plain, needle)) continue;
      out.push({
        contactPubB64: r.contact_pub_b64,
        message: {
          id: r.id,
          contactPubB64: r.contact_pub_b64,
          cid: r.cid,
          text: plain,
          direction: r.direction as 'in' | 'out',
          status: r.status,
          ...readMediaCell(r.media_cids, dek),
          createdAt: r.created_at,
          ownerProfileId: r.owner_profile_id,
          replyToId: r.reply_to_id,
          ...readReplyCell(r.reply_to_preview, dek),
          editedAt: r.edited_at,
          ...readReactionsCell(r.reactions, dek),
        },
      });
      if (out.length >= limit) break;
    }
    return { items: out, scan };
  } catch (e) {
    log.warn('search_messages_failed', { err: e instanceof Error ? e.message : String(e) });
    return { items: [], scan: emptySearchScan() };
  }
}

/**
 * Поиск внутри одной личной переписки.
 *
 * v4.32.239. До этого экран чата фильтровал только уже загруженную страницу
 * (PAGE = 40 сообщений), поэтому поиск слова из переписки месячной давности
 * молча показывал «0/0» — притом что в группах точно такой же поиск ходит в
 * базу (searchGroupMessages) и находит всё. Функция — зеркало групповой.
 */
export async function searchChatMessages(
  contactPubB64: string,
  query: string,
  ownerProfileId: number,
  limit = 50
): Promise<SearchOutcome<ChatMessageRow>> {
  if (!query.trim()) return { items: [], scan: emptySearchScan() };
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    // text — шифротекст, SQL LIKE по нему не сработает: берём кандидатов по
    // свежести и отсеиваем в JS после расшифровки (как в searchGroupMessages).
    const candidateLimit = Math.max(limit * 20, 200);
    if (candidateLimit > 2000) {
      log.warn('search_chat_messages_wide_scan', { candidateLimit });
    }
    const rows = await d.getAllAsync<{
      id: string; contact_pub_b64: string; cid: string | null;
      text: string; direction: string; status: string;
      media_cids: string | null; created_at: number;
      owner_profile_id: number; reply_to_id: string | null;
      reply_to_preview: string | null; edited_at: number | null;
      reactions: string | null;
    }>(
      `SELECT * FROM chat_messages
       WHERE contact_pub_b64 = ? AND owner_profile_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [contactPubB64, ownerProfileId, candidateLimit]
    );
    const needle = query.trim().toLowerCase();
    const out: ChatMessageRow[] = [];
    const scan = emptySearchScan();
    for (const r of rows) {
      // v4.32.581: раньше здесь стоял decryptAtRestString, и строка, которую
      // ключ данных не открыл, превращалась в пустую — она не совпадала ни с
      // чем и молча выпадала из выдачи, а человеку показывали «ничего не
      // найдено». Теперь такие строки считаются отдельно (см. searchScan).
      const cell = readAtRestCell(r.text, dek);
      noteSearchedRow(scan, cell.state !== 'unreadable');
      if (cell.state === 'unreadable') continue;
      const plain = cellTextOrNull(cell) ?? '';
      if (!matchesSearch(plain, needle)) continue;
      out.push({
        id: r.id,
        contactPubB64: r.contact_pub_b64,
        cid: r.cid,
        text: plain,
        direction: r.direction as 'in' | 'out',
        status: r.status,
        ...readMediaCell(r.media_cids, dek),
        createdAt: r.created_at,
        ownerProfileId: r.owner_profile_id,
        replyToId: r.reply_to_id,
        ...readReplyCell(r.reply_to_preview, dek),
        editedAt: r.edited_at,
        ...readReactionsCell(r.reactions, dek),
      });
      if (out.length >= limit) break;
    }
    return { items: out, scan };
  } catch (e) {
    log.warn('search_chat_messages_failed', { err: e instanceof Error ? e.message : String(e) });
    return { items: [], scan: emptySearchScan() };
  }
}

/**
 * Строка общей галереи вложений.
 *
 * v4.32.584: непрочитанная строка отсюда больше не исчезает — она несёт
 * признак рядом с пустыми CID'ами, чтобы окно не выдавало «медиа нет» за
 * «медиа не прочитать». См. core/media/sharedMediaScan.
 */
export type SharedMediaRow = {
  id: string;
  mediaCids: string;
  createdAt: number;
  unreadable?: boolean;
};

/** Returns all messages that have at least one media CID for a given conversation. */
export async function listConversationMedia(
  contactPubB64: string,
  ownerProfileId: number,
  limit = 200
): Promise<SharedMediaRow[]> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{ id: string; media_cids: string; created_at: number }>(
      `SELECT id, media_cids, created_at FROM chat_messages
       WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND media_cids IS NOT NULL AND media_cids != ''
       ORDER BY created_at DESC LIMIT ?`,
      [contactPubB64, ownerProfileId, limit]
    );
    // v4.32.279: расшифровать. Раньше сюда возвращался шифртекст, и общая
    // галерея вложений переписки не показывала ничего — CID'ы не разбирались.
    // Пустые отсеиваются уже после расшифровки: условие `media_cids != ''` в
    // запросе смотрит на шифртекст и поэтому не отсеивает ничего.
    // v4.32.584: строка, которую не открыл ключ, остаётся в списке с
    // признаком. Отсеивается только честно пустая — такая в галерее и
    // правда ничего не значит.
    const dek = await getOrCreateDataEncryptionKey();
    return rows
      .map((r) => {
        const cell = readAtRestCell(r.media_cids, dek);
        return {
          id: r.id,
          mediaCids: cellTextOrNull(cell) ?? '',
          createdAt: r.created_at,
          unreadable: unreadableFromCellState(cell.state),
        };
      })
      .filter((r) => r.unreadable === true || r.mediaCids !== '');
  } catch (e) {
    log.warn('list_conversation_media_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * Медиа группы либо `null` — прочитать не удалось (v4.32.532).
 *
 * Окно общих медиа читает две выборки; если сбой одной из них выглядит как
 * «медиа нет», человек решает, что вложения из группы пропали.
 */
export async function listGroupConversationMedia(
  groupId: string,
  ownerProfileId: number,
  limit = 200
): Promise<DbRead<SharedMediaRow>> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{ id: string; media_cids: string; created_at: number }>(
      `SELECT id, media_cids, created_at FROM group_messages
       WHERE group_id = ? AND owner_profile_id = ? AND media_cids IS NOT NULL AND media_cids != ''
       ORDER BY created_at DESC LIMIT ?`,
      [groupId, ownerProfileId, limit]
    );
    // v4.32.279: то же, что в listConversationMedia — расшифровать и отсеять
    // пустые уже после, потому что SQL видит только шифртекст.
    // v4.32.584: и так же непрочитанные остаются с признаком.
    const dek = await getOrCreateDataEncryptionKey();
    return rows
      .map((r) => {
        const cell = readAtRestCell(r.media_cids, dek);
        return {
          id: r.id,
          mediaCids: cellTextOrNull(cell) ?? '',
          createdAt: r.created_at,
          unreadable: unreadableFromCellState(cell.state),
        };
      })
      .filter((r) => r.unreadable === true || r.mediaCids !== '');
  } catch (e) {
    log.warn('list_group_conversation_media_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

// ─── Scheduled Messages ───────────────────────────────────────────────────────

export type ScheduledMessage = {
  id: string;
  contactPubB64: string;
  text: string;
  mediaCids: string | null;
  sendAt: number;
  ownerProfileId: number;
  createdAt: number;
  /** Set when this is a group scheduled message (null for DMs). */
  groupId?: string | null;
  /** Sender display name for group scheduled messages. */
  senderName?: string | null;
  /**
   * Столбец с именем отправителя не открылся ключом данных (v4.32.596).
   *
   * Как и readState — только на чтении. Разница между «имени не было» и
   * «имя не прочиталось» здесь решает, чем подписать уходящее сообщение.
   */
  senderNameUnreadable?: boolean;
  /**
   * v4.32.565: прочитались ли зашифрованные столбцы строки. Заполняется только
   * при чтении: пишущим (insertScheduledMessage) поле не нужно — они кладут в
   * базу то, что им дали открытым текстом.
   */
  readState?: ScheduledReadState;
};

/**
 * v4.32.283: отложенное сообщение — это уже написанный текст, который просто
 * ждёт своего часа. Отправленное шифруется, а лежащее в очереди лежало
 * открыто, и тем дольше, чем дальше отложено. `media_cids` тем более: в
 * `nb:`-псевдо-CID зашит ключ расшифровки вложения (см. blobRef.ts).
 */
export async function insertScheduledMessage(row: ScheduledMessage): Promise<void> {
  const d = await db();
  const dek = await getOrCreateDataEncryptionKey();
  await d.runAsync(
    `INSERT OR REPLACE INTO scheduled_messages
      (id, contact_pub_b64, text, media_cids, send_at, owner_profile_id, created_at, group_id, sender_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.contactPubB64, encryptAtRestString(row.text, dek), encryptAtRestNullable(row.mediaCids, dek),
     row.sendAt, row.ownerProfileId, row.createdAt,
     // v4.32.304: имя отправителя — та же строка, что sender_name в сообщении
     // группы (шифруется с v4.32.285) и display_name участника (с v4.32.298).
     row.groupId ?? null, encryptAtRestNullable(row.senderName ?? null, dek)]
  );
}

function rowToScheduled(r: {
  id: string; contact_pub_b64: string; text: string; media_cids: string | null;
  send_at: number; owner_profile_id: number; created_at: number;
  group_id?: string | null; sender_name?: string | null;
}, dek: Uint8Array): ScheduledMessage {
  // v4.32.565: читаем состоянием, а не строкой. `decryptAtRestString` отдаёт
  // на неудаче пустую строку, и планировщик отправлял её как настоящий текст:
  // пустой пузырь собеседнику или всей группе, после чего строка расписания
  // удалялась как успешная — вместе с последней копией написанного.
  const textCell = readAtRestCell(r.text ?? null, dek);
  const mediaCell = readAtRestCell(r.media_cids ?? null, dek);
  const senderCell = readNameCell(r.sender_name ?? null, dek);
  return {
    id: r.id,
    contactPubB64: r.contact_pub_b64,
    text: textCell.state === 'plain' ? textCell.text : '',
    mediaCids: mediaCell.state === 'plain' ? mediaCell.text : null,
    readState: scheduledReadState({ text: textCell.state, media: mediaCell.state }),
    sendAt: r.send_at,
    ownerProfileId: r.owner_profile_id,
    createdAt: r.created_at,
    groupId: r.group_id ?? null,
    // Строка без префикса enc2: — ещё не переведённая; readAtRestCell
    // возвращает её как есть (см. ensureScheduledSenderNameEncrypted).
    // v4.32.596: состоянием, а не строкой — иначе непрочитанное имя приходило
    // сюда тем же null, что и «имени не было», и подпись уходила как «?».
    senderName: senderCell.name,
    senderNameUnreadable: senderCell.unreadable,
  };
}

export async function listDueScheduledMessages(ownerProfileId: number): Promise<ScheduledMessage[]> {
  const d = await db();
  const rows = await d.getAllAsync<{
    id: string; contact_pub_b64: string; text: string; media_cids: string | null;
    send_at: number; owner_profile_id: number; created_at: number;
    group_id: string | null; sender_name: string | null;
  }>(
    'SELECT * FROM scheduled_messages WHERE owner_profile_id = ? AND send_at <= ? ORDER BY send_at ASC',
    [ownerProfileId, Date.now()]
  );
  const dek = await getOrCreateDataEncryptionKey();
  return rows.map((r) => rowToScheduled(r, dek));
}

export async function listAllScheduledMessages(ownerProfileId: number): Promise<ScheduledMessage[]> {
  const d = await db();
  const rows = await d.getAllAsync<{
    id: string; contact_pub_b64: string; text: string; media_cids: string | null;
    send_at: number; owner_profile_id: number; created_at: number;
    group_id: string | null; sender_name: string | null;
  }>(
    'SELECT * FROM scheduled_messages WHERE owner_profile_id = ? ORDER BY send_at ASC',
    [ownerProfileId]
  );
  const dek = await getOrCreateDataEncryptionKey();
  return rows.map((r) => rowToScheduled(r, dek));
}

export async function listGroupScheduledMessages(groupId: string, ownerProfileId: number): Promise<ScheduledMessage[]> {
  const d = await db();
  const rows = await d.getAllAsync<{
    id: string; contact_pub_b64: string; text: string; media_cids: string | null;
    send_at: number; owner_profile_id: number; created_at: number;
    group_id: string | null; sender_name: string | null;
  }>(
    'SELECT * FROM scheduled_messages WHERE group_id = ? AND owner_profile_id = ? ORDER BY send_at ASC',
    [groupId, ownerProfileId]
  );
  const dek = await getOrCreateDataEncryptionKey();
  return rows.map((r) => rowToScheduled(r, dek));
}

export async function deleteScheduledMessage(id: string, ownerProfileId?: number): Promise<void> {
  const d = await db();
  const pid = ownerProfileId ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id ?? 1;
  await d.runAsync('DELETE FROM scheduled_messages WHERE id = ? AND owner_profile_id = ?', [id, pid]);
}

// ─── Starred messages ─────────────────────────────────────────────────────────

export async function setMessageStarred(id: string, starred: boolean, ownerProfileId?: number): Promise<void> {
  const d = await db();
  const pid = ownerProfileId ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id ?? 1;
  await d.runAsync('UPDATE chat_messages SET starred = ? WHERE id = ? AND owner_profile_id = ?', [starred ? 1 : 0, id, pid]);
  notifyChatStorageChanged();
}

export async function setGroupMessageStarred(id: string, starred: boolean, ownerProfileId?: number): Promise<void> {
  const d = await db();
  const pid = ownerProfileId ?? (await import('../identity/profileManager')).profileManager.getActiveProfile()?.id ?? 1;
  await d.runAsync('UPDATE group_messages SET starred = ? WHERE id = ? AND owner_profile_id = ?', [starred ? 1 : 0, id, pid]);
  notifyChatStorageChanged();
}

export type StarredMessageEntry = {
  kind: 'chat' | 'group';
  message: ChatMessageRow | GroupMessageRow;
  /** For chat messages: display name of the contact. For group messages: group name. */
  contextName: string;
  contextId: string;
};

export async function listStarredMessages(ownerProfileId: number): Promise<StarredMessageEntry[]> {
  try {
    const d = await db();
    const chatRows = await d.getAllAsync<{
      id: string; contact_pub_b64: string; cid: string | null;
      text: string; direction: string; status: string;
      media_cids: string | null; created_at: number; owner_profile_id: number;
      reply_to_id: string | null; reply_to_preview: string | null;
      edited_at: number | null; reactions: string | null;
    }>(
      'SELECT * FROM chat_messages WHERE owner_profile_id = ? AND starred = 1 ORDER BY created_at DESC',
      [ownerProfileId]
    );
    const grpRows = await d.getAllAsync<{
      id: string; group_id: string; sender_pub_b64: string; sender_name: string | null;
      text: string; media_cids: string | null; reply_to_id: string | null;
      reply_to_preview: string | null; reactions: string | null;
      created_at: number; owner_profile_id: number; edited_at: number | null;
    }>(
      'SELECT * FROM group_messages WHERE owner_profile_id = ? AND starred = 1 ORDER BY created_at DESC',
      [ownerProfileId]
    );
    const groups = await d.getAllAsync<{ id: string; name: string }>(
      'SELECT id, name FROM groups WHERE owner_profile_id = ?',
      [ownerProfileId]
    );
    const dek = await getOrCreateDataEncryptionKey();
    // v4.32.578: имя группы, которое не открылось ключом данных, раньше
    // ложилось в карту пустой строкой — и заголовок избранного оставался
    // пустым, потому что `?? id` пустую строку не заменяет. В карту попадают
    // только прочитанные имена; остальные честно уходят на короткий id.
    const groupNames = new Map<string, string>();
    for (const g of groups) {
      const name = cellTextOrNull(readAtRestCell(g.name, dek));
      if (name) groupNames.set(g.id, name);
    }
    const result: StarredMessageEntry[] = [];
    for (const r of chatRows) {
      // v4.32.578: непрочитанный текст здесь — не пустое сообщение. Избранное
      // показывало его пустой строкой, неотличимо от подписи, которую не
      // написали (см. unreadableText).
      const cell = readAtRestCell(r.text, dek);
      result.push({
        kind: 'chat',
        message: {
          id: r.id, contactPubB64: r.contact_pub_b64, cid: r.cid,
          text: cellTextOrNull(cell) ?? '',
          unreadable: unreadableFromCellState(cell.state),
          direction: r.direction as 'in' | 'out', status: r.status,
          ...readMediaCell(r.media_cids, dek), createdAt: r.created_at, ownerProfileId: r.owner_profile_id,
          replyToId: r.reply_to_id, ...readReplyCell(r.reply_to_preview, dek),
          editedAt: r.edited_at, ...readReactionsCell(r.reactions, dek),
          starred: true,
        } as ChatMessageRow,
        contextName: r.contact_pub_b64.slice(0, 8) + '…',
        contextId: r.contact_pub_b64,
      });
    }
    for (const r of grpRows) {
      const cell = readAtRestCell(r.text, dek);
      const sender = readNameCell(r.sender_name, dek);
      result.push({
        kind: 'group',
        message: {
          id: r.id, groupId: r.group_id, senderPubB64: r.sender_pub_b64,
          senderName: sender.name,
          senderUnreadable: sender.unreadable,
          text: cellTextOrNull(cell) ?? '',
          unreadable: unreadableFromCellState(cell.state),
          ...readMediaCell(r.media_cids, dek), replyToId: r.reply_to_id, ...readReplyCell(r.reply_to_preview, dek),
          ...readReactionsCell(r.reactions, dek), createdAt: r.created_at, ownerProfileId: r.owner_profile_id,
          editedAt: r.edited_at, starred: true,
        } as GroupMessageRow,
        contextName: groupNames.get(r.group_id) ?? r.group_id.slice(0, 8),
        contextId: r.group_id,
      });
    }
    result.sort((a, b) => (b.message.createdAt) - (a.message.createdAt));
    return result;
  } catch (e) {
    log.warn('list_starred_messages_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * Delete all chat messages and group messages for the given profile.
 * Groups, conversations and contacts are preserved; only message history is removed.
 *
 * v4.32.253: первым запросом стояло `DELETE FROM messages` — таблицы с таким
 * именем в схеме нет и никогда не было (переписка живёт в chat_messages).
 * SQLite бросал «no such table», ошибку глотал catch ниже, и «Очистить историю
 * сообщений» в настройках не удаляла НИЧЕГО: ни личных сообщений, ни групповых
 * (до них выполнение не доходило), ни счётчиков непрочитанного — а экран при
 * этом рапортовал «История очищена».
 *
 * Возвращает признак успеха, чтобы вызывающий не показывал успех после отказа.
 */
export async function clearAllMessageHistory(ownerProfileId: number): Promise<boolean> {
  try {
    const d = await db();
    // Голоса в опросах и отметки о завершении — до удаления самих сообщений,
    // пока по ним ещё можно выбрать id (см. deletePollArtifactsBySelect).
    // v4.32.272: вложения — до удаления строк. «Очистить историю сообщений»
    // чистит один профиль, а кэш расшифрованных файлов общий на приложение,
    // поэтому уцелевшие профили проверяются в dropOrphanBlobCache.
    const dek = await getOrCreateDataEncryptionKey();
    const doomed = newAttachmentRefs();
    await collectAttachmentRefs(d, dek, 'SELECT text, media_cids FROM chat_messages WHERE owner_profile_id = ?', [ownerProfileId], doomed);
    await collectAttachmentRefs(d, dek, 'SELECT text, media_cids FROM group_messages WHERE owner_profile_id = ?', [ownerProfileId], doomed);
    await eraseAtomically(
      d,
      'clear_all_message_history',
      async () => {
        // Голоса в опросах и отметки о завершении — до удаления самих сообщений,
        // пока по ним ещё можно выбрать id (см. deletePollArtifactsBySelect).
        await deletePollArtifactsBySelect(d, 'SELECT id FROM chat_messages WHERE owner_profile_id = ?', [ownerProfileId], ownerProfileId);
        await deletePollArtifactsBySelect(d, 'SELECT id FROM group_messages WHERE owner_profile_id = ?', [ownerProfileId], ownerProfileId);
        await d.runAsync('DELETE FROM chat_messages WHERE owner_profile_id = ?', [ownerProfileId]);
        await d.runAsync('DELETE FROM group_messages WHERE owner_profile_id = ?', [ownerProfileId]);
        // v4.32.276: и корзины «недавно удалённые» — все сразу. Префикс общий и для
        // личных переписок, и для групп (recently_deleted_grp_), это намеренно:
        // «удалить всю историю» не должно оставлять список её кусков.
        // v4.32.278: только свой профиль — до этой версии сюда попадали и корзины
        // соседнего аккаунта, хотя сообщения удалялись строго по owner_profile_id.
        // Префикс берётся у самого построителя ключа, чтобы литерал не разъехался.
        const binPrefix = recentlyDeletedKey('');
        await kvDeleteByPrefix(profileScopedKey(ownerProfileId, binPrefix));
        // И глобальные записи, оставшиеся до v4.32.278: иначе kvGetSecretScoped
        // поднимет их как «свои» при первом же открытии переписки.
        await kvDeleteByPrefix(binPrefix);
        // v4.32.296: действие сильнее двух других очисток, а стирало меньше — ни
        // направления последнего сообщения, ни черновиков, ни закреплений, ни имён
        // отправителей в группах оно не трогало. Перечень следов теперь один
        // (purgeResidue), и здесь он применяется ко всем строкам профиля.
        await d.runAsync(clearTracesSql('conversations', 'profile'), [ownerProfileId]);
        await d.runAsync(clearTracesSql('groups', 'profile'), [ownerProfileId]);
      },
      () => dropOrphanBlobCache(doomed)
    );
    emitChatWrites();
    return true;
  } catch (e) {
    log.warn('clear_all_message_history_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

// ─── Quick Replies ────────────────────────────────────────────────────────────

export type QuickReply = {
  id: string;
  text: string;
  /**
   * v4.32.582: столбец с текстом не открылся ключом данных. Без этого признака
   * шаблон приходил к показу пустой строкой — неотличимо от пустого шаблона,
   * а нажатие на него вставляло в поле ввода пустоту.
   */
  unreadable?: boolean;
  ownerProfileId: number;
  createdAt: number;
};

export async function listQuickReplies(ownerProfileId: number): Promise<QuickReply[]> {
  try {
    const d = await db();
    const rows = await d.getAllAsync<{ id: string; text: string; owner_profile_id: number; created_at: number }>(
      'SELECT * FROM quick_replies WHERE owner_profile_id = ? ORDER BY created_at ASC',
      [ownerProfileId]
    );
    const dek = await getOrCreateDataEncryptionKey();
    return rows.map((r) => {
      // v4.32.582: трёхзначное чтение вместо decryptAtRestString — пустая
      // строка от неудачи неотличима от пустого шаблона (см. templateSearch).
      const cell = readAtRestCell(r.text, dek);
      return {
        id: r.id,
        text: cellTextOrNull(cell) ?? '',
        unreadable: unreadableFromCellState(cell.state),
        ownerProfileId: r.owner_profile_id,
        createdAt: r.created_at,
      };
    });
  } catch (e) {
    log.warn('list_quick_replies_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

export async function addQuickReply(ownerProfileId: number, text: string): Promise<void> {
  try {
    const { v4: uuidv4 } = await import('uuid');
    const id = uuidv4();
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync(
      'INSERT INTO quick_replies (id, text, owner_profile_id, created_at) VALUES (?, ?, ?, ?)',
      [id, encryptAtRestString(text.trim(), dek), ownerProfileId, Date.now()]
    );
  } catch (e) {
    log.warn('add_quick_reply_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function updateQuickReply(id: string, text: string): Promise<void> {
  try {
    const d = await db();
    const dek = await getOrCreateDataEncryptionKey();
    await d.runAsync('UPDATE quick_replies SET text = ? WHERE id = ?', [encryptAtRestString(text.trim(), dek), id]);
  } catch (e) {
    log.warn('update_quick_reply_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function deleteQuickReply(id: string): Promise<void> {
  try {
    const d = await db();
    await d.runAsync('DELETE FROM quick_replies WHERE id = ?', [id]);
  } catch (e) {
    log.warn('delete_quick_reply_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

// ─── Group join requests ──────────────────────────────────────────────────────

export type GroupJoinRequest = {
  id: string;
  groupId: string;
  requesterPubB64: string;
  requesterName: string | null;
  message: string | null;
  /**
   * Столбцы заявки не открылись ключом данных (v4.32.594).
   *
   * Заявку на вступление владелец либо принимает, либо отклоняет, глядя ровно
   * на две вещи: как человек себя назвал и что написал. Пока имя молча
   * подменялось коротким ключом, а непрочитанное сообщение просто не
   * рисовалось, решение принималось по неполной картинке — и владелец об этом
   * не знал.
   */
  requesterNameUnreadable?: boolean;
  messageUnreadable?: boolean;
  status: 'pending' | 'approved' | 'rejected';
  ownerProfileId: number;
  createdAt: number;
};

export async function insertGroupJoinRequest(
  groupId: string,
  requesterPubB64: string,
  requesterName: string | null,
  message: string | null,
  ownerProfileId: number
): Promise<{ id: string; created: boolean }> {
  const d = await db();
  // v4.32.283: сопроводительный текст заявки пишет посторонний человек, ещё не
  // состоящий в группе, а имя он указывает сам. И то и другое лежало открыто —
  // причём у всех администраторов сразу.
  const dek = await getOrCreateDataEncryptionKey();
  const nameEnc = encryptAtRestNullable(requesterName, dek);
  const messageEnc = encryptAtRestNullable(message, dek);
  // v4.32.259: заявка одна на человека. `INSERT OR IGNORE` защищал только от
  // повторного id, а id тут каждый раз новый, — поэтому каждое повторное
  // открытие ссылки-приглашения дописывало администратору ещё одну строку в
  // список заявок, и так сколько угодно раз. UNIQUE-индекс не навесить: на
  // уже живых устройствах дубликаты успели накопиться, и CREATE UNIQUE INDEX
  // упал бы при миграции. Поэтому проверяем перед вставкой.
  const existing = await d.getFirstAsync<{ id: string }>(
    `SELECT id FROM group_join_requests
      WHERE group_id = ? AND requester_pub_b64 = ? AND owner_profile_id = ? AND status = 'pending'`,
    [groupId, requesterPubB64, ownerProfileId]
  );
  if (existing) {
    // Имя и сопроводительный текст берём из свежей заявки: человек мог
    // переименоваться, пока администратор не отвечал.
    await d.runAsync(
      'UPDATE group_join_requests SET requester_name = ?, message = ?, created_at = ? WHERE id = ?',
      [nameEnc, messageEnc, Date.now(), existing.id]
    );
    // created:false — вызывающий по нему решает, слать ли заявителю ответ:
    // повторное открытие ссылки не должно дописывать ему ещё одну строку
    // «заявка ждёт одобрения» (v4.32.266).
    return { id: existing.id, created: false };
  }
  const { v4: uuidv4 } = await import('uuid');
  const id = uuidv4();
  await d.runAsync(
    `INSERT OR IGNORE INTO group_join_requests (id, group_id, requester_pub_b64, requester_name, message, status, owner_profile_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, groupId, requesterPubB64, nameEnc, messageEnc, ownerProfileId, Date.now()]
  );
  return { id, created: true };
}

export async function listGroupJoinRequests(
  groupId: string,
  ownerProfileId: number,
  status: 'pending' | 'approved' | 'rejected' = 'pending'
): Promise<GroupJoinRequest[]> {
  const d = await db();
  const rows = await d.getAllAsync<{
    id: string; group_id: string; requester_pub_b64: string; requester_name: string | null;
    message: string | null; status: string; owner_profile_id: number; created_at: number;
  }>(
    'SELECT * FROM group_join_requests WHERE group_id = ? AND owner_profile_id = ? AND status = ? ORDER BY created_at DESC',
    [groupId, ownerProfileId, status]
  );
  const dek = await getOrCreateDataEncryptionKey();
  return rows.map((r) => {
    const requester = readNameCell(r.requester_name, dek);
    const messageCell = readAtRestCell(r.message, dek);
    return {
      id: r.id, groupId: r.group_id, requesterPubB64: r.requester_pub_b64,
      requesterName: requester.name,
      requesterNameUnreadable: requester.unreadable,
      message: cellTextOrNull(messageCell),
      messageUnreadable: unreadableFromCellState(messageCell.state),
      status: r.status as GroupJoinRequest['status'],
      ownerProfileId: r.owner_profile_id, createdAt: r.created_at,
    };
  });
}

export async function countPendingJoinRequests(groupId: string, ownerProfileId: number): Promise<number> {
  const d = await db();
  const row = await d.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM group_join_requests WHERE group_id = ? AND owner_profile_id = ? AND status = ?',
    [groupId, ownerProfileId, 'pending']
  );
  return row?.cnt ?? 0;
}

export async function updateGroupJoinRequestStatus(
  requestId: string,
  status: 'approved' | 'rejected'
): Promise<number> {
  const d = await db();
  // v4.32.175: conditional UPDATE — если два админа approve одновременно,
  // только первый пройдёт (status='pending' → 'approved'), второй увидит
  // changes=0 и не запустит повторный upsertGroupMember / systemMessage.
  const res = await d.runAsync(
    'UPDATE group_join_requests SET status = ? WHERE id = ? AND status = ?',
    [status, requestId, 'pending']
  );
  return res.changes ?? 0;
}
