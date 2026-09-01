/**
 * Группы и каналы в резервной копии диалогов.
 *
 * v4.32.297. Копия хранила только личную переписку: chat_messages, kv контактов
 * и (с v4.32.295) настройки переписок. Групп в ней не было вообще — ни строк
 * `groups`, ни `group_messages`, ни состава. После переустановки и ввода
 * seed-фразы человек получал свои личные чаты обратно, а всё групповое
 * исчезало без следа и без единой строчки на экране: восстановление
 * заканчивалось словами «восстановлено N сообщений», и N считало только
 * личные.
 *
 * Вернуть группу из сети нечем: сообщения расходятся по участникам, история
 * заново не рассылается, а ссылка-приглашение ведёт в новую копию группы с
 * пустой перепиской. То есть локальный файл — единственное, что вообще может
 * её вернуть.
 *
 * Разбор лежит здесь, отдельным модулем без зависимостей: применяет его
 * SQLite-код, который в тестах не поднять, а проверять надо именно границы —
 * файл подменяется через adb/restore, и эти значения идут прямо в БД. Строка
 * проходит целиком или отбрасывается: группа с половиной восстановленных
 * настроек — это, например, группа с потерянным «только админы пишут».
 */
import { COUNT_MAX, count, flag, isPubKeyB64, optionalText, optionalTime, requiredText } from './backupFields';

/**
 * Строка `groups` как в таблице. Название, описание, превью, имя последнего
 * отправителя, черновик и текст закреплённого едут enc2-шифротекстом — тем же,
 * что лежит в БД: DEK выводится из seed-фразы, поэтому после восстановления
 * той же фразой они снова читаются.
 *
 * `owner_profile_id` намеренно НЕ едет: его ставит импорт по активному профилю.
 * Иначе копия, снятая вторым аккаунтом, могла бы принести чужой номер профиля —
 * и группа появилась бы в другом аккаунте того же устройства.
 */
export type GroupBackupRow = {
  id: string;
  name: string;
  description: string | null;
  /**
   * v4.32.304: тоже enc2-шифротекст. На телефоне здесь `nb:`-дескриптор, а он
   * несёт ключ расшифровки файла аватара (blobRef.ts).
   */
  avatar_cid: string | null;
  type: string;
  /**
   * v4.32.303: на месте мёртвого invite_link — секрет пригласительной ссылки,
   * тоже enc2-шифротекстом. Без него восстановленная группа сверяла бы
   * предъявленный токен не с чем, то есть снова пускала бы по ссылкам, которые
   * администратор до потери устройства успел отозвать.
   */
  invite_token: string | null;
  is_admin: number;
  member_count: number;
  unread_count: number;
  mention_count: number;
  muted: number;
  muted_until: number | null;
  pinned: number;
  archived: number;
  last_message_at: number;
  last_message_preview: string | null;
  last_message_sender_name: string | null;
  last_message_sender_pub: string | null;
  pinned_message_id: string | null;
  pinned_message_text: string | null;
  draft_text: string | null;
  disappear_after_ms: number | null;
  disappear_set_at: number | null;
  slow_mode_seconds: number;
  admin_only_posting: number;
  admin_only_pinning: number;
  anonymous_posting: number;
  require_approval: number;
  created_at: number;
};

/** Строка `group_messages`; text/media_cids/sender_name/цитата — шифротекст. */
export type GroupMessageBackupRow = {
  id: string;
  group_id: string;
  sender_pub_b64: string;
  sender_name: string | null;
  text: string;
  media_cids: string | null;
  reply_to_id: string | null;
  reply_to_preview: string | null;
  reactions: string | null;
  created_at: number;
  edited_at: number | null;
  starred: number;
  view_count: number;
  seen_by: string | null;
};

/** Строка `group_members`: состав группы и роли. */
export type GroupMemberBackupRow = {
  group_id: string;
  peer_pub_b64: string;
  role: string;
  display_name: string | null;
  joined_at: number;
};

