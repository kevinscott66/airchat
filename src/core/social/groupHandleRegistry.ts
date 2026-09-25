/**
 * Адрес группы в общем реестре имён (v4.32.937).
 *
 * До этой версии `@имя` группы жило только в её собственном конверте: кто
 * первым написал себе `username`, тот его и показывал. Никакой уникальности за
 * этим не стояло — одно и то же имя одновременно носили человек, группа и
 * канал, и получатель приглашения не мог сказать, к кому он идёт. Теперь адрес
 * занимается тем же `claim`, что и юзернейм человека, в одном с ним
 * пространстве: `@x` принадлежит кому-то одному.
 *
 * Чего этот модуль НЕ делает и не может. Своей ключевой пары у группы нет —
 * подписать заявку нечем, и подписывает её ключ того, кто занимает: владелец
 * устройства. Сервер потому и не проверяет, что заявитель — администратор
 * группы; он проверяет только, что имя свободно. Полномочия того, кто поставил
 * адрес, по-прежнему проверяет получатель конверта (`groupControlEnvelope`), а
 * опознаётся группа публичным идентификатором `GR-…`/`CH-…`, а не именем.
 *
 * Предмет заявки (`subject`) — тот же публичный идентификатор. Он обязателен и
 * при захвате, и при освобождении: имена аккаунта и всех его групп занимает
 * ОДИН профиль, и заявка без предмета означала бы «это моё личное имя» — то
 * есть снимала бы юзернейм самого человека.
 */
import { deriveKeyPairFromMnemonic, getStoredMnemonic } from '../backup/seedPhrase';
import { publicIdFor } from '../identity/publicId';
import { profileManager } from '../identity/profileManager';
import { log } from '../logger';
import { kvDelete, kvGet, kvSetChecked, kvTryListKeysByPrefix } from '../storage/local';
import { claimSyncUsername, releaseSyncUsername, type UsernameSubject } from '../sync/syncApi';

/** Вид предмета: канал — та же группа с `type === 'channel'`. */
export type GroupKind = UsernameSubject['kind'];

/**
 * Чем кончилось занятие адреса.
 *
 * `scope: 'local'` — адрес поставлен, но реестр его не подтвердил: сервера в
 * сборке нет, он не ответил или на устройстве нет seed-фразы. Отказать
 * человеку в переименовании своей группы из-за чужой недоступной машины хуже,
 * чем отдать адрес без глобальной брони, — но сказать ему об этом надо.
 */
export type GroupHandleSaveResult =
  | { ok: true; scope: 'global' | 'local' }
  | { ok: false; reason: 'taken' | 'rejected' };

/** Номер профиля, от чьего имени идёт заявка. 0 — основной. */
function ownerProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 0;
}

/** Предмет заявки: публичный идентификатор группы. */
export function groupSubject(kind: GroupKind, groupId: string): UsernameSubject | null {
  const id = publicIdFor(kind, groupId);
  return id ? { kind, id } : null;
}

/**
 * Занять адрес группы в общем реестре.
 *
 * Зовётся ДО записи адреса в группу и до рассылки конверта: иначе на время
 * отказа реестра участникам разошёлся бы адрес, который уже за кем-то.
 * `handle` ожидается проверенным (`checkGroupHandle`) — сервер проверяет
 * правила имени повторно сам.
 */
export async function saveGroupHandleGlobally(
  kind: GroupKind,
  groupId: string,
  handle: string,
): Promise<GroupHandleSaveResult> {
  const subject = groupSubject(kind, groupId);
  // Без идентификатора заявку слать нельзя: она ушла бы личным именем.
  if (!subject) return { ok: true, scope: 'local' };
  const mnemonic = await getStoredMnemonic();
  if (!mnemonic) return { ok: true, scope: 'local' };
  const pair = deriveKeyPairFromMnemonic(mnemonic);
  const claim = await claimSyncUsername(
    mnemonic,
    pair,
    handle,
    ownerProfileId(),
    // Бумаги на галочку у группы нет, ключа переписки — тоже: за адресом
    // группы человека не стоит, и справочник по нему никуда не ведёт.
    null,
    null,
    null,
    subject,
  );
  if (claim.ok) return { ok: true, scope: 'global' };
  // Недоступный реестр — не отказ: адрес ставится, но без глобальной брони.
  if (claim.reason === 'offline') return { ok: true, scope: 'local' };
  return { ok: false, reason: claim.reason };
}

