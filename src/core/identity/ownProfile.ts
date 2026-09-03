/**
 * Имя, под которым нас видят остальные, — в одном месте.
 *
 * v4.32.287. До этой версии правило было записано трижды и все три копии
 * разошлись:
 *
 * 1. Пишется имя в kv под ключом `user_username` (LoginScreen, ProfileScreen).
 * 2. Читается — под `user_display_name`: в приглашении в группу, в заявке на
 *    вступление, при создании группы и в ответах администратора. Этот ключ не
 *    записывал никто и никогда, с самой первой версии. Все шесть чтений
 *    всегда возвращали null, и в группу уходило «Вы», «Пользователь» или
 *    пустое поле вместо имени. То есть участники группы видели не то имя,
 *    которое человек себе выбрал, а заглушку.
 * 3. Очищается имя от управляющих символов только в ProfileScreen; в
 *    LoginScreen при регистрации стояла лишь проверка длины — хотя в
 *    комментарии там же написано, что правила совпадают. Через регистрацию
 *    в `user_username` проходили zero-width и RTL-override (U+202E), а оттуда
 *    имя уходит контактам (profileSync) и в группы.
 *
 * Здесь оба правила — и имя ключа, и очистка — в одном экземпляре. Очистка
 * стоит и на чтении: имена, записанные до этой версии, уже могут содержать
 * что угодно, и перезаписывать их за человека мы не вправе.
 */
import {
  kvDelete,
  kvGetSecret,
  kvGetSecretUpgrading,
  kvSetSecret,
  kvSetSecretScoped,
} from '../storage/local';
import { profileScopedKey, type OwnProfileKey } from '../storage/kvKeys';
import { log } from '../logger';
import { profileManager } from './profileManager';
import { isVisiblyBlank, stripBidiControls } from '../social/sysLineGuard';
import { normalizeUsername } from './username';

/** Единственный ключ kv, где лежит собственное имя. */
export const OWN_DISPLAY_NAME_KEY = 'user_username';
/** Единственный username активного аккаунта. Хранится в его profile namespace. */
export const OWN_USERNAME_KEY = 'user_handle';

/**
 * v4.32.288: карточка профиля — своя у каждого профиля.
 *
 * Профили заводят ради разделения: у каждого свои ключи, свои чаты, свои
 * контакты (`p<id>:contact:*`). А карточка — имя, «о себе», аватар, ссылки —
 * лежала в kv одной записью на всех. Последствия:
 *
 * - profileSync рассылает карточку контактам поверх личных сообщений. Второй
 *   профиль представлялся именем, «о себе» и аватаром первого — то есть сам
 *   сообщал получателю, что оба адреса принадлежат одному человеку. Ровно то,
 *   что разделение профилей должно исключать.
 * - Правка имени в одном профиле молча переписывала его в остальных и
 *   расходилась их контактам.
 * - `user_profile_cid` — идентификатор опубликованной карточки, подписанной
 *   ключом конкретного профиля. Общая запись означала, что за профиль
 *   выдавалась чужая карточка.
 *
 * Ключи теперь с префиксом профиля. Записанное до этой версии принадлежит
 * первому профилю — как и в контактах, старую общую запись читает только он.
 */
export { OWN_PROFILE_KEYS } from '../storage/kvKeys';
export type { OwnProfileKey } from '../storage/kvKeys';

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

/**
 * v4.32.306: карточка лежит в kv шифртекстом, как и всё остальное про
 * человека.
 *
 * До этой версии она была одним из немногих оставшихся мест, где открытая база
 * отвечала на вопрос «чей это телефон» прямым текстом: имя, «о себе», ссылки на
 * профили в других сетях, аватар. Имена ОСТАЛЬНЫХ прячутся давно — контакты
 * (v4.32.286), состав группы (v4.32.298), отправитель сообщения (v4.32.285), —
 * то есть достаточно было прочитать одну строку рядом, чтобы узнать владельца
 * тех переписок, которые прячут.
 *
 * `user_avatar_cid` — тот же случай, что avatar_cid группы в v4.32.304: на
 * телефоне это не IPFS-CID, а `nb:`-дескриптор, и он несёт ключ расшифровки
 * файла аватара.
 *
 * Общая запись (до v4.32.288) с этой версии не переписывается, а забирается:
 * зеркало заводили ради отката на прошлую версию, а прошлая версия шифртекст
 * всё равно не прочитает — и держать вечную открытую копию карточки ради этого
 * значило бы оставить дыру, которую закрываем.
 */