export const GROUP_MAX_ROWS = 2_000;
export const GROUP_MESSAGE_MAX_ROWS = 200_000;
export const GROUP_MEMBER_MAX_ROWS = 100_000;

const ID_MAX = 128;
/** Название и описание едут шифротекстом — base64 примерно в 1.4 раза длиннее. */
const NAME_MAX = 4_096;
const DESCRIPTION_MAX = 16_384;
/** Тот же предел, что у text личных сообщений: строка целиком или ничего. */
const TEXT_MAX = 96_000;
const MEDIA_CIDS_MAX = 16_384;
const PREVIEW_MAX = 4_096;
const REACTIONS_MAX = 16_384;
const SEEN_BY_MAX = 32_768;
/** Токен — 22 символа, но едет шифротекстом: запас на enc2-обёртку. */
const TOKEN_MAX = 512;
/**
 * Аватар группы. 256 символов хватало ровно до тех пор, пока в колонке лежал
 * настоящий CID (46 символов). На телефоне IPFS выключен, и туда ложится
 * `nb:`-дескриптор: URL вложения (до 512), ключ, MIME и blob-id — под 700
 * символов открытым текстом, а с v4.32.304 ещё и enc2-шифротекстом поверх.
 * Прежний потолок отбрасывал бы не аватар, а ВСЮ строку группы: длина не
 * прошла — `dropped++; continue`. То есть копия молча теряла бы группу целиком
 * из-за картинки.
 */
const AVATAR_CID_MAX = 2_048;
const DISPLAY_NAME_MAX = 4_096;
/** Дольше года «исчезающих сообщений» интерфейс не предлагает. */
const DISAPPEAR_MAX_MS = 365 * 24 * 60 * 60 * 1000;
/** Медленный режим: сутки — потолок и в интерфейсе. */
const SLOW_MODE_MAX = 86_400;

const GROUP_TYPES = new Set(['group', 'channel', 'supergroup']);
const MEMBER_ROLES = new Set(['owner', 'admin', 'member', 'restricted', 'banned']);

type Row = Record<string, unknown>;

function asRow(raw: unknown): Row | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Row;
}

/**
 * Группы из файла. Дубль по `id` отбрасывается: какая из двух строк настоящая,
 * неизвестно, и вторая молча переписала бы настройки первой.
 */
