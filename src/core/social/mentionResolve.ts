/**
 * Кому принадлежит `@имя` (v4.32.605).
 *
 * Упоминания в приложении писались только по отображаемому имени: подсказка в
 * группе подставляла `@displayName`, а нажатие искало участника сравнением
 * `m.displayName.toLowerCase()`. Канонический username (`identity/username`,
 * `[a-z0-9_]{3,32}`) при этом существует, рассылается контактам в конверте
 * профиля (`profileEnvelope.username`) и хранится в адресной книге
 * (`Contact.peerUsername`) — но ни одно нажатие на `@username` никуда не вело.
 * То есть единственный неизменяемый адрес человека в приложении не работал.
 *
 * Здесь оба имени сведены в одно правило с явным приоритетом:
 *
 * 1. Канонический username — сравнивается ПОСЛЕ приведения обеими сторонами
 *    (`normalizeUsername`), поэтому `@Bob`, `@bob` и `bob` — одно и то же имя.
 * 2. Отображаемое имя — сравнивается без учёта регистра и краевых пробелов.
 *
 * Порядок именно такой: username уникален по построению — но только В
 * РЕЕСТРЕ. Сюда он приходит не оттуда: `Contact.peerUsername` заполняется
 * прямо из конверта профиля собеседника (contacts.ts) и с реестром не
 * сверяется никогда. Значит любой контакт может назваться чужим именем.
 *
 * v4.32.615: поэтому и совпадение по username возвращается ЦЕЛИКОМ, а не
 * первым попавшимся. Здесь стоял `slice(0, 1)` с объяснением «одно имя — один
 * аккаунт, спрашивать нечего», и он глушил ровно ту защиту, ради которой
 * написан весь модуль: вызывающий считает `Set` по ключу и отвечает
 * «неоднозначно» при двух разных — но до этого счёта доезжал один элемент.
 * Достаточно было принять в контакты одного человека, назвавшего себя
 * `@alice`, чтобы нажатие на `@alice` уверенно вело к нему.
 *
 * Открыть карточку не того человека, кого упомянули, — хуже, чем сказать, что
 * имя неоднозначно.
 */
import { normalizeUsername } from '../identity/username';

export type MentionCandidate = {
  /** Канонический username, если он известен. */
  username?: string | null;
  /** Отображаемое имя — местная подпись или то, как человек назвал себя сам. */
  displayName?: string | null;
};

/** Имя из текста упоминания: `@Bob,` уже отрезан разбором (`text/entities`). */
function wanted(raw: string): string {
  return (raw.startsWith('@') ? raw.slice(1) : raw).trim();
}

/** Первое слово отображаемого имени — см. последнюю попытку в resolveMention. */
function firstWord(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  const space = trimmed.search(/\s/);
  return space > 0 ? trimmed.slice(0, space) : null;
}

function sameDisplayName(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.toLowerCase();
}

/**
 * Найти всех, к кому может относиться `@имя`.
 *
 * Пустой массив — никого не нашли. Массив из одного — можно открывать. Больше
 * одного — совпадение по отображаемому имени, и выбирать за человека нельзя.
 */
export function resolveMention<T extends MentionCandidate>(raw: string, candidates: readonly T[]): T[] {
  const name = wanted(raw);
  if (!name) return [];
  const canonical = normalizeUsername(name);
  if (canonical) {
    const byUsername = candidates.filter((c) => normalizeUsername(c.username) === canonical);
    // Дубли одной и той же записи из разных источников (своя подпись и
    // самоназвание одного контакта) вызывающего не смущают: он считает
    // различие по ключу, а не по числу строк.
    if (byUsername.length > 0) return byUsername;
  }
  const exact = candidates.filter((c) => sameDisplayName(c.displayName, name));
  if (exact.length > 0) return exact;
  // Отображаемое имя бывает из двух слов, а упоминание в тексте кончается на
  // первом же пробеле: подсказка вставляет «@Иван Петров», а нажимается
  // «@Иван». Поэтому последняя попытка — по первому слову имени. Она идёт
  // ПОСЛЕ точного совпадения: если в чате есть и «Иван», и «Иван Петров»,
  // «@Иван» — это Иван.
  return candidates.filter((c) => sameDisplayName(firstWord(c.displayName), name));
}
