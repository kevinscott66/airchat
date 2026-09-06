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
 * Порядок именно такой: username уникален по построению (его стережёт общий
 * реестр), а отображаемое имя не уникально ни в чём. Поэтому совпадение по
 * username закрывает вопрос, а совпадение по отображаемому имени может быть
 * не одно — и тогда мы возвращаем ВСЕ найденные, а не первое попавшееся.
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
    // Один канонический username принадлежит одному аккаунту. Если строк
    // с ним несколько — это одна и та же запись из разных источников,
    // и спрашивать тут нечего.
    if (byUsername.length > 0) return byUsername.slice(0, 1);
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
