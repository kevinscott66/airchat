/**
 * Локальная резервная копия диалогов (шифротекст SQLite + KV контактов) в файле приложения.
 * После импорта той же seed DEK совпадает — сообщения снова читаются.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { InteractionManager } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveKeyPairFromMnemonicForProfile, getStoredMnemonic } from '../backup/seedPhrase';
import { profileManager } from '../identity/profileManager';
import { log } from '../logger';
import {
  countChatMessages,
  exportConversationMetaRows,
  exportDialogKvSnapshot,
  exportGroupBackupRows,
  exportRawChatMessageRows,
  importConversationMetaRows,
  importDialogKvSnapshot,
  importGroupBackupRows,
  importRawChatMessageRows,
  rebuildConversationsFromMessages,
} from './local';
import {
  CONVERSATION_META_MAX_ROWS,
  type ConversationMetaRow,
} from './conversationMeta';
import { RAW_CHAT_MESSAGE_MAX_ROWS } from './chatMessageBackup';
import {
  GROUP_MAX_ROWS,
  GROUP_MEMBER_MAX_ROWS,
  GROUP_MESSAGE_MAX_ROWS,
  type GroupBackupRow,
  type GroupMemberBackupRow,
  type GroupMessageBackupRow,
} from './groupBackup';

/**
 * v4.32.280: у каждого профиля своя копия. Файл был один на устройство, а
 * экспорт срабатывает по записи в чат — то есть у того профиля, который сейчас
 * активен. Переключение аккаунта затирало копию предыдущего его содержимым,
 * и после переустановки восстанавливать первому аккаунту было уже нечего.
 */
const BACKUP_FILENAME_LEGACY = 'airchat_dialogs_backup_v1.json';

function backupFilename(profileId: number): string {
  return `airchat_dialogs_backup_v1_p${profileId}.json`;
}

export type DialogBackupFileV1 = {
  v: 1;
  walletPubKeyB64: string;
  exportedAt: number;
  messages: Array<{
    id: string;
    contact_pub_b64: string;
    cid: string | null;
    text: string;
    direction: string;
    status: string;
    media_cids: string | null;
    created_at: number;
    owner_profile_id: number;
  }>;
  kv: Array<{ k: string; v: string }>;
  /**
   * v4.32.295: настройки переписок — метка, закрепление, архив, тишина,
   * черновик, таймер самоуничтожения. Поле необязательное: копия, снятая до
   * этой версии, его не содержит, и восстановление из неё должно продолжать
   * работать. Номер версии файла не менялся именно поэтому.
   */
  conversations?: ConversationMetaRow[];
  /**
   * v4.32.297: группы и каналы — сама группа, её сообщения и состав. Тоже
   * необязательные: копия, снятая до этой версии, их не содержит, и
   * восстановление из неё должно продолжать работать.
   */
  groups?: GroupBackupRow[];
  groupMessages?: GroupMessageBackupRow[];
  groupMembers?: GroupMemberBackupRow[];
};

function backupUri(profileId: number): string {
  const base = FileSystem.documentDirectory;
  if (!base) {
    throw new Error('documentDirectory unavailable');
  }
  return `${base}${backupFilename(profileId)}`;
}