/**
 * Заметка «адрес этой группы ещё не отпущен».
 *
 * По ключу на предмет, а не одним списком — по тем же причинам, что и у имён
 * профилей (`identity/usernameRegistry`): список пришлось бы читать, менять и
 * класть целиком, и одна нечитаемая запись стирала бы чужие заметки. Значение
 * — номер профиля, от чьего имени адрес занимали: заявку на освобождение
 * сервер сверяет именно с ним.
 */
const RELEASE_PENDING_PREFIX = 'airchat_group_handle_release_pending:';

/** Предметы, чья заметка на диск не легла: повторим, пока живёт процесс. */
const releaseNoteless = new Map<string, number>();

function noteKey(subject: UsernameSubject): string {
  return `${RELEASE_PENDING_PREFIX}${subject.kind}:${subject.id}`;
}

function parseNoteKey(key: string): UsernameSubject | null {
  const rest = key.slice(RELEASE_PENDING_PREFIX.length);
  const cut = rest.indexOf(':');
  if (cut <= 0) return null;
  const kind = rest.slice(0, cut);
  const id = rest.slice(cut + 1);
  if ((kind !== 'group' && kind !== 'channel') || !id) return null;
  return { kind, id };
}

/**
 * Одна попытка отпустить адрес. `true` — заявка дошла до сервера: запись либо
 * удалена, либо её там не было (обе — «больше не занято»).
 */
async function tryReleaseOnce(subject: UsernameSubject, profileId: number): Promise<boolean> {
  try {
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic) return false;
    await releaseSyncUsername(mnemonic, deriveKeyPairFromMnemonic(mnemonic), profileId, subject);
  } catch (error) {
    log.info('group_handle_release_deferred', {
      kind: subject.kind,
      err: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  await kvDelete(noteKey(subject));
  releaseNoteless.delete(noteKey(subject));
  return true;
}

/**
 * Отпустить адрес группы — когда адрес сняли.
 *
 * Сперва заметка на диске, потом сеть: адрес снимают и в самолёте, и на
 * неоплаченном интернете, а имя, которое не вышло отпустить, осталось бы
 * занятым навсегда. Само оно не освободится: сервер снимает прежнюю запись
 * только когда тот же профиль занимает другое имя ТЕМ ЖЕ предметом, а у
 * группы без адреса второго повода проситься в реестр нет.
 *
 * Выход из группы адрес НЕ отпускает, и это не упущение: группа остаётся жить
 * у остальных и продолжает называть себя этим адресом. Отпустить его —
 * значит отдать чужую вывеску первому встречному. Цена известна: адрес висит
 * в восьми слотах занявшего; своей ключевой пары у группы нет, и передать
 * запись другому администратору некому (см. заголовок файла).
 */
export async function releaseGroupHandleGlobally(kind: GroupKind, groupId: string): Promise<void> {
  const subject = groupSubject(kind, groupId);
  if (!subject) return;
  const profileId = ownerProfileId();
  if (!(await kvSetChecked(noteKey(subject), String(profileId)))) {
    releaseNoteless.set(noteKey(subject), profileId);
    log.warn('group_handle_release_note_unsaved', { kind });
  }
  await tryReleaseOnce(subject, profileId);
}

/**
 * Добрать адреса, которые не отпустились с первого раза. Зовётся оттуда же,
 * откуда человек попадает к адресам групп, — с экрана групп.
 */
export async function retryPendingGroupHandleReleases(): Promise<void> {
  for (const [key, profileId] of [...releaseNoteless]) {
    const subject = parseNoteKey(key);
    if (!subject) {
      releaseNoteless.delete(key);
      continue;
    }
    if (await kvSetChecked(key, String(profileId))) releaseNoteless.delete(key);
    // Первый же отказ — связи нет; остальные в этот раз не тревожим.
    if (!(await tryReleaseOnce(subject, profileId))) return;
  }
  const keys = await kvTryListKeysByPrefix(RELEASE_PENDING_PREFIX);
  if (keys === null || keys.length === 0) return;
  for (const key of keys) {
    const subject = parseNoteKey(key);
    if (!subject) {
      // Ключ битый: разобрать его нечем, а держать вечно незачем.
      await kvDelete(key);
      continue;
    }
    const profileId = Number((await kvGet(key)) ?? '');
    if (!Number.isInteger(profileId)) {
      await kvDelete(key);
      continue;
    }
    if (!(await tryReleaseOnce(subject, profileId))) return;
  }
}
