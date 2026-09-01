/**
 * Ответ поиска, который отличает «не нашлось» от «не получилось посмотреть».
 *
 * v4.32.548. По коду разбросаны функции вида `try { … } catch { return null; }`:
 * отказ базы отдаётся тем же `null`, что и честное отсутствие записи. Вызывающий
 * не различает их и говорит человеку «такой группы нет» там, где правда — «не
 * смогли прочитать». Это третий этаж той же ошибки, что v4.32.544 (нечитаемый
 * столбец переписывался пустотой) и v4.32.547 (нечитаемый ключ подменялся новой
 * личностью): неудачное ЧТЕНИЕ выдаётся за пустоту и на этом строится решение.
 *
 * Здесь же живёт правило сведения нескольких попыток: список в памяти мог
 * отстать от базы, поэтому спрашивают обоих. Найденное побеждает; но если хоть
 * один источник ОТКАЗАЛ, ответ «нет такого» запрещён — отказ важнее пустоты.
 *
 * Модуль намеренно без импортов.
 */

export type LookupResult<T> =
  | { state: 'found'; value: T }
  | { state: 'missing' }
  | { state: 'failed' };

export function foundResult<T>(value: T): LookupResult<T> {
  return { state: 'found', value };
}

export function missingResult<T>(): LookupResult<T> {
  return { state: 'missing' };
}

export function failedResult<T>(): LookupResult<T> {
  return { state: 'failed' };
}

/** Значение, если нашлось; `null` и на отсутствие, и на отказ. */
export function lookupValue<T>(result: LookupResult<T>): T | null {
  return result.state === 'found' ? result.value : null;
}

/** Можно ли честно сказать человеку «такого нет». */
export function isTrulyMissing<T>(result: LookupResult<T>): boolean {
  return result.state === 'missing';
}

/**
 * Свести несколько попыток в один ответ.
 *
 * Порядок важен: первое найденное побеждает — это самый свежий источник из
 * тех, что ответили. Если не нашлось нигде, но хоть кто-то отказал, ответ —
 * `failed`: сказать «нет такого» на неотвеченный вопрос было бы неправдой.
 */
export function firstFound<T>(results: ReadonlyArray<LookupResult<T>>): LookupResult<T> {
  for (const r of results) {
    if (r.state === 'found') return r;
  }
  for (const r of results) {
    if (r.state === 'failed') return r;
  }
  return { state: 'missing' };
}

/** Обёртка над значением, которое уже есть в памяти. */
export function fromNullable<T>(value: T | null | undefined): LookupResult<T> {
  return value === null || value === undefined ? { state: 'missing' } : { state: 'found', value };
}
