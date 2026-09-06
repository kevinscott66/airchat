/**
 * Ссылки, теги и упоминания — одним разбором (v4.32.605).
 *
 * До этой версии правило «что в тексте является ссылкой» было записано
 * четырьмя разными выражениями:
 *
 * - лента (`ui/components/RichText`)  — `https?:\/\/[^\s<>[\]"'()]+`
 * - личные чаты (`chat-utils/parseText`) — `https?:\/\/[^\s]+`
 * - группы (`groups-utils/parseText`)    — `https?:\/\/[^\s]+|@[\wЀ-ӿ]+`
 * - «О себе» в профиле                   — `\S+:\/\/\S+`
 *
 * Расхождения были не косметические. Три следствия, каждое из которых человек
 * видит руками:
 *
 * 1. Точка и запятая после адреса попадали внутрь адреса. «зайди на
 *    https://example.com.» открывалось как `https://example.com.` — хост с
 *    точкой на конце, и переход не срабатывал. Ссылка выглядела рабочей и не
 *    была ей. Здесь хвостовая пунктуация отрезается, а закрывающая скобка —
 *    только если она лишняя: адреса вида `.../Foo_(bar)` встречаются чаще, чем
 *    кажется.
 * 2. Упоминание в личных чатах не разбиралось вовсе, а в ленте разбиралось, но
 *    вместе с точкой на конце (`@bob.` → имя «bob.»), и такое имя не совпадало
 *    ни с кем.
 * 3. `alice@bob.com` в группах считался упоминанием `@bob`. Граница слова
 *    проверяется здесь ровно так же, как её проверяет `social/mentions`, —
 *    иначе подсветка и счётчик упоминаний расходятся между собой.
 *
 * Разбор — чистая функция над строкой: он ничего не знает ни о теме, ни о том,
 * кто из имён кому принадлежит. Кто такой `@name`, отвечает
 * `social/mentionResolve`, а можно ли открыть адрес — `net/externalLink`.
 */

export type EntityKind = 'url' | 'hashtag' | 'mention';

export type TextEntity = {
  kind: EntityKind;
  /** Индекс первого символа в исходной строке. */
  start: number;
  /** Индекс за последним символом. */
  end: number;
  /** Кусок строки — ровно то, что увидит человек. */
  text: string;
};

/**
 * Буквы имени: латиница, кириллица, греческий и расширенная латиница.
 * Тот же набор, что был у ленты (`А-Яа-яЁёÀ-ÿ`) и у групп (`Ѐ-ӿ`),
 * сведённый воедино. Точки здесь нет намеренно — см. пункт 2 в заголовке.
 */
const NAME_BODY = '0-9A-Za-z_\\u00C0-\\u024F\\u0370-\\u04FF';

const ENTITY_RE = new RegExp(
  `(https?://[^\\s<>"'\`]+)|(#[${NAME_BODY}-]+)|(@[${NAME_BODY}]+)`,
  'g'
);

/** Символ, после которого `@` или `#` — часть слова, а не начало сущности. */
const WORD_CHAR = new RegExp(`[${NAME_BODY}]`);

/**
 * Хвостовая пунктуация: её ставят ПОСЛЕ адреса, а не внутри него.
 * Скобка разбирается отдельно — она бывает и частью адреса.
 */
const TRAILING = new Set([...'.,;:!?…«»„“”‘’\'"*_~<>']);

/** Сколько лишних закрывающих скобок в конце — столько и отрезать. */
function trimUrlEnd(url: string): string {
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (ch === undefined) break;
    if (TRAILING.has(ch)) { end -= 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const body = url.slice(0, end);
      let depth = 0;
      for (const c of body) {
        if (c === open) depth += 1;
        else if (c === ch) depth -= 1;
      }
      // depth < 0 — закрывающих больше, значит последняя не наша.
      if (depth < 0) { end -= 1; continue; }
    }
    break;
  }
  return url.slice(0, end);
}

/** Хвостовые дефисы тега — часть предложения, а не имени тега. */
function trimTagEnd(tag: string): string {
  let end = tag.length;
  while (end > 1 && tag[end - 1] === '-') end -= 1;
  return tag.slice(0, end);
}

/**
 * Найти в тексте ссылки, теги и упоминания. Возвращает непересекающиеся
 * сущности в порядке появления.
 */
export function findEntities(raw: string): TextEntity[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const found: TextEntity[] = [];
  ENTITY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTITY_RE.exec(raw)) !== null) {
    const start = m.index;
    const before = start > 0 ? raw[start - 1] : '';
    // Граница слова: `alice@bob.com` — почта, а не упоминание; `x#1` — не тег.
    if (before && WORD_CHAR.test(before)) continue;
    let text: string;
    let kind: EntityKind;
    if (m[1] !== undefined) { kind = 'url'; text = trimUrlEnd(m[1]); }
    else if (m[2] !== undefined) { kind = 'hashtag'; text = trimTagEnd(m[2]); }
    else { kind = 'mention'; text = m[3]; }
    // Отрезав хвост, можно остаться с одним знаком: `#-` или `https://`.
    if (text.length < 2) continue;
    if (kind === 'url' && !/^https?:\/\/[^/?#]/i.test(text)) continue;
    found.push({ kind, start, end: start + text.length, text });
    // Хвост, который мы отрезали, обязан вернуться в обычный текст.
    ENTITY_RE.lastIndex = start + text.length;
  }
  return found;
}

/** `@bob` → `bob`. Пустая строка, если имени нет. */
export function mentionNameOf(text: string): string {
  return text.startsWith('@') ? text.slice(1) : text;
}

/** `#тег` → `тег`. */
export function hashtagNameOf(text: string): string {
  return text.startsWith('#') ? text.slice(1) : text;
}

/**
 * Все адреса текста — ровно те, что подчёркнуты в самом сообщении (v4.32.605).
 *
 * Вкладка «Ссылки» в общих файлах собирала их своим выражением и забирала
 * точку в конце предложения: в списке лежал `https://example.com.`, а нажатие
 * в пузыре рядом открывало `https://example.com`.
 */
export function collectUrls(raw: string): string[] {
  const out: string[] = [];
  for (const e of findEntities(raw)) {
    if (e.kind === 'url') out.push(e.text);
  }
  return out;
}

/**
 * Все теги текста — ровно те, что нарисованы тегами (v4.32.605).
 *
 * Подсказки и «в тренде» собирались своим выражением: `#новости-дня` в тексте
 * рисовалось одним тегом, а в списке появлялось как `#новости`. Нажать на
 * такую подсказку значило искать не то, что видно на экране.
 */
export function collectHashtags(raw: string): string[] {
  const out: string[] = [];
  for (const e of findEntities(raw)) {
    if (e.kind === 'hashtag') out.push(e.text.toLowerCase());
  }
  return out;
}
