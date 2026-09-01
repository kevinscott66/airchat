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
