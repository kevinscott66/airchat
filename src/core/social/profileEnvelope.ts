/**
 * profileEnvelope — конверт «вот моё имя, фото и описание».
 *
 * v4.32.247. До этой версии профиль распространялся единственным способом:
 * buildSignedProfile клал подписанный JSON в IPFS и возвращал CID. На телефоне
 * IPFS выключен с v4.32.19, поэтому CID всегда получался пустым, `user_profile_cid`
 * никогда не записывался, а `user_avatar_cid` не записывался вообще нигде. Итог:
 * фото профиля и «О себе» видел только их владелец — у контактов всегда был
 * кружок с буквой и пустое описание.
 *
 * Здесь тот же путь, что у сторис: конверт едет обычным зашифрованным личным
 * сообщением, значит работает везде, где работает переписка.
 *
 * Модуль без импортов, кроме проверки формы CID и такого же чистого
 * envelopeBody: разбор недоверенного ввода покрывается тестами без SQLite и
 * транспорта.
 */
import { readEnvelopeBody } from './envelopeBody';
import { isSafeMediaCid } from '../media/mediaCidPolicy';
import { displayNameOrNull, sanitizeParagraphText } from './sysLineGuard';
import { normalizeUsername } from '../identity/username';
import { MAX_GRANT_LEN } from '../identity/verificationGrant';

/**
 * Занятые байты: \x01…\x0c, \x0e…\x13 (см. storyEnvelope.ts).
 * \x0d пропущен намеренно: это CR.
 */
export const PROFILE_PREFIX = '\x14prof:';

/** Пределы полей — те же, что в редакторе профиля, плюс запас. */
export const MAX_NAME_LEN = 64;
export const MAX_BIO_LEN = 512;

/**
 * Предел «О себе» в своём редакторе. Меньше MAX_BIO_LEN намеренно: чужой
 * клиент вправе прислать длиннее, и такой конверт мы принимаем и обрезаем, а
 * не отбрасываем. Своё поле мерится своим числом, и оно здесь одно — раньше
 * его знал только TextInput в ProfileScreen.
 */
export const OWN_BIO_MAX = 200;

/** Отправитель может немного спешить — часы у устройств расходятся. */
const CLOCK_SKEW_MS = 5 * 60_000;

export type PeerProfileEnvelope = {
  /** Как человек сам себя называет. null — имя не задано. */
  name: string | null;
  /** Один канонический username аккаунта. Отсутствует в старых конвертах. */
  username?: string | null;
  /** «О себе». null — не задано. */
  bio: string | null;
  /** Фото профиля: обычный CID или `nb:`-дескриптор вложения. */
  avatarCid: string | null;
  /**
   * v4.32.547: бумага на официальную галочку — строка как есть, непрочитанная.
   *
   * Разбирать её здесь нечем и не нужно: этот модуль отвечает за форму
   * конверта, а бумага — подписанная нагрузка, и единственный осмысленный
   * ответ на неё даёт проверка подписи (identity/verification), которая идёт
   * уже после разбора, зная отправителя. Поэтому поле проходит насквозь и
   * ограничено только длиной. Отсутствует в конвертах до 4.32.547.
   */
  badge?: string | null;
  /** Когда профиль был изменён — по часам отправителя. */
  ts: number;
};

/**
 * v4.32.378: сборка конверта чистит поля тем же правилом, что и разбор.
 *
 * Раньше чистка стояла только на приёме, и это оставляло две щели. Первая:
 * что у автора хранится, то он у себя и видит — а контакты видели уже
 * вычищенное, то есть другое. Вторая важнее: правило на записи чинит только
 * то, что напишут после обновления, а «О себе», набранное раньше, лежит в
 * базе как есть и продолжало бы уезжать как есть. Здесь его последняя
 * остановка перед отправкой, поэтому чистка стоит здесь.
 */
export function encodeProfileEnvelope(env: PeerProfileEnvelope): string {
  const clean: PeerProfileEnvelope = {
    name: displayNameOrNull(env.name, MAX_NAME_LEN),
    ...(env.username !== undefined ? { username: normalizeUsername(env.username) } : {}),
    bio: sanitizeParagraphText(env.bio, MAX_BIO_LEN),
    avatarCid: env.avatarCid,
    ...(env.badge ? { badge: env.badge } : {}),
    ts: env.ts,
  };
  return PROFILE_PREFIX + JSON.stringify(clean);
}