export function sanitizeGroupRows(input: unknown): { rows: GroupBackupRow[]; dropped: number } {
  if (!Array.isArray(input)) return { rows: [], dropped: 0 };
  const rows: GroupBackupRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of input.slice(0, GROUP_MAX_ROWS)) {
    const r = asRow(raw);
    if (!r) { dropped++; continue; }
    const id = requiredText(r.id, ID_MAX);
    const name = requiredText(r.name, NAME_MAX);
    if (id === undefined || name === undefined || seen.has(id)) { dropped++; continue; }
    if (typeof r.type !== 'string' || !GROUP_TYPES.has(r.type)) { dropped++; continue; }

    const isAdmin = flag(r.is_admin);
    const muted = flag(r.muted);
    const pinned = flag(r.pinned);
    const archived = flag(r.archived);
    const adminOnlyPosting = flag(r.admin_only_posting);
    const anonymousPosting = flag(r.anonymous_posting);
    const requireApproval = flag(r.require_approval);
    // Колонки может не быть у копии, снятой до миграции; безопасное значение —
    // «закреплять могут только админы», как и в rowToGroup.
    const adminOnlyPinning = r.admin_only_pinning == null ? 1 : flag(r.admin_only_pinning);
    if (
      isAdmin == null || muted == null || pinned == null || archived == null ||
      adminOnlyPosting == null || anonymousPosting == null || requireApproval == null ||
      adminOnlyPinning == null
    ) { dropped++; continue; }

    const memberCount = count(r.member_count);
    const unread = count(r.unread_count);
    const mention = count(r.mention_count);
    const slowMode = count(r.slow_mode_seconds, SLOW_MODE_MAX);
    if (memberCount == null || unread == null || mention == null || slowMode == null) { dropped++; continue; }

    const lastAt = optionalTime(r.last_message_at);
    const createdAt = optionalTime(r.created_at);
    const mutedUntil = optionalTime(r.muted_until);
    const disappearSetAt = optionalTime(r.disappear_set_at);
    if (lastAt === undefined || createdAt === undefined || mutedUntil === undefined || disappearSetAt === undefined) {
      dropped++; continue;
    }

    const description = optionalText(r.description, DESCRIPTION_MAX);
    const avatarCid = optionalText(r.avatar_cid, AVATAR_CID_MAX);
    const inviteToken = optionalText(r.invite_token, TOKEN_MAX);
    const preview = optionalText(r.last_message_preview, PREVIEW_MAX);
    const senderName = optionalText(r.last_message_sender_name, NAME_MAX);
    const pinnedMessageId = optionalText(r.pinned_message_id, ID_MAX);
    const pinnedMessageText = optionalText(r.pinned_message_text, TEXT_MAX);
    const draft = optionalText(r.draft_text, TEXT_MAX);
    if (
      description === undefined || avatarCid === undefined || inviteToken === undefined ||
      preview === undefined || senderName === undefined || pinnedMessageId === undefined ||
      pinnedMessageText === undefined || draft === undefined
    ) { dropped++; continue; }
    if (r.last_message_sender_pub != null && !isPubKeyB64(r.last_message_sender_pub)) { dropped++; continue; }

    let disappear: number | null = null;
    if (r.disappear_after_ms != null) {
      const v = r.disappear_after_ms;
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > DISAPPEAR_MAX_MS) { dropped++; continue; }
      disappear = Math.floor(v);
    }

    seen.add(id);
    rows.push({
      id,
      name,
      description,
      avatar_cid: avatarCid,
      type: r.type,
      invite_token: inviteToken,
      is_admin: isAdmin,
      member_count: memberCount,
      unread_count: unread,
      mention_count: mention,
      muted,
      muted_until: mutedUntil,
      pinned,
      archived,
      last_message_at: lastAt ?? 0,
      last_message_preview: preview,
      last_message_sender_name: senderName,
      last_message_sender_pub: (r.last_message_sender_pub as string | null) ?? null,
      pinned_message_id: pinnedMessageId,
      pinned_message_text: pinnedMessageText,
      draft_text: draft,
      disappear_after_ms: disappear,
      disappear_set_at: disappearSetAt,
      slow_mode_seconds: slowMode,
      admin_only_posting: adminOnlyPosting,
      admin_only_pinning: adminOnlyPinning,
      anonymous_posting: anonymousPosting,
      require_approval: requireApproval,
      created_at: createdAt ?? 0,
    });
  }
  if (input.length > GROUP_MAX_ROWS) dropped += input.length - GROUP_MAX_ROWS;
  return { rows, dropped };
}

/**
 * Сообщения групп. `knownGroupIds` — группы, приехавшие в том же файле:
 * сообщение к группе, которой в копии нет, не показать никак — оно осталось бы
 * в БД мусором, который виден только поиску по всем чатам.
 */
