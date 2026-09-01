/**
 * Поиск участника по имени и непрочитанные имена (v4.32.606).
 *
 * Дефект. С v4.32.595 имя участника, которое не открыл ключ этого устройства,
 * приходит как `displayName: null` с поднятым `displayNameUnreadable`. Оба
 * места, где участника ищут по имени, сравнивали `(m.displayName ?? '')` — и
 * такой участник не совпадал ни с чем и молча выпадал из выдачи. В списке
 * состава это значит, что администратор, набравший имя, видит «никого» и
 * заключает, что человека в группе нет: снять его, забанить или посмотреть
 * его роль он не может, а искать нечего — строки нет. В подсказке упоминаний
 * тот же участник просто не предлагается.
 *
 * Сказать «никого не нашлось» честно можно только вместе с числом тех, до
 * чьего имени поиск не смог добраться, — тем же доводом в v4.32.581 завели
 * подпись под выдачей поиска по сообщениям.
 *
 * Почему пустой запрос считается по-разному. В списке состава пустая строка
 * означает «я не ищу»: список показывается целиком, вместе с участниками, чьё
 * имя не прочиталось, — они на экране есть, у них своя пометка, и их можно
 * нажать. В подсказке упоминаний пустого «не ищу» не бывает: она открыта
 * ровно потому, что человек набрал «@», и любой её вид — это запрос. Имя,
 * которого мы не знаем, вставить в текст нельзя: подстановка короткого ключа
 * дала бы упоминание, которое у получателя не совпадёт с его именем и никого
 * не уведомит.
 *
 * Единственная зависимость — чистое правило русских окончаний.
 */
import { pluralRu } from '../storage/ruPlural';

/** Ровно те поля участника, которые нужны поиску по имени. */
export interface SearchableMember {
  displayName?: string | null;
  displayNameUnreadable?: boolean;
}

/** Что нашлось и сколько имён поиск не смог прочитать. */
export type MemberSearch<T> = {
  matched: readonly T[];
  unreadable: number;
};

function nameOf(member: SearchableMember): string {
  return typeof member.displayName === 'string' ? member.displayName : '';
}

function nameMatches(member: SearchableMember, needle: string): boolean {
  return nameOf(member).toLowerCase().includes(needle);
}

/**
 * Поиск в списке состава.
 *
 * Пустой запрос — это «не ищу»: состав отдаётся как есть, тем же массивом,
 * и жаловаться не на что.
 */
export function searchMembersByName<T extends SearchableMember>(
  members: readonly T[],
  query: string
): MemberSearch<T> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { matched: members, unreadable: 0 };
  const matched: T[] = [];
  let unreadable = 0;
  for (const m of members) {
    if (m.displayNameUnreadable === true) {
      unreadable += 1;
      continue;
    }
    if (nameMatches(m, needle)) matched.push(m);
  }
  return { matched, unreadable };
}

/**
 * Кандидаты в подсказку упоминаний.
 *
 * Участник с непрочитанным именем исключается всегда, даже при пустом
 * запросе: имени у нас нет, а вставлять вместо него короткий ключ значит
 * собрать упоминание, которое никого не уведомит. По той же причине — но уже
 * без всякой жалобы — не предлагается и тот, кто имени просто не задавал:
 * подставлять нечего, и жаловаться не на что.
 */
export function mentionableMembers<T extends SearchableMember>(
  members: readonly T[],
  query: string
): MemberSearch<T> {
  const needle = query.trim().toLowerCase();
  const matched: T[] = [];
  let unreadable = 0;
  for (const m of members) {
    if (m.displayNameUnreadable === true) {
      unreadable += 1;
      continue;
    }
    if (nameOf(m).length === 0) continue;
    if (needle.length === 0 || nameMatches(m, needle)) matched.push(m);
  }
  return { matched, unreadable };
}

/** Родительный падеж числа участников: «1 участника», «2 участников». */
function memberWordForCount(n: number): string {
  return pluralRu(n, 'участника', 'участников', 'участников');
}

/** Подпись под поиском по составу. null — жаловаться не на что. */
export function memberSkippedNotice(unreadable: number): string | null {
  const n = Math.trunc(unreadable);
  if (!Number.isFinite(n) || n <= 0) return null;
  const tail = n === 1 ? 'его не находит' : 'их не находит';
  return `Имя ${n} ${memberWordForCount(n)} не удалось прочитать — поиск по имени ${tail}`;
}

/** Подпись под подсказкой упоминаний. null — жаловаться не на что. */
export function mentionSkippedNotice(unreadable: number): string | null {
  const n = Math.trunc(unreadable);
  if (!Number.isFinite(n) || n <= 0) return null;
  const tail = n === 1 ? 'его' : 'их';
  return `Имя ${n} ${memberWordForCount(n)} не удалось прочитать — упомянуть ${tail} нельзя`;
}