/**
 * «О себе» перед записью в базу — тем же правилом, что и чужое на приёме.
 * Пустая строка значит «не задано»: так это поле и хранится.
 *
 * Чистка нужна и на чтении: биографии, записанные до v4.32.378, уже могут
 * содержать что угодно, а переписывать их за человека мы не вправе.
 */
export function normalizeOwnBio(v: unknown): string {
  return sanitizeParagraphText(v, OWN_BIO_MAX) ?? '';
}

/**
 * Разбирает входящий конверт. `now` передаётся параметром, а не берётся из
 * Date.now(), чтобы тесты не зависели от текущего времени.
 *
 * Возвращает null, если это не наш конверт или он не проходит проверку.
 */
export function decodeProfileEnvelope(text: string, now: number): PeerProfileEnvelope | null {
  // Потолок до JSON.parse: настоящий конверт — меньше килобайта.
  const env = readEnvelopeBody<Partial<PeerProfileEnvelope>>(text, PROFILE_PREFIX, 8192);
  if (!env) return null;

  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;

  // v4.32.374: у конверта профиля было своё, третье правило чистки текста —
  // при том, что и для имени, и для многострочного текста в приложении уже
  // есть по правилу. Отличий у своего было два, и оба оказались ошибками.
  //
  // Первое: управляющие символы оно УДАЛЯЛО, а не заменяло пробелом. Разница
  // видна на «Иван\nПетров»: у sanitizeDisplayName выходит «Иван Петров», тут
  // выходило «ИванПетров» — слова срастались.
  //
  // Второе — то же самое, но в «О себе», и там это заметно каждому. Поле в
  // редакторе профиля многострочное (ProfileScreen, input с multiline):
  // владелец набирает абзацы и у себя их видит. А из диапазона C0 вырезался и
  // перевод строки — значит все его контакты получали сплошную строку, в
  // которой конец одной строки сросся с началом следующей. Своей копии это не
  // касалось никогда, поэтому и не всплывало.
  //
  // Нестроковое поле по-прежнему значит «конверт битый», поэтому проверка типа
  // стоит отдельно: у обеих общих функций null — это «значения нет».
  if (env.name != null && typeof env.name !== 'string') return null;
  if (env.username != null && typeof env.username !== 'string') return null;
  if (env.bio != null && typeof env.bio !== 'string') return null;
  if (env.badge != null && typeof env.badge !== 'string') return null;
  const name = displayNameOrNull(env.name, MAX_NAME_LEN);
  const username = env.username === undefined ? undefined : normalizeUsername(env.username);
  const bio = sanitizeParagraphText(env.bio, MAX_BIO_LEN);
  // Слишком длинная бумага — не повод отбросить весь конверт: имя, фото и «О
  // себе» в нём настоящие, а галочки просто не будет. Обрезать её, в отличие
  // от текста, бессмысленно: обрезанная подпись не проверится никогда.
  const badge = typeof env.badge === 'string' && env.badge.length <= MAX_GRANT_LEN
    ? env.badge
    : null;

  let avatarCid: string | null = null;
  if (env.avatarCid != null) {
    // Фото контакта грузится САМО при отрисовке списка чатов. Подставленный
    // чужой адрес — маяк: выдаёт IP получателя и время, когда тот открыл
    // приложение. Пускаем только настоящий CID и `nb:`-дескриптор.
    if (!isSafeMediaCid(env.avatarCid)) return null;
    avatarCid = env.avatarCid;
  }

  // Метка времени нужна только для сравнения «новее / старее» уже применённой.
  // Из будущего её зажимаем, иначе один конверт с ts = 9e15 навсегда закрыл бы
  // все последующие обновления этого контакта.
  const ts = Math.min(env.ts, now + CLOCK_SKEW_MS);

  return { name, ...(username !== undefined ? { username } : {}), bio, avatarCid, badge, ts };
}
