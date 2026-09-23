/**
 * Общий реестр юзернеймов (v4.32.543).
 *
 * До этой версии уникальность имени проверялась только среди профилей одного
 * телефона (`isUsernameTakenByAnotherProfile`). Это не проверка вовсе: два
 * незнакомых человека спокойно занимали одно и то же `@name`, и получатель
 * конверта не мог сказать, кто из них кто. Имя — единственный
 * человекочитаемый адрес в приложении, и рассылки «я тот самый» строятся
 * ровно на этом.
 *
 * Реестр живёт на сервере синхронизации, рядом с хранилищем, и записывается
 * той же подписью, что pull/push.
 *
 * v4.32.607: рядом с именем публикуется открытый ключ профиля — тот, которым
 * этот профиль переписывается. Прежде сервер намеренно не называл владельца:
 * `accountId` — хеш ключа аккаунта, то есть адрес хранилища. Цена уплачена
 * сознательно, потому что без владельца имя не работало как адрес: нажатие на
 * чужое `@name` упиралось в «нет в ваших контактах», хотя смысл имени ровно в
 * том, чтобы прийти к незнакомому. Адрес хранилища сам по себе не открывает
 * ничего — каждое обращение к нему подписано ключом владельца, — а перебор
 * реестра по-прежнему невозможен: имя лежит слепым индексом, ключ отдаётся
 * только на точный запрос точного имени.
 *
 * Ключ подписывается САМ СОБОЙ (см. `claimSyncUsername`): запрос подписан
 * ключом аккаунта, а у дополнительных профилей ключ переписки другой, и без
 * собственной подписи владелец имени направил бы своё имя на чужой ключ.
 *
 * Сервер может быть не настроен или недоступен. Тогда имя сохраняется
 * локально, а экран честно говорит, что глобально оно пока не закреплено:
 * отказать человеку в переименовании из-за чужой недоступной машины — хуже,
 * чем отдать имя без глобальной брони.
 */
import { deriveKeyPairFromMnemonic, getStoredMnemonic } from '../backup/seedPhrase';
import type { KeyPairBytes } from '../crypto/keyManager';
import { log } from '../logger';
import { kvDelete, kvSet, kvTryListKeysByPrefix } from '../storage/local';
import { claimSyncUsername, releaseSyncUsername } from '../sync/syncApi';
import { ownBadgeGrantFor } from './ownBadge';
import { getOwnDisplayNameFor, getOwnUsernameFor, isUsernameTakenByAnotherProfile, setOwnUsername } from './ownProfile';
import { profileManager } from './profileManager';

/**
 * Чем кончилось сохранение имени.
 *
 * `scope: 'local'` — имя записано, но реестр его не подтвердил: сервер не
 * настроен, не отвечает или на устройстве нет seed-фразы.
 */
export type UsernameSaveResult =
  | { ok: true; scope: 'global' | 'local' }
  | { ok: false; reason: 'taken' | 'rejected' | 'local' };

/** Номер профиля для реестра. 0 — основной. */
function ownerProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 0;
}

/**
 * Занять имя: сперва в общем реестре, затем на устройстве.
 *
 * Порядок именно такой. Локальная запись — единственная точка правды для
 * конвертов, которые уходят контактам; ставить её раньше глобальной брони
 * значит на время отказа реестра разослать имя, которое уже за кем-то.
 *
 * `username` ожидается уже проверенным (`checkUsernameClaim`): длина, набор
 * символов и список оставленных приложению имён — забота экрана, и сервер
 * проверяет их повторно сам.
 */