/** Поле карточки активного профиля. */
export async function ownFieldGet(key: OwnProfileKey): Promise<string | null> {
  return await ownFieldGetFor(activeProfileId(), key);
}

/**
 * Поле карточки ЗАДАННОГО профиля.
 *
 * v4.32.478: активный профиль — это то, что человек открыл на экране прямо
 * сейчас, а не тот, чьим ключом подписан обрабатываемый конверт. Приём
 * группового сообщения идёт в фоне и знает своего владельца (rcpt.pid), но имя
 * для него брал у активного профиля. То есть человек, у которого заведено два
 * аккаунта, представлялся группе первого именем второго — и уходило это имя
 * не к себе в базу, а участникам группы, по сети. Ключ при этом брался
 * правильный (rcpt.myPub), из-за чего расхождение и не бросалось в глаза.
 */
export async function ownFieldGetFor(pid: number, key: OwnProfileKey): Promise<string | null> {
  const own = await kvGetSecretUpgrading(profileScopedKey(pid, key));
  if (own != null) return own;
  // Общая запись до v4.32.288 принадлежит первому профилю: её писали тогда,
  // когда профиль был один. Остальным она не наследуется — иначе разделение
  // профилей снова стало бы декорацией.
  if (pid !== 1) return null;
  const legacy = await kvGetSecret(key);
  if (legacy == null) return null;
  // v4.32.293: исходную запись убираем, только если копия действительно легла.
  if (await kvSetSecret(profileScopedKey(pid, key), legacy)) await kvDelete(key);
  return legacy;
}

/**
 * Запись поля карточки активного профиля. `false` — не записалось; вызывающий
 * волен промолчать, но соврать человеку «сохранено» не должен.
 */
export async function ownFieldSet(key: OwnProfileKey, value: string): Promise<boolean> {
  return await ownFieldSetFor(activeProfileId(), key, value);
}

/**
 * Запись поля карточки ЗАДАННОГО профиля — по той же причине, по какой рядом
 * стоит ownFieldGetFor: фоновые пути знают своего владельца и не вправе
 * спрашивать, что человек открыл на экране. `false` — не записалось.
 */
export async function ownFieldSetFor(pid: number, key: OwnProfileKey, value: string): Promise<boolean> {
  if (!(await kvSetSecretScoped(pid, key, value))) {
    log.warn('own_field_set_failed', { key });
    return false;
  }
  // Общая запись первого профиля больше не нужна: своя новее, а оставленная
  // открытым текстом она и есть та самая карточка в открытой базе.
  if (pid === 1) await kvDelete(key);
  return true;
}

// v4.32.377: ownFieldKey отдавал наружу имя kv-ключа «для мест, которым нужен
// сам ключ». Таких мест не оказалось: все читают и пишут через ownFieldGet /
// ownFieldSet, и это правильно — только там ключ гарантированно привязан к
// активному профилю.

/** Предел длины имени. Тот же, что показан пользователю в обоих экранах. */
export const OWN_DISPLAY_NAME_MAX = 40;

/**
 * Очистка имени без обрезки: управляющие символы, zero-width и
 * переопределение направления письма (RTL-override подделывает вид
 * строки). Без неё U+202E и невидимые символы уезжали контактам и в группы.
 */
