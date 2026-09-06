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
import { claimSyncUsername, releaseSyncUsername } from '../sync/syncApi';
import { ownBadgeGrantFor } from './ownBadge';
import { getOwnUsernameFor, isUsernameTakenByAnotherProfile, setOwnUsername } from './ownProfile';
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
 * Подтвердить уже занятое имя, чтобы в справочник попал ключ профиля.
 *
 * Нужно ровно один раз для каждого, кто занял имя до v4.32.607: их записи
 * лежат без ключа, и по такому имени никуда не перейти. Захват своего же
 * имени идемпотентен, поэтому повтор безвреден; сбой глотается — это фоновая
 * работа, из-за которой нельзя ни падать, ни задерживать экран.
 *
 * Раз за запуск на профиль: вызывается с экрана профиля, а тот перечитывается
 * после каждого сохранения — сетевой запрос на каждое открытие вкладки тут ни
 * к чему.
 */
const republished = new Set<number>();

export async function republishOwnUsernameToDirectory(): Promise<void> {
  const pid = ownerProfileId();
  if (republished.has(pid)) return;
  republished.add(pid);
  try {
    const username = await getOwnUsernameFor(pid);
    if (!username) return;
    const pair = activeProfilePair();
    if (!pair) return;
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic) return;
    await claimSyncUsername(
      mnemonic,
      deriveKeyPairFromMnemonic(mnemonic),
      username,
      pid,
      await ownBadgeGrantFor(pid),
      pair,
    );
  } catch (error) {
    republished.delete(pid); // не вышло — пусть следующий запуск попробует снова
    log.info('username_directory_republish_skipped', {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Отпустить имя профиля в реестре. Вызывается при удалении профиля; сбой
 * глотается — брошенная запись безвредна, а падать на удалении нельзя.
 */
export async function releaseOwnUsernameGlobally(profileId = ownerProfileId()): Promise<void> {
  try {
    const mnemonic = await getStoredMnemonic();
    if (!mnemonic) return;
    await releaseSyncUsername(mnemonic, deriveKeyPairFromMnemonic(mnemonic), profileId);
  } catch { /* реестр подождёт: имя освободится при следующем захвате */ }
}
