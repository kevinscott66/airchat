/**
 * Память о предпросмотрах ссылок: что уже узнали и когда перестать спрашивать
 * (v4.32.540).
 *
 * Дефект первый — карточка пропадала навсегда от собственного ухода с экрана.
 * Загрузка отменялась при размонтировании карточки, `fetch` бросал отмену, а
 * обработчик записывал в память «у этой ссылки предпросмотра нет». Достаточно
 * было пролистать переписку мимо ссылки быстрее, чем за шесть секунд, — и до
 * перезапуска приложения карточка по этому адресу не появлялась уже нигде:
 * ни в этой переписке, ни в группе, ни в ленте. Тот же приговор выносила
 * любая мимолётная сетевая ошибка и любой ответ не-200.
 *
 * Отмена — это не сведение об адресе, а сведение о нас: мы просто не стали
 * ждать. Поэтому запоминать её нельзя вовсе. Сетевой сбой — сведение слабое:
 * его помнят как попытку, и лишь когда попытки кончаются, ссылка считается
 * бесперспективной. Иначе список бил бы по сети при каждом появлении строки
 * на экране.
 *
 * Дефект второй — память не имела предела. Обычная `Map` по адресу росла всё
 * время работы приложения: заголовок, описание и адрес картинки на каждую
 * ссылку, когда-либо попавшуюся на глаза. Здесь предел есть, и вытесняется
 * то, к чему дольше всего не обращались.
 *
 * Дефект третий — страницу читали целиком, каким бы ни был её размер.
 * `tooLargeToRead` отсекает ответ по заявленному размеру ДО чтения тела.
 *
 * Модуль без импортов и без часов: «давность» считается обращениями, а не
 * временем, поэтому поведение воспроизводится в тестах точно.
 */

export interface LinkPreviewCard {
  title: string;
  description: string;
  domain: string;
  image: string | null;
}

/**
 * Что известно про адрес.
 *
 * `card` — карточка есть; `none` — страница прочитана, показывать нечего;
 * `unknown` — ещё не знаем.
 */
export type LinkPreviewKnown =
  | { kind: 'card'; card: LinkPreviewCard }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** Сколько адресов помнить. */
export const LINK_PREVIEW_CAPACITY = 120;

/** Сколько сетевых неудач подряд терпеть, прежде чем считать адрес пустым. */
export const LINK_PREVIEW_MAX_ATTEMPTS = 3;

/** Предел размера страницы, которую вообще имеет смысл читать ради карточки. */
export const LINK_PREVIEW_MAX_BYTES = 512 * 1024;

/**
 * Сказал ли ответ заранее, что читать его не стоит.
 *
 * Заголовок могут не прислать вовсе — тогда предел не проверить, и это
 * остаётся рядом: `fetch` в React Native не даёт читать тело по кускам.
 */
export function tooLargeToRead(contentLength: string | null | undefined): boolean {
  if (contentLength === null || contentLength === undefined) return false;
  const n = Number(contentLength);
  if (!Number.isFinite(n) || n < 0) return false;
  return n > LINK_PREVIEW_MAX_BYTES;
}

/**
 * Разбор страницы в карточку: заголовок, описание, картинка.
 *
 * v4.32.615. Раньше разбор жил прямо в компоненте и состоял из четырёх
 * выражений вида
 * `/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i`.
 * Два жадных `[^>]+` подряд дают откат, который растёт быстрее квадрата: на
 * странице из повторяющегося `<meta property="og:title" ` без единого `>`
 * замер на V8 дал 5 КБ — 0,12 с, 10 КБ — 0,9 с, 21 КБ — 7,5 с, 42 КБ — 60 с.
 * Страницу выбирает отправитель ссылки, поэтому это не «медленно», а способ
 * повесить поток разбора намертво — и для своих исходящих ссылок он работает
 * всегда, независимо от настройки предпросмотра входящих.
 *
 * Здесь теги вынимаются посимвольным поиском (`indexOf`), а внутри тега
 * ищется только короткий атрибут. Ни одного выражения, у которого откат
 * зависит от длины страницы.
 *
 * Чего этот разбор НЕ чинит: тело уже прочитано целиком. `tooLargeToRead`
 * смотрит на заявленный `content-length`, а ответ без него (chunked) читается
 * до конца или до шестисекундного обрыва — `fetch` в React Native не даёт
 * читать тело по кускам. Поэтому здесь стоит второй предел: сколько бы ни
 * пришло, разбирается только первый LINK_PREVIEW_MAX_BYTES знаков.
 */