export async function saveOwnUsernameGlobally(username: string): Promise<UsernameSaveResult> {
  if (await isUsernameTakenByAnotherProfile(username)) return { ok: false, reason: 'local' };
  let scope: 'global' | 'local' = 'local';
  const mnemonic = await getStoredMnemonic();
  if (mnemonic) {
    // v4.32.548: бумага на галочку прикладывается к запросу. Список
    // оставленных приложению имён стоит и на сервере — иначе его снимала бы
    // пересборка клиента, — поэтому разрешение занять `@founder` надо
    // предъявить и там. Бумаги нет почти у всех, и тогда ничего не меняется.
    const claim = await claimSyncUsername(
      mnemonic,
      deriveKeyPairFromMnemonic(mnemonic),
      username,
      ownerProfileId(),
      await ownBadgeGrantFor(ownerProfileId()),
      activeProfilePair(),
      await getOwnDisplayNameFor(ownerProfileId()),
    );
    if (!claim.ok && claim.reason !== 'offline') return { ok: false, reason: claim.reason };
    if (claim.ok) scope = 'global';
  }
  if (!(await setOwnUsername(username))) return { ok: false, reason: 'local' };
  return { ok: true, scope };
}

/**
 * Ключ переписки активного профиля — если он вообще доступен.
 *
 * У профиля свой ключ, отличный от ключа аккаунта, и брать здесь второй
 * нельзя: имя должно вести туда, откуда этот профиль пишет. Менеджер профилей
 * может быть ещё не готов (ранний старт, выход из учётной записи) — тогда имя
 * занимается без ключа, и справочник по нему честно молчит о владельце.
 */
function activeProfilePair(): KeyPairBytes | null {
  try {
    return profileManager.getActiveKeyPair();
  } catch {
    return null;
  }
}

/**
 * Подтвердить уже занятое имя, чтобы в справочник попали ключ и имя профиля.
 *
 * Нужно каждому, кто занял имя до v4.32.607 (записи без ключа — по ним никуда
 * не перейти) или до v4.32.722 (без имени — незнакомец видит «Без имени»), и
 * после каждого переименования. Захват своего же имени идемпотентен, поэтому
 * повтор безвреден; сбой глотается — это фоновая работа, из-за которой нельзя
 * ни падать, ни задерживать экран.
 *
 * Раз за запуск на пару «юзернейм + имя» профиля: вызывается с экрана профиля
 * и после сохранения имени — сетевой запрос на каждое открытие вкладки тут ни
 * к чему, а вот новое имя уйти обязано.
 */
const republished = new Map<number, string>();

