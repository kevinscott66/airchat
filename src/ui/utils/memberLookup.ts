/**
 * Поиск участника группы по тому, что администратор написал после команды
 * (`/ban Аня`, `/promote @Пётр`, `/kick k3f9d2a1`).
 *
 * Почему это отдельный модуль, а не одна строка `.find(...)` в экране:
 * displayName участник задаёт себе сам. Раньше все пять команд искали
 * `.find((m) => m.displayName.includes(arg))` и брали ПЕРВОЕ совпадение —
 * значит, участник мог назваться так, чтобы совпасть с чужим именем, и
 * увести на себя чужую команду. Для `/promote` это прямое повышение прав:
 * админ пишет `/promote Аня`, а админом становится тот, кто заранее назвался
 * «Аня Петрова» и оказался в списке раньше. Подтверждение не помогало —
 * в диалоге показывалось имя найденного, то есть ровно та же строка.
 *
 * Правило теперь такое: неоднозначность не разрешается «первым попавшимся»,
 * а возвращается наверх, и экран просит уточнить. Уточнить всегда можно
 * хвостом публичного ключа — его подделать нельзя.
 *
 * v4.32.425: уточнять можно и ровно тем, что написано на экране. Подпись без
 * имени теперь выглядит как «sYk1v0…uY2qA4E=» — с головой, многоточием и
 * хвостом, — и по ней `endsWith` не совпал бы никогда. Строка с многоточием
 * разбирается на два конца и проверяется обоими: это ещё и строже голого
 * хвоста.
 *
 * v4.32.595: вся защита выше держалась на том, что имена участников известны.
 * Имя лежит в базе зашифрованным, и если ключ данных его не открывает, чтение
 * отдавало ровно тот же `null`, что и «человек не назвался». Такой участник
 * выпадал из сравнения по имени молча — а значит, `/promote Аня` при двух
 * «Анях», у одной из которых имя не прочиталось, находил РОВНО ОДНУ и
 * повышал её без вопросов. Неоднозначность, ради которой модуль и написан,
 * просто переставала быть видна.
 *
 * Правило добавляется одно: имя может решать, только если прочитаны все имена.
 * Хоть одно непрочитанное — и любое совпадение по имени становится
 * неоднозначным, а непрочитанные участники показываются в списке уточнения
 * наравне с совпавшими. Уточняются они тем же, чем и всегда, — ключом,
 * который не шифруется и не подделывается. Поиск по ключу это правило не
 * трогает: ключ читается всегда.
 */
import { UNREADABLE_NAME_TEXT } from '../../core/storage/unreadableText';
import { shownName } from '../../core/social/unreadableName';
import { identityBody, shortIdentity } from '../identity/shortId';

/** Минимум, что нужно от строки участника: ключ и (необязательное) имя. */
export type LookupMember = {
  peerPubB64: string;
  displayName: string | null;
  /** Столбец с именем не открылся ключом данных — имя есть, но мы его не знаем. */
  displayNameUnreadable?: boolean;
};

export type MemberLookup<T extends LookupMember> =
  | { kind: 'found'; member: T }
  | { kind: 'none' }
  /** Совпало несколько — экран должен показать список и попросить уточнить. */
  | { kind: 'ambiguous'; candidates: T[] };

/**
 * Сколько знаков ключа считать попыткой указать участника ключом, а не именем.
 * Шесть — столько же показывает интерфейс с каждого конца там, где имени нет,
 * так что админ может просто скопировать увиденное.
 */
const MIN_KEY_SUFFIX = 6;

/**
 * «Аня · sYk1v0…uY2qA4E=» — как показывать кандидата в сообщении об уточнении.
 *
 * У участника с непрочитанным именем на месте имени стоит пометка: без неё
 * такая строка выглядела бы как «участник не назвался», то есть врала бы
 * ровно там, где админ и принимает решение.
 */
export function memberLabel(m: LookupMember): string {
  const short = shortIdentity(m.peerPubB64);
  const name = shownName(m.displayName?.trim() ?? null, m.displayNameUnreadable, '');
  return name ? `${name} · ${short}` : short;
}

/**
 * Указан ли этим куском ключа именно этот участник.
 *
 * Кусок бывает двух видов: хвост («uY2qA4E=», набран руками) и сокращённая
 * подпись с экрана («sYk1v0…uY2qA4E=»). Вторая проверяется обоими концами
 * сразу — то есть она надёжнее первой, а не слабее.
 */