/** Сколько тегов <meta> просматривать: у настоящих страниц их десятки. */
const META_TAG_LIMIT = 500;

/** Сколько знаков заголовка `<title>` брать до обрезки под карточку. */
const TITLE_SCAN_MAX = 512;

/**
 * Атрибуты берутся по отдельности и по границе слова, иначе `itemprop="name"`
 * сойдёт за `name=`, а `?name=og:title` внутри адреса картинки — за ключ.
 */
const KEY_ATTR = /(?:^|[\s"'/])(?:property|name)\s*=\s*["']([^"']*)["']/i;
const CONTENT_ATTR = /(?:^|[\s"'/])content\s*=\s*["']([^"']*)["']/i;

/** Начинается ли по индексу `i` тег с именем `name` (за именем — не буква). */
function tagStartsAt(low: string, i: number, name: string): boolean {
  const c = low.charCodeAt(i + name.length);
  // '>' или '/' или пробельный; NaN (конец строки) — не тег.
  return c === 62 || c === 47 || c <= 32;
}

/** Все теги <meta> целиком, посимвольным поиском и без отката. */
function metaTags(html: string): string[] {
  const out: string[] = [];
  const low = html.toLowerCase();
  let i = low.indexOf('<meta');
  while (i !== -1 && out.length < META_TAG_LIMIT) {
    const end = html.indexOf('>', i);
    if (end === -1) break;
    if (tagStartsAt(low, i, '<meta')) out.push(html.slice(i, end + 1));
    i = low.indexOf('<meta', end + 1);
  }
  return out;
}

/** Текст первого непустого <title>. */
function titleText(html: string): string | null {
  const low = html.toLowerCase();
  let i = low.indexOf('<title');
  while (i !== -1) {
    const gt = html.indexOf('>', i);
    if (gt === -1) return null;
    if (tagStartsAt(low, i, '<title')) {
      const close = low.indexOf('</title', gt + 1);
      const cap = gt + 1 + TITLE_SCAN_MAX;
      const text = html.slice(gt + 1, close === -1 ? cap : Math.min(close, cap));
      if (text.trim().length > 0) return text;
    }
    i = low.indexOf('<title', gt + 1);
  }
  return null;
}

/**
 * Собрать карточку из тела страницы. `pageUrl` нужен для домена и для
 * относительного адреса картинки. Возвращает null, если заголовка нет:
 * карточка без заголовка — пустая полоса под сообщением.
 */
export function parseLinkPreviewHtml(html: string, pageUrl: string): LinkPreviewCard | null {
  const doc = html.length > LINK_PREVIEW_MAX_BYTES ? html.slice(0, LINK_PREVIEW_MAX_BYTES) : html;
  let ogTitle: string | null = null;
  let ogDesc: string | null = null;
  let metaDesc: string | null = null;
  let ogImage: string | null = null;
  for (const tag of metaTags(doc)) {
    const key = KEY_ATTR.exec(tag)?.[1].trim().toLowerCase();
    if (key !== 'og:title' && key !== 'og:description' && key !== 'og:image' && key !== 'description') continue;
    const value = CONTENT_ATTR.exec(tag)?.[1];
    if (value === undefined || value.length === 0) continue;
    if (key === 'og:title') { if (ogTitle === null) ogTitle = value; }
    else if (key === 'og:description') { if (ogDesc === null) ogDesc = value; }
    else if (key === 'description') { if (metaDesc === null) metaDesc = value; }
    else if (ogImage === null) ogImage = value;
  }
  const title = (ogTitle ?? titleText(doc) ?? '').trim().slice(0, 100);
  if (title.length === 0) return null;
  const description = (ogDesc ?? metaDesc ?? '').trim().slice(0, 160);
  let domain = '';
  try {
    domain = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch { /* адрес уже показан человеку как есть — строка домена просто пустая */ }
  let image: string | null = null;
  if (ogImage !== null) {
    try {
      image = ogImage.startsWith('http') ? ogImage : new URL(ogImage, pageUrl).href;
    } catch { /* относительный адрес не разобрался — карточка будет без картинки */ }
  }
  return { title, description, domain, image };
}

interface Entry {
  settled: LinkPreviewCard | null | undefined;
  attempts: number;
}

export interface LinkPreviewStore {
  /** Что уже известно про адрес. Обращение освежает запись. */
  get(url: string): LinkPreviewKnown;
  /** Идти ли в сеть: неизвестное и не исчерпавшее попытки. */
  shouldFetch(url: string): boolean;
  /** Страница прочитана: карточка или явное «нечего показывать». */
  remember(url: string, card: LinkPreviewCard | null): void;
  /** Сетевая неудача. Возвращает `true`, если попытки на этом кончились. */
  noteFailure(url: string): boolean;
  /** Забыть адрес — например, когда настройка приватности изменилась. */
  forget(url: string): void;
  /** Сколько адресов помнится. Для тестов и отладки. */
  size(): number;
}

/**
 * Хранилище предпросмотров.
 *
 * Порядок вытеснения — по последнему обращению: `Map` в JS хранит ключи в
 * порядке вставки, поэтому запись при чтении переставляется в конец.
 */
export function createLinkPreviewStore(
  capacity: number = LINK_PREVIEW_CAPACITY,
  maxAttempts: number = LINK_PREVIEW_MAX_ATTEMPTS,
): LinkPreviewStore {
  const limit = Number.isInteger(capacity) && capacity > 0 ? capacity : LINK_PREVIEW_CAPACITY;
  const tries = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : LINK_PREVIEW_MAX_ATTEMPTS;
  const map = new Map<string, Entry>();

  const touch = (url: string): Entry | undefined => {
    const e = map.get(url);
    if (e === undefined) return undefined;
    map.delete(url);
    map.set(url, e);
    return e;
  };

  const put = (url: string, entry: Entry): void => {
    map.delete(url);
    map.set(url, entry);
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  };

  return {
    get(url: string): LinkPreviewKnown {
      const e = touch(url);
      if (e === undefined || e.settled === undefined) return { kind: 'unknown' };
      return e.settled === null ? { kind: 'none' } : { kind: 'card', card: e.settled };
    },
    shouldFetch(url: string): boolean {
      const e = touch(url);
      if (e === undefined) return true;
      if (e.settled !== undefined) return false;
      return e.attempts < tries;
    },
    remember(url: string, card: LinkPreviewCard | null): void {
      put(url, { settled: card, attempts: 0 });
    },
    noteFailure(url: string): boolean {
      const prev = map.get(url);
      if (prev !== undefined && prev.settled !== undefined) return true;
      const attempts = (prev?.attempts ?? 0) + 1;
      const done = attempts >= tries;
      // Исчерпанные попытки — это «нечего показывать», а не «карточка есть»:
      // строка на экране остаётся текстом, и сеть больше не тревожится.
      put(url, done ? { settled: null, attempts } : { settled: undefined, attempts });
      return done;
    },
    forget(url: string): void {
      map.delete(url);
    },
    size(): number {
      return map.size;
    },
  };
}