export async function republishOwnUsernameToDirectory(): Promise<void> {
  // v4.32.742: заодно добираются имена, которые не вышло отпустить при
  // удалении профиля. Своего повода сходить в сеть у них нет, а этот вызов
  // делается при каждом открытии экрана профиля и после переименования.
  // Ожидается, а не запускается фоном: обе стороны здесь и так фоновые (оба
  // вызывающих зовут эту функцию через `void`), а порядок сетевых запросов
  // предсказуем только у последовательного кода.
  await retryPendingUsernameReleases();
  const pid = ownerProfileId();
  let sent: string | null = null;
  try {
    const username = await getOwnUsernameFor(pid);
    if (!username) return;
    const displayName = await getOwnDisplayNameFor(pid);
    sent = `${username}\n${displayName ?? ''}`;
    if (republished.get(pid) === sent) return;
    republished.set(pid, sent);
    const pair = activeProfilePair();
    if (!pair) return;
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic) return;
    const claim = await claimSyncUsername(
      mnemonic,
      deriveKeyPairFromMnemonic(mnemonic),
      username,
      pid,
      await ownBadgeGrantFor(pid),
      pair,
      displayName,
    );
    // Недоступный сервер не бросает, а отвечает `offline` — и тоже значит
    // «повторить в следующий раз», а не «отправлено».
    if (!claim.ok && claim.reason === 'offline' && republished.get(pid) === sent) republished.delete(pid);
  } catch (error) {
    // Не вышло — пусть следующий вызов попробует снова.
    if (sent !== null && republished.get(pid) === sent) republished.delete(pid);
    log.info('username_directory_republish_skipped', {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Заметка «имя этого профиля ещё не отпущено» (v4.32.742).
 *
 * По ключу на профиль, а не одним списком: список пришлось бы читать, менять и
 * класть обратно целиком, и нечитаемая запись стирала бы чужие заметки.
 * Префикс не профильный (`p<id>:`) намеренно — уборка базы удаляемого профиля
 * такие ключи сметает, а этот обязан её пережить.
 */
const RELEASE_PENDING_PREFIX = 'airchat_username_release_pending:';

/**
 * Одна попытка отпустить имя. `true` — заявка дошла до сервера: либо запись
 * удалена, либо её там и не было (обе — «больше не занято»). `false` — до
 * сервера не добрались, и заметка остаётся на месте.
 */
async function tryReleaseUsernameOnce(profileId: number): Promise<boolean> {
  try {
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic) return false;
    const res = await releaseSyncUsername(mnemonic, deriveKeyPairFromMnemonic(mnemonic), profileId);
    // `ok: false` — записи в реестре не было. Ответ пришёл, повторять нечего.
    if (!res.ok) log.info('username_release_nothing_to_free', { profileId });
  } catch (error) {
    log.info('username_release_deferred', {
      profileId,
      err: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  await kvDelete(`${RELEASE_PENDING_PREFIX}${profileId}`);
  return true;
}

/**
 * Отпустить имя профиля в реестре. Вызывается при удалении профиля.
 *
 * v4.32.742: неудача больше не значит «навсегда занято». Прежде запрос делался
 * один раз и его отказ глотался молча — а профили удаляют и в самолёте, и на
 * неоплаченном интернете. Имя оставалось в реестре навсегда: оно указывало на
 * ключ, которым больше никто не пользуется, письма на `@имя` уходили в никуда,
 * а вернуть себе это имя было нельзя — ни этому человеку, ни любому другому.
 * Само оно не освобождалось: сервер снимает старую запись профиля только когда
 * ТОТ ЖЕ номер профиля занимает другое имя, а номера не переиспользуются
 * (`nextProfileId` растёт монотонно).
 *
 * Поэтому сперва — заметка на диске, и только потом сеть. Заметку разбирает
 * `retryPendingUsernameReleases` при каждом заходе на экран профиля.
 * Падать на удалении по-прежнему нельзя: неудача записи заметки — это ровно
 * прежнее поведение, не хуже.
 */
export async function releaseOwnUsernameGlobally(profileId = ownerProfileId()): Promise<void> {
  // v4.32.731: память о «уже опубликовано» сбрасывается вместе с именем.
  // Номера профилей выдаются заново после удаления, и профиль с тем же
  // номером, взявший то же имя, попадал под `republished.get(pid) === sent` —
  // то есть заявку в реестр не отправлял вовсе. Имя на сервере при этом было
  // отпущено: `@имя` не вело никуда, а приложение считало его опубликованным.
  republished.delete(profileId);
  await kvSet(`${RELEASE_PENDING_PREFIX}${profileId}`, String(Date.now()));
  await tryReleaseUsernameOnce(profileId);
}

/**
 * Добрать имена, которые не отпустились с первого раза (v4.32.742).
 *
 * Нечитаемый список ключей — не «заметок нет»: тогда просто ничего не делаем,
 * повторим в следующий раз. Заметка снимается только после ответа сервера.
 */
export async function retryPendingUsernameReleases(): Promise<void> {
  const keys = await kvTryListKeysByPrefix(RELEASE_PENDING_PREFIX);
  if (keys === null || keys.length === 0) return;
  for (const key of keys) {
    const profileId = Number(key.slice(RELEASE_PENDING_PREFIX.length));
    if (!Number.isInteger(profileId)) {
      // Ключ битый: разобрать его нечем, а держать вечно незачем.
      await kvDelete(key);
      continue;
    }
    // Первый же отказ — связи нет; остальные в этот раз не тревожим.
    if (!(await tryReleaseUsernameOnce(profileId))) return;
  }
}
