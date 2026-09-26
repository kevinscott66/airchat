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
import { rateLimiter } from '../security/rateLimiter';
import { dialogKvSnapshotHasBlockList } from './kvKeys';
import { RAW_CHAT_MESSAGE_MAX_ROWS } from './chatMessageBackup';
import { dialogBackupRefused } from './dialogBackupReport';
import type { DialogBackupImportResult, DialogBackupStep } from './dialogBackupReport';
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

/**
 * `null`, когда каталога документов нет вовсе — так выглядит web: у страницы
 * нет файловой системы приложения, и `FileSystem.documentDirectory` там пуст.
 *
 * Раньше здесь кидали `documentDirectory unavailable`. На нативе это было
 * равносильно `null` (базы без каталога не бывает), а на web давало
 * необработанный reject из отложенного экспорта — ошибку про отсутствие того,
 * чего на этой платформе и не должно быть. Остальные пути модуля
 * (`legacyBackupUri`, `deleteDialogBackupForProfile`, `deleteAllDialogBackups`)
 * уже возвращались молча; теперь и этот ведёт себя так же.
 *
 * Данные при этом не теряются: копия на диск — дублирующая подстраховка поверх
 * SQLite, а сама база в браузере живёт в wa-sqlite и переживает перезагрузку.
 */
function backupUri(profileId: number): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${backupFilename(profileId)}` : null;
}

/** Копия до v4.32.280 — одна на устройство; её содержимое принадлежало первому профилю. */
function legacyBackupUri(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${BACKUP_FILENAME_LEGACY}` : null;
}

/**
 * Имя, под которым прежняя копия пережидает запись новой (v4.32.969).
 *
 * До этой версии запись шла так: временный файл — удалить старый — переставить
 * временный на его место. Между вторым и третьим шагом копии не было ни одной,
 * а разбор отказа доделывал начатое: он стирал временный файл, то есть
 * единственное, что к тому моменту оставалось от переписки. Приём тот же, что
 * у настроек устройства (config, v4.32.967): прежняя отходит в сторону под
 * именем, которое читатель знает и умеет поднять.
 */
function previousBackupUri(uri: string): string {
  return `${uri}.prev`;
}

/**
 * Поднять отодвинутую копию, если основной нет.
 *
 * Нужно потому, что выключенное питание не ждёт никакого `catch`: обрыв между
 * двумя переносами оставляет переписку под именем `.prev`, а у этого имени
 * должен быть читатель — иначе оно ничем не лучше прежней дыры.
 */