function partialKeyMatch(pubB64: string, query: string): boolean {
  const body = identityBody(pubB64);
  const cut = query.indexOf('\u2026');
  if (cut >= 0) {
    const head = query.slice(0, cut);
    const tail = query.slice(cut + 1);
    if (head.length + tail.length < MIN_KEY_SUFFIX) return false;
    return body.startsWith(head) && body.endsWith(tail);
  }
  return query.length >= MIN_KEY_SUFFIX && body.endsWith(query);
}

function byName<T extends LookupMember>(members: T[], match: (name: string) => boolean): T[] {
  return members.filter((m) => match((m.displayName ?? '').trim().toLowerCase()));
}

/** Участники, чьё имя не прочиталось: сравнить их с запросом нечем. */
function blindMembers<T extends LookupMember>(members: T[]): T[] {
  return members.filter((m) => m.displayNameUnreadable === true);
}

function decide<T extends LookupMember>(hits: T[]): MemberLookup<T> | null {
  if (hits.length === 1) return { kind: 'found', member: hits[0] };
  if (hits.length > 1) return { kind: 'ambiguous', candidates: hits };
  return null;
}

/**
 * Решение по совпадению имён с оглядкой на непрочитанные (v4.32.595).
 *
 * Единственное совпадение — ответ только тогда, когда сравнить удалось со
 * всеми. Если хоть одно имя в группе не прочиталось, единственность недоказуема:
 * второй такой же «Аней» мог быть как раз тот, кого мы не прочли. Поэтому
 * непрочитанные добавляются в список уточнения — админ увидит их пометкой и
 * укажет ключом.
 *
 * Когда непрочитанных нет, поведение до знака совпадает с прежним `decide`.
 */
function decideName<T extends LookupMember>(hits: T[], blind: T[]): MemberLookup<T> | null {
  if (hits.length === 0) return null;
  if (hits.length === 1 && blind.length === 0) return { kind: 'found', member: hits[0] };
  return { kind: 'ambiguous', candidates: [...hits, ...blind] };
}

/**
 * Ищет участника по строке запроса. Сначала по ключу (его не подделать),
 * затем по точному имени, префиксу и только потом по подстроке — чтобы
 * точное «Аня» не уводило на «Аня Петрова», если обе есть в группе.
 *
 * На каждом уровне: одно совпадение — ответ, несколько — 'ambiguous'
 * (дальше не спускаемся: раз точных совпадений два, подстрочный поиск
 * их точно не разведёт).
 */
export function resolveMember<T extends LookupMember>(members: T[], rawQuery: string): MemberLookup<T> {
  const query = rawQuery.trim().replace(/^@/, '').trim();
  if (!query) return { kind: 'none' };

  // Ключ — регистрозависимо: base64 различает 'a' и 'A'.
  const exactKey = members.filter((m) => identityBody(m.peerPubB64) === query);
  const byKey = exactKey.length ? exactKey : members.filter((m) => partialKeyMatch(m.peerPubB64, query));
  const keyHit = decide(byKey);
  if (keyHit) return keyHit;

  const q = query.toLowerCase();
  const blind = blindMembers(members);
  return (
    decideName(byName(members, (n) => n === q), blind) ??
    decideName(byName(members, (n) => n.startsWith(q)), blind) ??
    decideName(byName(members, (n) => n.includes(q)), blind) ??
    // Ни одно прочитанное имя не подошло. Пока в группе есть непрочитанные,
    // «не найден» — не ответ: искомый может быть как раз среди них.
    (blind.length ? { kind: 'ambiguous', candidates: blind } : { kind: 'none' })
  );
}

/**
 * Готовый текст для Alert, когда совпало несколько участников.
 * Список ограничен — в большой группе «Ан» может совпасть с десятком имён,
 * и диалог превратился бы в простыню.
 */
export function ambiguityMessage(candidates: LookupMember[]): string {
  const MAX = 8;
  const shown = candidates.slice(0, MAX).map((m) => `• ${memberLabel(m)}`);
  if (candidates.length > MAX) shown.push(`…и ещё ${candidates.length - MAX}`);
  // Единственный кандидат сюда попадает только одним путём: по имени не совпал
  // никто, а имя этого участника не прочиталось. Говорить о нём «подходит
  // несколько» было бы неправдой.
  const head =
    candidates.length > 1
      ? 'Подходит несколько участников:'
      : `${UNREADABLE_NAME_TEXT} — сравнить по имени не с чем:`;
  return `${head}\n${shown.join('\n')}\n\nУточните имя целиком или укажите ключ (${shortIdentity(candidates[0].peerPubB64)}).`;
}