export function stripOwnDisplayName(raw: string | null | undefined): string {
  if (!raw) return '';
  // v4.32.369: список был свой и неполный — в нём не было ни U+061C, ни
  // изоляторов U+2066…U+2069, переставляющих текст так же, как U+202E, ни
  // U+0085. Метки направления письма берутся теперь из общего
  // stripBidiControls, а управляющие символы и разрывы строки — из одного
  // диапазона рядом.
  // eslint-disable-next-line no-control-regex -- вырезание control-символов из недоверенного ввода и есть цель
  const cleaned = stripBidiControls(raw.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, '')).trim();
  // Имя, в котором не осталось ничего рисующегося, на экране пустое — пустым
  // его и возвращаем, иначе проверка «имя не задано» пропустит невидимое.
  // v4.32.371: список этих символов был свой и коротким — только U+200C и
  // U+200D. Ни пустого символа Брайля, ни хангыль-заполнителей в нём не было,
  // хотя набивают пустое имя обычно как раз ими. Правило теперь общее с
  // именами из сети (sysLineGuard.isVisiblyBlank).
  return isVisiblyBlank(cleaned) ? '' : cleaned;
}

/**
 * То же плюс предел длины. Отдельно от stripOwnDisplayName, потому что при
 * регистрации длинное имя — это ошибка с явным сообщением, а не молчаливая
 * обрезка, и мерить её надо по уже очищенной строке: имя из 45 символов,
 * десять из которых невидимые, в предел укладывается.
 */
export function sanitizeOwnDisplayName(raw: string | null | undefined): string {
  const cut = stripOwnDisplayName(raw).slice(0, OWN_DISPLAY_NAME_MAX).trim();
  // v4.32.371: проверка повторяется ПОСЛЕ обрезки. Строка из сорока склеек и
  // настоящего имени за ними видима целиком, а в предел попадает только
  // невидимая часть: имя было задано, а «имя не задано» проверка не увидела.
  return isVisiblyBlank(cut) ? '' : cut;
}

/**
 * Имя для показа другим: контактам, участникам группы, администратору при
 * заявке. `null` — имени нет; подставлять ли вместо него «Вы», «Пользователь»
 * или ничего, решает место вызова: в разных экранах уместны разные заглушки.
 */
export async function getOwnDisplayName(): Promise<string | null> {
  return await getOwnDisplayNameFor(activeProfileId());
}

/**
 * То же имя, но заданного профиля, — для путей, которые знают своего владельца
 * и не вправе спрашивать активный (см. ownFieldGetFor).
 */
export async function getOwnDisplayNameFor(pid: number): Promise<string | null> {
  try {
    const clean = sanitizeOwnDisplayName(await ownFieldGetFor(pid, OWN_DISPLAY_NAME_KEY));
    if (clean) return clean;
    // Профиль, заведённый вторым, своей карточки ещё не имеет: до первой
    // правки имени подставляем то, под которым его завели. Иначе он
    // представлялся бы контактам и группам никак — а раньше представлялся
    // именем первого профиля, что было хуже.
    return sanitizeOwnDisplayName(profileManager.getProfileName(pid)) || null;
  } catch {
    return null;
  }
}

/** Username активного аккаунта. У каждого DID может быть только одно значение. */
export async function getOwnUsername(): Promise<string | null> {
  return await getOwnUsernameFor(activeProfileId());
}

/** Username конкретного аккаунта, без чтения активного профиля. */
export async function getOwnUsernameFor(pid: number): Promise<string | null> {
  return normalizeUsername(await ownFieldGetFor(pid, OWN_USERNAME_KEY));
}

/** Не разрешать два одинаковых username на одном устройстве у разных DID. */
export async function isUsernameTakenByAnotherProfile(username: string, pid = activeProfileId()): Promise<boolean> {
  const normalized = normalizeUsername(username);
  if (!normalized) return false;
  await profileManager.init();
  for (const candidatePid of profileManager.getProfileIds()) {
    if (candidatePid === pid) continue;
    if ((await getOwnUsernameFor(candidatePid)) === normalized) return true;
  }
  return false;
}

/** Единственная точка записи username: пустое имя и локальные дубликаты запрещены. */
export async function setOwnUsername(username: string): Promise<boolean> {
  const normalized = normalizeUsername(username);
  if (!normalized || await isUsernameTakenByAnotherProfile(normalized)) return false;
  return await ownFieldSet(OWN_USERNAME_KEY, normalized);
}