async function restoreStrandedBackup(uri: string): Promise<void> {
  try {
    if ((await FileSystem.getInfoAsync(uri)).exists) return;
    const previous = previousBackupUri(uri);
    if (!(await FileSystem.getInfoAsync(previous)).exists) return;
    await FileSystem.moveAsync({ from: previous, to: uri });
    log.warn('dialog_backup_restored_from_previous');
  } catch (e) {
    log.warn('dialog_backup_restore_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Все имена, которыми копия может лежать на диске: она сама, отодвинутая
 * прежняя и обрывок незавершённой записи. Содержимое у всех трёх одно — вся
 * переписка профиля, — поэтому и уборка у них общая.
 */
const BACKUP_NAME_RE = /^airchat_dialogs_backup_v1(?:_p\d+)?\.json(?:\.prev|\.tmp-\d+)?$/;

/** Имена, принадлежащие ровно этой копии: `…_p1.json` и всё, что за её точкой. */
function isNameOfBackup(name: string, mainName: string): boolean {
  return name === mainName || name.startsWith(`${mainName}.`);
}

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 4000;

/**
 * Поколение отложенных записей (v4.32.970).
 *
 * Отсрочка у копии двухступенчатая: сначала таймер на 4 секунды, потом
 * `runAfterInteractions` — очередь, которая ждёт конца анимаций и не имеет
 * отмены. Между ступенями `debounceTimer` уже null, и отмена, умевшая только
 * гасить таймер, становилась пустым действием ровно тогда, когда запись была
 * ближе всего.
 */
let backupEpoch = 0;
/** Запись, которая уже идёт: её нельзя отменить, но можно дождаться. */
let inFlightExport: Promise<unknown> | null = null;

/**
 * Отменить отложенный экспорт (например перед удалением БД).
 *
 * v4.32.970: отмена перестала быть обещанием на словах. Зовут её из сброса
 * кошелька первым шагом, а файлы копий уносит шаг `dialog_backups` намного
 * позже — и всё, что между ними успевало записаться, переживало «удалить
 * данные на устройстве» навсегда: в файле вся переписка профиля, имя профиля
 * повторно не займёт никто, перезаписать его нечем.
 *
 * Отменяется теперь и то, что уже ушло в очередь взаимодействий (по номеру
 * поколения), и то, что уже пишется (дожидаемся — тогда удаление файлов
 * заведомо идёт после записи, а не до неё).
 *
 * Номер поколения, а не флаг «запись выключена»: после сброса приложение
 * поднимается в том же процессе (walletBootNonce в App.tsx), и выключенная
 * навсегда копия — это следующий владелец устройства без резервной копии.
 */
export async function cancelScheduledDialogBackup(): Promise<void> {
  backupEpoch += 1;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const running = inFlightExport;
  if (running) await running.catch(() => {});
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
  const mainNames = [backupFilename(profileId)];
  if (profileId === 1) mainNames.push(BACKUP_FILENAME_LEGACY);
  const uris = mainNames.map((name) => `${base}${name}`);
  // v4.32.969: удалялись только точные имена, а копия живёт ещё под двумя —
  // отодвинутой прежней и обрывком записи. Обе — та же переписка целиком, и
  // не убирал их никто: временное имя каждый раз новое (`.tmp-<время>`),
  // так что следующая запись поверх старого обрывка не встаёт.
  let strays: string[] = [];
  try {
    const names = await FileSystem.readDirectoryAsync(base);
    strays = names
      .filter((name) => mainNames.some((main) => isNameOfBackup(name, main)))
      .map((name) => `${base}${name}`);
  } catch (e) {
    // Не прочитали — не говорим «удалено»: ниже это станет отказом шага.
    log.warn('dialog_backup_scan_failed', {
      profileId,
      err: e instanceof Error ? e.message : String(e),
    });
    strays = [];
  }
  for (const uri of strays) if (!uris.includes(uri)) uris.push(uri);
  // v4.32.741: отказ удаления гасился здесь, а строка «копия удалена» писалась
  // в журнал безусловно — и то и другое неправда. Копия диалогов это вся
  // переписка профиля одним файлом; зовут эту уборку только при удалении
  // профиля, и по её молчанию человеку говорили «Профиль удалён».
  let failure: unknown = null;
  for (const uri of uris) {
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (e) {
      log.warn('dialog_backup_delete_failed', {
        profileId,
        err: e instanceof Error ? e.message : String(e),
      });
      failure = failure ?? e;
    }
  }
  if (failure) throw failure;
  log.info('dialog_backup_deleted', { profileId });
}

/** Remove every local dialog export during a full wallet wipe. */
export async function deleteAllDialogBackups(): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (!base) return;
  try {
    const names = await FileSystem.readDirectoryAsync(base);
    const backupNames = names.filter((name) => BACKUP_NAME_RE.test(name));
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
  const epoch = backupEpoch;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    InteractionManager.runAfterInteractions(() => {
      // Очередь взаимодействий отмены не знает: снять из неё задачу нечем.
      // Поэтому задача сама спрашивает, тот ли мир вокруг, в котором её
      // заводили.
      if (epoch !== backupEpoch) {
        log.debug('dialog_backup_scheduled_cancelled');
        return;
      }
      const running = exportDialogBackupToFile().catch((e) => {
        log.warn('dialog_backup_scheduled_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      });
      inFlightExport = running;
      void running.then(() => {
        if (inFlightExport === running) inFlightExport = null;
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
  // До сбора payload: он читает всю переписку из базы, и делать это ради
  // записи, которой некуда идти, незачем.
  const uri = backupUri(pid);
  if (!uri) {
    log.debug('dialog_backup_skip_no_filesystem');
    return null;
  }
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
  // v4.32.728: запись идёт во временный файл и только потом встаёт на место.
  // Прямая перезапись била по единственной локальной копии: файл открывался на
  // усечение ДО того, как новое содержимое оказывалось на диске, и обрыв на
  // середине (нехватка места, снятие приложения, отключение питания) оставлял
  // вместо копии обрезанный JSON. Разбору он не поддаётся — импорт такую копию
  // отвергает целиком, — а старой, целой, уже нет. Между тем смысл файла ровно
  // в том, чтобы пережить потерю базы: это последнее, к чему можно вернуться.
  // Тот же приём, что при разборе архива аккаунта (accountVault, v4.32.617).
  // v4.32.969: удаление прежней заменено на отход в сторону. Целым временный
  // файл делал только первую половину дела: между `delete` и `move` копии не
  // было ни одной, а разбор отказа стирал временный — то есть последнее, что
  // от переписки оставалось. Отказ переноса тут не выдумка: на iOS он бывает
  // на исходе места и при защите файла, и ровно на нём всё и сходилось.
  const temporary = `${uri}.tmp-${Date.now()}`;
  const previous = previousBackupUri(uri);
  let movedAside = false;
  try {
    await FileSystem.writeAsStringAsync(temporary, JSON.stringify(payload), {
      encoding: FileSystem.EncodingType.UTF8,
    });
    await FileSystem.deleteAsync(previous, { idempotent: true });
    // Перестановка имени: содержимое к этому моменту уже целиком на диске.
    if ((await FileSystem.getInfoAsync(uri)).exists) {
      await FileSystem.moveAsync({ from: uri, to: previous });
      movedAside = true;
    }
    await FileSystem.moveAsync({ from: temporary, to: uri });
    await FileSystem.deleteAsync(previous, { idempotent: true });
  } catch (e) {
    if (movedAside) {
      await FileSystem.moveAsync({ from: previous, to: uri }).catch((err: unknown) => {
        log.error('dialog_backup_previous_rollback_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    // Обрывок не оставляем: он не копия и занимает столько же места.
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => {});
    log.warn('dialog_backup_export_failed', { err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
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
 * v4.32.844: отвечает разбором, а не одним числом. Ноль возвращался на десять
 * разных исходов подряд — и экран на каждый из них печатал «проверьте секретные
 * слова и убедитесь, что история пуста», что правда ровно в двух случаях из
 * десяти. Ещё хуже читался успех: список упавших шагов уходил только в журнал,
 * а человеку говорили «Восстановлено сообщений: N» — в тот самый момент, когда
 * группы терялись навсегда (повтор упрётся в `existing > 0`, а локальный файл —
 * единственное, чем группа восстанавливается вообще).
 *
 * @returns что восстановлено, что не прошло и почему отказано
 */
export async function importDialogBackupJson(raw: string): Promise<DialogBackupImportResult> {
  const expectedPub = await getPrimaryWalletPubKeyB64();
  if (!expectedPub) return dialogBackupRefused('no_wallet');
  const pid = activeProfileId();
  const existing = await countChatMessages(pid);
  // v4.32.717: «база не ответила» больше не читается как «история пуста».
  // Счётчик отдавал ноль и на отказ чтения, и на пустую базу, а импорт по
  // этому нулю решал, что писать не поверх чего. Дальше он писал именно
  // поверх: строки сообщений идут через ON CONFLICT DO UPDATE, снимок kv —
  // через INSERT OR REPLACE, настройки переписок — безусловным UPDATE. То
  // есть отказ чтения оборачивался потерей живой переписки. На неизвестном
  // ответе держим импорт: лучше не восстановить, чем затереть.
  if (existing === null) {
    log.warn('dialog_backup_hold_unknown_db_size');
    return dialogBackupRefused('db_unreadable');
  }
  if (existing > 0) {
    log.debug('dialog_backup_skip_nonempty_db', { existing });
    return dialogBackupRefused('db_not_empty');
  }
  if (typeof raw !== 'string' || raw.length > DIALOG_BACKUP_MAX_BYTES) {
    log.warn('dialog_backup_oversize', { bytes: typeof raw === 'string' ? raw.length : -1 });
    return dialogBackupRefused('file_oversize');
  }
  try {
    const data = JSON.parse(raw) as DialogBackupFileV1;

    // v4.32.370: JSON.parse отдаёт не только объекты. Файл из одного слова
    // `null` — вполне годный JSON, а `data.v` на нём это TypeError, который
    // летел наружу мимо проверки.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      log.warn('dialog_backup_bad_format');
      return dialogBackupRefused('bad_format');
    }
    if (data.v !== 1 || !data.walletPubKeyB64 || !Array.isArray(data.messages)) {
      log.warn('dialog_backup_bad_format');
      return dialogBackupRefused('bad_format');
    }
    if (data.walletPubKeyB64 !== expectedPub) {
      log.info('dialog_backup_wallet_mismatch');
      return dialogBackupRefused('wallet_mismatch');
    }
    // v4.32.198 (Round-28 #1): cap untrusted-file sizes. 200k messages +
    // 10k kv covers every legitimate user without allowing an import to churn
    // SQLite for minutes or exhaust the JS heap.
    if (data.messages.length > RAW_CHAT_MESSAGE_MAX_ROWS) {
      log.warn('dialog_backup_messages_oversize', { count: data.messages.length });
      return dialogBackupRefused('rows_oversize');
    }
    if (Array.isArray(data.kv) && data.kv.length > 10_000) {
      log.warn('dialog_backup_kv_oversize', { count: data.kv.length });
      return dialogBackupRefused('rows_oversize');
    }
    if (Array.isArray(data.conversations) && data.conversations.length > CONVERSATION_META_MAX_ROWS) {
      log.warn('dialog_backup_conversations_oversize', { count: data.conversations.length });
      return dialogBackupRefused('rows_oversize');
    }
    if (Array.isArray(data.groups) && data.groups.length > GROUP_MAX_ROWS) {
      log.warn('dialog_backup_groups_oversize', { count: data.groups.length });
      return dialogBackupRefused('rows_oversize');
    }
    if (Array.isArray(data.groupMessages) && data.groupMessages.length > GROUP_MESSAGE_MAX_ROWS) {
      log.warn('dialog_backup_group_messages_oversize', { count: data.groupMessages.length });
      return dialogBackupRefused('rows_oversize');
    }
    if (Array.isArray(data.groupMembers) && data.groupMembers.length > GROUP_MEMBER_MAX_ROWS) {
      log.warn('dialog_backup_group_members_oversize', { count: data.groupMembers.length });
      return dialogBackupRefused('rows_oversize');
    }
    let conversations = 0;
    let restoredMeta = 0;
    let restoredMessages = 0;
    let restoredKv = 0;
    let restoredGroups = { groups: 0, messages: 0, members: 0 };
    // v4.32.717: шаги идут порознь, а не одним `try` на всех.
    //
    // Каждый из пяти шагов фиксируется своей транзакцией, общей отмены у них
    // нет. Пока они стояли под одним `try`, сбой второго уводил из функции
    // мимо оставшихся трёх — при том, что строки первого уже лежали в базе.
    // Возвращался при этом ноль, то есть «ничего не восстановлено», и повтор
    // упирался в `existing > 0`: контакты, блок-лист, настройки переписок и
    // ВСЕ группы становились невосстановимыми (локальный файл — единственное,
    // чем группа восстанавливается вообще). Шаги независимы, поэтому сбой
    // одного не повод не выполнять остальные; называем в журнале, какие
    // именно не прошли.
    const failed: DialogBackupStep[] = [];
    const step = async (name: DialogBackupStep, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (e) {
        failed.push(name);
        log.warn('dialog_backup_step_failed', { step: name, err: e instanceof Error ? e.message : String(e) });
      }
    };
    await step('messages', async () => {
      restoredMessages = await importRawChatMessageRows(data.messages);
    });
    await step('kv', async () => {
      if (!data.kv?.length) return;
      restoredKv = await importDialogKvSnapshot(data.kv, pid);
      // v4.32.617: блок-лист лежит и в памяти rateLimiter. Восстановление
      // писало только в базу, поэтому вернувшиеся из копии запреты не
      // действовали, а следующая блокировка стирала их с диска.
      if (dialogKvSnapshotHasBlockList(data.kv)) await rateLimiter.reloadBlocked();
    });
    // v4.32.280: список чатов строится по сообщениям, затем возвращаются
    // настройки переписок, которые были сохранены в копии.
    await step('conversations', async () => {
      conversations = await rebuildConversationsFromMessages(pid);
    });
    await step('meta', async () => {
      if (!data.conversations) return;
      restoredMeta = await importConversationMetaRows(data.conversations, pid);
    });
    await step('groups', async () => {
      if (!data.groups) return;
      restoredGroups = await importGroupBackupRows(
        { groups: data.groups, messages: data.groupMessages, members: data.groupMembers },
        pid
      );
    });
    if (failed.length) {
      log.warn('dialog_backup_import_partial', { failed: failed.join(','), messages: restoredMessages });
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
    return {
      messages: restoredMessages + restoredGroups.messages,
      groups: restoredGroups.groups,
      failed,
      refused: null,
    };
  } catch {
    log.warn('dialog_backup_invalid_json');
    return dialogBackupRefused('bad_json');
  }
}

/** Восстановить встроенную копию после импорта seed-фразы. */
export async function tryRestoreDialogBackupFromFile(): Promise<number> {
  const pid = activeProfileId();
  let readUri = backupUri(pid);
  if (!readUri) {
    log.debug('dialog_backup_no_filesystem');
    return 0;
  }
  await restoreStrandedBackup(readUri);
  if (!(await FileSystem.getInfoAsync(readUri)).exists) {
    // Копию, снятую до v4.32.280, наследует только первый профиль: она одна на
    // устройство и не помнит, чья она, а второму аккаунту чужая переписка не нужна.
    const legacy = pid === 1 ? legacyBackupUri() : null;
    if (legacy) await restoreStrandedBackup(legacy);
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
  // Наверху этой ветки (автовосстановление после seed-фразы) экрана нет —
  // человеку показать разбор некому, поэтому наружу едет только число.
  return (await importDialogBackupJson(raw)).messages;
}