export function sanitizeGroupMessageRows(
  input: unknown,
  knownGroupIds: ReadonlySet<string>
): { rows: GroupMessageBackupRow[]; dropped: number } {
  if (!Array.isArray(input)) return { rows: [], dropped: 0 };
  const rows: GroupMessageBackupRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of input.slice(0, GROUP_MESSAGE_MAX_ROWS)) {
    const r = asRow(raw);
    if (!r) { dropped++; continue; }
    const id = requiredText(r.id, ID_MAX);
    const groupId = requiredText(r.group_id, ID_MAX);
    if (id === undefined || groupId === undefined || seen.has(id)) { dropped++; continue; }
    if (!knownGroupIds.has(groupId)) { dropped++; continue; }
    if (!isPubKeyB64(r.sender_pub_b64)) { dropped++; continue; }
    // Пустой текст у сообщения бывает — это вложение без подписи.
    if (typeof r.text !== 'string' || r.text.length > TEXT_MAX) { dropped++; continue; }

    const createdAt = optionalTime(r.created_at);
    const editedAt = optionalTime(r.edited_at);
    if (createdAt == null || editedAt === undefined) { dropped++; continue; }

    const starred = flag(r.starred ?? 0);
    if (starred == null) { dropped++; continue; }
    const views = count(r.view_count ?? 0, COUNT_MAX);
    if (views == null) { dropped++; continue; }

    const senderName = optionalText(r.sender_name, NAME_MAX);
    const mediaCids = optionalText(r.media_cids, MEDIA_CIDS_MAX);
    const replyToId = optionalText(r.reply_to_id, ID_MAX);
    const replyPreview = optionalText(r.reply_to_preview, PREVIEW_MAX);
    const reactions = optionalText(r.reactions, REACTIONS_MAX);
    const seenBy = optionalText(r.seen_by, SEEN_BY_MAX);
    if (
      senderName === undefined || mediaCids === undefined || replyToId === undefined ||
      replyPreview === undefined || reactions === undefined || seenBy === undefined
    ) { dropped++; continue; }

    seen.add(id);
    rows.push({
      id,
      group_id: groupId,
      sender_pub_b64: r.sender_pub_b64,
      sender_name: senderName,
      text: r.text,
      media_cids: mediaCids,
      reply_to_id: replyToId,
      reply_to_preview: replyPreview,
      reactions,
      created_at: createdAt,
      edited_at: editedAt,
      starred,
      view_count: views,
      seen_by: seenBy,
    });
  }
  if (input.length > GROUP_MESSAGE_MAX_ROWS) dropped += input.length - GROUP_MESSAGE_MAX_ROWS;
  return { rows, dropped };
}

/**
 * Состав групп. Роль из файла проверяется по списку: неизвестная роль — это
 * участник, которого экран не покажет ни в одном разделе, а `owner` вместо
 * `member` — наоборот, чужие админские кнопки в своей копии группы.
 */
export function sanitizeGroupMemberRows(
  input: unknown,
  knownGroupIds: ReadonlySet<string>
): { rows: GroupMemberBackupRow[]; dropped: number } {
  if (!Array.isArray(input)) return { rows: [], dropped: 0 };
  const rows: GroupMemberBackupRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of input.slice(0, GROUP_MEMBER_MAX_ROWS)) {
    const r = asRow(raw);
    if (!r) { dropped++; continue; }
    const groupId = requiredText(r.group_id, ID_MAX);
    if (groupId === undefined || !knownGroupIds.has(groupId)) { dropped++; continue; }
    if (!isPubKeyB64(r.peer_pub_b64)) { dropped++; continue; }
    if (typeof r.role !== 'string' || !MEMBER_ROLES.has(r.role)) { dropped++; continue; }
    const key = `${groupId} ${r.peer_pub_b64}`;
    if (seen.has(key)) { dropped++; continue; }
    const displayName = optionalText(r.display_name, DISPLAY_NAME_MAX);
    const joinedAt = optionalTime(r.joined_at);
    if (displayName === undefined || joinedAt === undefined) { dropped++; continue; }
    seen.add(key);
    rows.push({
      group_id: groupId,
      peer_pub_b64: r.peer_pub_b64,
      role: r.role,
      display_name: displayName,
      joined_at: joinedAt ?? 0,
    });
  }
  if (input.length > GROUP_MEMBER_MAX_ROWS) dropped += input.length - GROUP_MEMBER_MAX_ROWS;
  return { rows, dropped };
}
