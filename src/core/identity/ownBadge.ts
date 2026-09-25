/**
 * ownBadge — своя официальная галочка: хранение и предъявление (v4.32.547).
 *
 * Бумагу (см. verification) выдают снаружи и приносят в приложение строкой.
 * Здесь она проверяется на собственный DID и, если она действительно этому
 * аккаунту, ложится в карточку профиля обычным полем `user_verify_grant`.
 *
 * Поле именно в карточке, а не в настройках устройства, и это не мелочь: на
 * одной сид-фразе живут до четырёх аккаунтов, и галочка принадлежит одному из
 * них. Ключ входит в OWN_PROFILE_KEYS, поэтому его сметает удаление профиля и
 * подхватывает восстановление из облака — как имя и «О себе».
 *
 * Проверка идёт при КАЖДОМ чтении, а не один раз при записи. Записанному в
 * базе доверять нельзя ровно в том случае, ради которого всё и делается:
 * резервная копия приезжает файлом, файл можно подменить, и «уже проверено»
 * означало бы «проверено кем-то другим». Проверка — это одна подпись Ed25519,
 * её стоимость на фоне чтения из SQLite незаметна.
 */
import { ownFieldGetFor, ownFieldSet, getOwnUsernameFor } from './ownProfile';
import { profileManager } from './profileManager';
import { readGrant, type VerificationClaim } from './verification';
import { log } from '../logger';

/** Имя ключа в карточке профиля. Смысл — здесь, список — в storage/kvKeys. */
export const OWN_BADGE_KEY = 'user_verify_grant';

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

/**
 * DID названного аккаунта. Через getAllProfiles, а не getActiveProfile:
 * читать галочку может фоновая рассылка профиля, у которой свой pid, и
 * «активный» к её концу может означать уже другой аккаунт.
 */
function didForProfile(pid: number): string | null {
  try {
    return profileManager.getAllProfiles().find((p) => p.id === pid)?.did ?? null;
  } catch (e) {
    log.warn('own_badge_did_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Бумага как есть — для отправки в конверте профиля. Не проверена. */
export async function ownBadgeGrantFor(pid: number): Promise<string | null> {
  return (await ownFieldGetFor(pid, OWN_BADGE_KEY))?.trim() || null;
}

/**
 * Что подтверждает своя бумага: вид галочки и имя, на которое она выдана.
 * null — бумаги нет, она чужая или подписана не тем ключом.
 */
export async function ownBadgeClaimFor(pid: number): Promise<VerificationClaim | null> {
  return await readGrant(await ownBadgeGrantFor(pid), didForProfile(pid));
}

export async function ownBadgeClaim(): Promise<VerificationClaim | null> {
  return await ownBadgeClaimFor(activeProfileId());
}

/**
 * Показывать ли галочку в своей карточке.
 *
 * Условие двойное, как и у чужой: бумага выдана этому аккаунту И на то имя,
 * под которым он сейчас представляется. Аккаунт, переименовавшийся после
 * выдачи, видит себя без галочки — и это правильная подсказка: контакты в
 * этот момент видят его так же.
 */
export async function ownBadgeFor(pid: number): Promise<'official' | null> {
  const claim = await ownBadgeClaimFor(pid);
  if (!claim) return null;
  return claim.username === (await getOwnUsernameFor(pid)) ? claim.badge : null;
}

/**
 * Принять бумагу. Возвращает то, что она подтверждает, — экрану есть что
 * сказать человеку: галочка выдана на имя `@founder`, займите его.
 *
 * Чужая или испорченная не записывается вовсе: хранить непроверяемую строку
 * незачем, а её присутствие в карточке выглядело бы как «что-то есть».
 */
export async function applyOwnBadgeGrant(raw: unknown): Promise<VerificationClaim | null> {
  const pid = activeProfileId();
  const claim = await readGrant(raw, didForProfile(pid));
  if (!claim) {
    log.warn('own_badge_rejected');
    return null;
  }
  // v4.32.896: ответ этой записи выбрасывался. `ownFieldSet` документирован
  // как проверяемый — `false` значит «не записалось», — и до сих пор отказ
  // базы здесь выглядел точно так же, как удача: окно показывало «Аккаунт
  // подтверждён», а в карточке оставалось пусто.
  //
  // Цена не в одном неверном слове. Галочка нигде не берётся из состояния
  // экрана: своя карточка читает `user_verify_grant` из базы при каждой
  // отрисовке, контактам уезжает то же поле. То есть человек считал себя
  // подтверждённым, а видели его без галочки все, включая его самого после
  // перезапуска. Бумагу к этому моменту он обычно уже выбросил из буфера, и
  // повторить вставку было нечем.
  //
  // Бросаем, а не отдаём третий вид ответа: `null` отсюда означает «бумага
  // чужая или испорчена», и путать с ним отказ базы нельзя. Ловушка на
  // экране написана — `pasteBadge` разбирает исключение через
  // `userErrorText`, а строка кириллическая и однострочная, то есть дойдёт
  // до человека как есть.
  if (!(await ownFieldSet(OWN_BADGE_KEY, typeof raw === 'string' ? raw.trim() : ''))) {
    throw new Error('Подтверждение не сохранилось — попробуйте вставить его ещё раз');
  }
  log.info('own_badge_applied', { username: claim.username });
  return claim;
}

// v4.32.896: здесь стоял `clearOwnBadgeGrant` — «убрать свою бумагу». Звать
// его было неоткуда: снимает галочку тот, кто её выдал, отзывом самой бумаги,
// а пункта «убрать подтверждение» в приложении нет и не планировалось.
// Заодно он был третьим местом, где ответ `ownFieldSet` выбрасывался, — то
// есть чинить пришлось бы недостижимый код.
