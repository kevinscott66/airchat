/**
 * Сетевой запрос со сроком на весь обмен, включая чтение тела (v4.32.614).
 *
 * Раньше эта обвязка была написана заново в пяти местах, и в двух из них —
 * облачной копии аккаунта и привязке слов к почте — таймер снимался, как
 * только пришли заголовки. Дальше `response.json()` читал тело уже без всякого
 * предела: сервер, отдавший первый килобайт и потом замолчавший, держал вызов
 * до разрыва соединения. У облачной копии это путь входа в аккаунт, а тело там
 * доходит до мегабайтов, так что «зависло навсегда» получалось буквально.
 *
 * Отсюда и устройство: тело читает переданная функция, и читает его ВНУТРИ, до
 * того как таймер снят. Вернуть наружу сам `Response` нельзя — тогда ошибка
 * повторится у первого же, кто прочитает тело после возврата.
 *
 * Не переехали сюда двое, и оба намеренно. `syncApi.fetchSigned`: там у каждой
 * ступени свой текст ошибки («не отвечает» отдельно от «нет соединения»), и
 * различает их вложенный `try` вокруг одного лишь `fetch`; свести это к общему
 * `onTimeout` значило бы потерять разницу, из-за которой человек видел общий
 * запасной текст вместо причины. `linkProofCheck.getText`: он работает не с
 * `Response`, а со своим узким описанием ответа — ровно затем, чтобы проверки
 * подставляли туда простой объект, не поднимая всей сетевой части.
 */

/** Своя реализация запроса — нужна проверкам и подстановке в них. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type TimedFetchOptions = {
  /** Срок на весь обмен: заголовки и тело вместе. */
  timeoutMs: number;
  /**
   * Чем заменить ошибку прерывания. Без этого наружу уйдёт то, что бросил
   * сам `fetch`, — обычно английский `AbortError`, непригодный для показа.
   */
  onTimeout?: () => Error;
  fetchImpl?: FetchLike;
};

export async function fetchWithDeadline<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  options: TimedFetchOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(() => controller?.abort(), options.timeoutMs);
  const call = options.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const response = await call(input, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    return await read(response);
  } catch (e) {
    if (controller?.signal.aborted && options.onTimeout) throw options.onTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
