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
 * той же подписью, что pull/push. Сервер отдаёт по имени только «занято /
 * свободно» — владельца он не называет, иначе по чужому `@name` вычислялся бы
 * адрес его хранилища.
 *
 * Сервер может быть не настроен или недоступен. Тогда имя сохраняется
 * локально, а экран честно говорит, что глобально оно пока не закреплено:
 * отказать человеку в переименовании из-за чужой недоступной машины — хуже,
 * чем отдать имя без глобальной брони.
 */
import { deriveKeyPairFromMnemonic, getStoredMnemonic } from '../backup/seedPhrase';
import { claimSyncUsername, releaseSyncUsername } from '../sync/syncApi';
import { ownBadgeGrantFor } from './ownBadge';
import { profileManager } from './profileManager';
import { isUsernameTakenByAnotherProfile, setOwnUsername } from './ownProfile';

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
    );
    if (!claim.ok && claim.reason !== 'offline') return { ok: false, reason: claim.reason };
    if (claim.ok) scope = 'global';
  }
  if (!(await setOwnUsername(username))) return { ok: false, reason: 'local' };
  return { ok: true, scope };
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