/** Копия до v4.32.280 — одна на устройство; её содержимое принадлежало первому профилю. */
function legacyBackupUri(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${BACKUP_FILENAME_LEGACY}` : null;
}

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 4000;

/** Отменить отложенный экспорт (например перед удалением БД). */
export function cancelScheduledDialogBackup(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Удалить копию диалогов удалённого профиля (v4.32.309).
 *
 * Удаление профиля вычищало его строки из базы и его ленту, а файл копии
 * оставляло. В нём лежит вся переписка этого аккаунта — шифртекстом, но под тем
 * же DEK устройства, которым открывается и всё остальное. То есть «удалить
 * аккаунт» стирало аккаунт из интерфейса, а переписку оставляло на диске в
 * читаемом для этого устройства виде и навсегда: номера профилей растут
 * монотонно, повторно этот номер никто не займёт и файл не перезапишет.
 *
 * Первому профилю принадлежит ещё и общая копия до v4.32.280 — её наследует
 * только он (см. tryRestoreDialogBackupFromFile), поэтому вместе с ним она и
 * уходит.
 *
 * Имя файла по-прежнему знает только этот модуль — как и с v4.32.307.
 */
export async function deleteDialogBackupForProfile(profileId: number): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (!base) return;
  const uris = [`${base}${backupFilename(profileId)}`];
  if (profileId === 1) {
    const legacy = legacyBackupUri();
    if (legacy) uris.push(legacy);
  }
  for (const uri of uris) {
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (e) {
      log.warn('dialog_backup_delete_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  log.info('dialog_backup_deleted', { profileId });
}

/** Remove every local dialog export during a full wallet wipe. */
export async function deleteAllDialogBackups(): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (!base) return;
  try {
    const names = await FileSystem.readDirectoryAsync(base);
    const backupNames = names.filter((name) =>
      name === BACKUP_FILENAME_LEGACY || /^airchat_dialogs_backup_v1_p\d+\.json$/.test(name),
    );
    await Promise.all(backupNames.map((name) => FileSystem.deleteAsync(`${base}${name}`, { idempotent: true })));
    log.info('dialog_backups_deleted', { count: backupNames.length });
  } catch (e) {
    log.warn('dialog_backups_delete_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/** Вызов после изменения чатов — редкий экспорт на диск. */
export function scheduleDialogBackupPersist(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    InteractionManager.runAfterInteractions(() => {
      void exportDialogBackupToFile().catch((e) => {
        log.warn('dialog_backup_scheduled_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      });
    });
  }, DEBOUNCE_MS);
}

/**
 * v4.32.226 (perf): cache the derived primary wallet pubkey per mnemonic.
 * deriveKeyPairFromMnemonicForProfile runs bip39 mnemonicToSeedSync —
 * PBKDF2-HMAC-SHA512 × 2048 iterations in pure JS, ~2s of SYNCHRONOUS JS-thread
 * block on Hermes. The backup runs 4s after every chat write, so during an
 * active conversation the whole UI froze ~2s every few seconds (confirmed by
 * js_thread_severe_block delayMs≈2200 in device logs). The derived key only
 * changes when the mnemonic changes, so derive once and reuse; keyed by a cheap
 * fingerprint of the mnemonic so a seed re-import invalidates the cache.
 */
let cachedWalletPub: { fp: string; pubB64: string } | null = null;

async function getPrimaryWalletPubKeyB64(): Promise<string | null> {
  const mnemonic = await getStoredMnemonic();
  if (!mnemonic?.trim()) return null;
  const norm = mnemonic.trim();
  // v4.32.227: full content hash instead of len:first8:last8 — the latter could
  // collide for two distinct mnemonics sharing length + edges (returning a stale
  // pubkey). sha256 is the same negligible cost and removes the sharp edge.
  const fp = Buffer.from(sha256(new TextEncoder().encode(norm))).toString('hex').slice(0, 32);
  if (cachedWalletPub && cachedWalletPub.fp === fp) return cachedWalletPub.pubB64;
  const primary = deriveKeyPairFromMnemonicForProfile(norm, 0);
  const pubB64 = Buffer.from(primary.publicKey).toString('base64');
  cachedWalletPub = { fp, pubB64 };
  return pubB64;
}

/**
 * @returns адрес записанного файла — или null, если писать было нечего.
 *
 * v4.32.307: адрес возвращается, а не выводится вызывающим заново. Экран
 * настроек собирал его сам и по устаревшему имени — `airchat_dialogs_backup_v1
 * .json` вместо `..._p<id>.json`, на которое копия переехала в v4.32.280. То
 * есть кнопка «Экспорт резервной копии» отвечала «файл не найден» на только что
 * записанный файл, а на устройстве, обновлённом с версии до v4.32.280, делала
 * хуже: находила ту самую общую копию и отдавала в «Поделиться» переписку
 * ПЕРВОГО профиля — из какого бы профиля её ни нажали.
 *
 * Разъехавшийся литерал имени — та же болезнь, от которой завели kvKeys.ts;
 * здесь лекарство то же: имя знает только этот модуль.
 */
export async function exportDialogBackupToFile(): Promise<string | null> {
  const walletPubKeyB64 = await getPrimaryWalletPubKeyB64();
  if (!walletPubKeyB64) {
    log.debug('dialog_backup_skip_no_mnemonic');
    return null;
  }
  const pid = activeProfileId();
  const messages = await exportRawChatMessageRows(pid);
  const kv = await exportDialogKvSnapshot(pid);
  const conversations = await exportConversationMetaRows(pid);
  const groups = await exportGroupBackupRows(pid);
  const payload: DialogBackupFileV1 = {
    v: 1,
    walletPubKeyB64: walletPubKeyB64,
    exportedAt: Date.now(),
    messages,
    kv,
    conversations,
    groups: groups.groups,
    groupMessages: groups.messages,
    groupMembers: groups.members,
  };
  const uri = backupUri(pid);
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(payload), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  log.info('dialog_backup_exported', {
    messages: messages.length,
    kv: kv.length,
    conversations: conversations.length,
    groups: groups.groups.length,
    groupMessages: groups.messages.length,
  });
  return uri;
}

const DIALOG_BACKUP_MAX_BYTES = 80 * 1024 * 1024;

/**
 * Импортировать JSON-копию диалогов после восстановления того же кошелька.
 *
 * Это отдельный формат от зашифрованной копии seed-фразы: walletPubKeyB64
 * связывает экспорт с аккаунтом, а сами сообщения остаются шифротекстом.
 * Импорт разрешён только в пустую локальную историю, чтобы не смешать два
 * набора сообщений и не перезаписать существующие строки.
 *
 * @returns число импортированных сообщений — личных и групповых вместе
 */
export async function importDialogBackupJson(raw: string): Promise<number> {
  const expectedPub = await getPrimaryWalletPubKeyB64();
  if (!expectedPub) return 0;
  const pid = activeProfileId();
  const existing = await countChatMessages(pid);
  if (existing > 0) {
    log.debug('dialog_backup_skip_nonempty_db', { existing });
    return 0;
  }
  if (typeof raw !== 'string' || raw.length > DIALOG_BACKUP_MAX_BYTES) {
    log.warn('dialog_backup_oversize', { bytes: typeof raw === 'string' ? raw.length : -1 });
    return 0;
  }
  try {
    const data = JSON.parse(raw) as DialogBackupFileV1;

    // v4.32.370: JSON.parse отдаёт не только объекты. Файл из одного слова
    // `null` — вполне годный JSON, а `data.v` на нём это TypeError, который
    // летел наружу мимо проверки.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      log.warn('dialog_backup_bad_format');
      return 0;
    }
    if (data.v !== 1 || !data.walletPubKeyB64 || !Array.isArray(data.messages)) {
      log.warn('dialog_backup_bad_format');
      return 0;
    }
    if (data.walletPubKeyB64 !== expectedPub) {
      log.info('dialog_backup_wallet_mismatch');
      return 0;
    }
    // v4.32.198 (Round-28 #1): cap untrusted-file sizes. 200k messages +
    // 10k kv covers every legitimate user without allowing an import to churn
    // SQLite for minutes or exhaust the JS heap.
    if (data.messages.length > RAW_CHAT_MESSAGE_MAX_ROWS) {
      log.warn('dialog_backup_messages_oversize', { count: data.messages.length });
      return 0;
    }
    if (Array.isArray(data.kv) && data.kv.length > 10_000) {
      log.warn('dialog_backup_kv_oversize', { count: data.kv.length });
      return 0;
    }
    if (Array.isArray(data.conversations) && data.conversations.length > CONVERSATION_META_MAX_ROWS) {
      log.warn('dialog_backup_conversations_oversize', { count: data.conversations.length });
      return 0;
    }
    if (Array.isArray(data.groups) && data.groups.length > GROUP_MAX_ROWS) {
      log.warn('dialog_backup_groups_oversize', { count: data.groups.length });
      return 0;
    }
    if (Array.isArray(data.groupMessages) && data.groupMessages.length > GROUP_MESSAGE_MAX_ROWS) {
      log.warn('dialog_backup_group_messages_oversize', { count: data.groupMessages.length });
      return 0;
    }
    if (Array.isArray(data.groupMembers) && data.groupMembers.length > GROUP_MEMBER_MAX_ROWS) {
      log.warn('dialog_backup_group_members_oversize', { count: data.groupMembers.length });
      return 0;
    }
    let conversations = 0;
    let restoredMeta = 0;
    let restoredMessages = 0;
    let restoredKv = 0;
    let restoredGroups = { groups: 0, messages: 0, members: 0 };
    try {
      restoredMessages = await importRawChatMessageRows(data.messages);
      if (data.kv?.length) {
        restoredKv = await importDialogKvSnapshot(data.kv, pid);
      }
      // v4.32.280: список чатов строится по сообщениям, затем возвращаются
      // настройки переписок, которые были сохранены в копии.
      conversations = await rebuildConversationsFromMessages(pid);
      if (data.conversations) {
        restoredMeta = await importConversationMetaRows(data.conversations, pid);
      }
      if (data.groups) {
        restoredGroups = await importGroupBackupRows(
          { groups: data.groups, messages: data.groupMessages, members: data.groupMembers },
          pid
        );
      }
    } catch (e) {
      log.warn('dialog_backup_import_failed', { err: e instanceof Error ? e.message : String(e) });
      return 0;
    }
    log.info('dialog_backup_restored', {
      messages: restoredMessages,
      inFile: data.messages.length,
      kv: restoredKv,
      conversations,
      restoredMeta,
      groups: restoredGroups.groups,
      groupMessages: restoredGroups.messages,
      groupMembers: restoredGroups.members,
    });
    return restoredMessages + restoredGroups.messages;
  } catch {
    log.warn('dialog_backup_invalid_json');
    return 0;
  }
}

/** Восстановить встроенную копию после импорта seed-фразы. */
export async function tryRestoreDialogBackupFromFile(): Promise<number> {
  const pid = activeProfileId();
  let readUri = backupUri(pid);
  if (!(await FileSystem.getInfoAsync(readUri)).exists) {
    // Копию, снятую до v4.32.280, наследует только первый профиль: она одна на
    // устройство и не помнит, чья она, а второму аккаунту чужая переписка не нужна.
    const legacy = pid === 1 ? legacyBackupUri() : null;
    if (!legacy || !(await FileSystem.getInfoAsync(legacy)).exists) {
      log.debug('dialog_backup_no_file');
      return 0;
    }
    readUri = legacy;
  }
  let raw: string;
  try {
    raw = await FileSystem.readAsStringAsync(readUri, { encoding: FileSystem.EncodingType.UTF8 });
  } catch (e) {
    log.warn('dialog_backup_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
  return importDialogBackupJson(raw);
}
