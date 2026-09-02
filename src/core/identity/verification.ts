/**
 * verification — официальная галочка аккаунта (v4.32.547).
 *
 * Галочка не может быть полем, которое аккаунт ставит себе сам. Профиль едет
 * контакту конвертом, который аккаунт же и составляет (см. profileEnvelope), и
 * `verified: true` внутри него означал бы ровно одно: галочка есть у каждого,
 * кто прочитал исходный код. Это не мелочь вкуса — приложение уже держит
 * список `RESERVED_USERNAMES` именно затем, чтобы посторонний не выглядел
 * служебным адресом; самоназначаемая галочка вернула бы ту же дыру с другой
 * стороны, и притом убедительнее любого имени.
 *
 * Поэтому галочка — это ВЫДАННАЯ бумага, а не свойство: подписанная нагрузка,
 * которую аккаунт возит с собой и предъявляет. Подпись ставится ключом,
 * которого в приложении нет — здесь лежит только открытая половина, — а
 * проверяет её каждый получатель у себя, ни к кому не обращаясь. Значит,
 * галочка работает и в офлайне, и не зависит от того, жив ли сервер.
 *
 * Нагрузка связана с ДВУМЯ вещами сразу:
 *
 *  - `did` — чей это аккаунт. Без него бумагу можно переписать себе: конверты
 *    профиля ходят открытым текстом внутри переписки, и первый же получатель
 *    официального аккаунта мог бы предъявить его галочку как свою.
 *  - `username` — под каким именем она действует. Галочка подтверждает не
 *    «человек хороший», а «вот этот аккаунт и есть тот самый @founder».
 *    Аккаунт, сменивший имя, показывать чужую галочку не должен, и здесь это
 *    не оговорка, а условие проверки.
 *
 * Модуль намеренно чистый: ни базы, ни транспорта, ни экрана. Разбор
 * недоверенной строки проверяется тестами без SQLite.
 */
import { publicKeyFromB64 } from '../crypto/pubKeyFormat';
import { verifySignedJson } from '../crypto/signature';
import { OFFICIAL_VERIFIER_KEYS } from './officialKeys';
import { normalizeUsername } from './username';
import { decodeGrant, type VerifiedBadge } from './verificationGrant';

export { OFFICIAL_VERIFIER_KEYS } from './officialKeys';
export { decodeGrant, encodeGrant, MAX_GRANT_LEN } from './verificationGrant';
export type { VerificationGrant, VerifiedBadge } from './verificationGrant';

/** Что подписано. Читается только после проверки подписи. */
export type VerificationClaim = { badge: VerifiedBadge; username: string; issuedAt: number };

/**
 * Проверить бумагу и узнать, что именно она подтверждает.
 *
 * `did` — аккаунт, который её предъявил: свой при чтении собственных настроек,
 * отправителя при разборе входящего конверта. Несовпадение — не ошибка формата,
 * а именно попытка предъявить чужое, поэтому ответ здесь тот же, что и на
 * испорченную строку: галочки нет.
 *
 * Имя аккаунта здесь НЕ сверяется. Сверять его должен вызывающий, и по-разному:
 * при показе галочки — с тем именем, которое сейчас в конверте; при разрешении
 * занять зарезервированное имя — с тем, которое человек набирает. Одна функция
 * на оба случая молча выбрала бы одно из двух.
 */
export async function readGrant(
  raw: unknown,
  did: string | null | undefined
): Promise<VerificationClaim | null> {
  if (!did || typeof did !== 'string') return null;
  const grant = decodeGrant(raw);
  if (!grant) return null;

  for (const keyB64 of OFFICIAL_VERIFIER_KEYS) {
    const pk = publicKeyFromB64(keyB64);
    if (!pk) continue;
    const payload = await verifySignedJson(pk, grant);
    if (!payload) continue;
    const claim = readClaim(payload);
    // Подпись настоящая, но выдана другому аккаунту — дальше по списку ключей
    // идти незачем: нагрузка одна и та же, и другой ключ её не переименует.
    if (!claim || payload.did !== did) return null;
    return claim;
  }
  return null;
}

/** Разбор проверенной нагрузки. Форма строгая: неизвестная версия — отказ. */
function readClaim(payload: Record<string, unknown>): VerificationClaim | null {
  if (payload.v !== 1) return null;
  if (payload.kind !== 'official') return null;
  const username = normalizeUsername(payload.username);
  if (!username) return null;
  const issuedAt = typeof payload.issuedAt === 'number' && Number.isFinite(payload.issuedAt)
    ? payload.issuedAt
    : 0;
  return { badge: 'official', username, issuedAt };
}

/**
 * Показывать ли галочку рядом с этим именем.
 *
 * Отдельной функцией, потому что условие тут двойное и забыть половину легко:
 * бумага должна быть выдана этому аккаунту И на то имя, под которым он сейчас
 * представляется. Аккаунт, переименовавшийся после выдачи, показывает себя без
 * галочки — до перевыпуска.
 */
export async function badgeFor(
  raw: unknown,
  did: string | null | undefined,
  username: string | null | undefined
): Promise<VerifiedBadge | null> {
  const name = normalizeUsername(username);
  if (!name) return null;
  const claim = await readGrant(raw, did);
  return claim && claim.username === name ? claim.badge : null;
}
