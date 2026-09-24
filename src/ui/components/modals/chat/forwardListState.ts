/**
 * Что показать в окне пересылки, когда список пуст (v4.32.879).
 *
 * Пустых списков четыре разных, а надпись была одна — «Нет контактов». Она
 * врала трижды: пока список ещё читается, когда чтение отказало и когда поиск
 * ничего не нашёл. Хуже всего второе: отказ базы выглядел как «переслать
 * некому», и человек уходил из окна, хотя чаты на месте.
 */
export type ForwardLoad = 'loading' | 'ready' | 'failed';

export type ForwardEmptyKind = 'loading' | 'failed' | 'not-found' | 'empty';

export const FWD_LOADING_TEXT = 'Загружаем…';
export const FWD_FAILED_TEXT = 'Не удалось прочитать список чатов.\nНажмите, чтобы повторить';
export const FWD_NOT_FOUND_TEXT = 'Ничего не нашлось';
export const FWD_EMPTY_TEXT = 'Переслать некому: нет ни контактов, ни групп';

/**
 * Разбор пустоты. Отказ важнее всего: он единственный не про содержимое, а про
 * то, что содержимого мы не знаем.
 */
export function forwardEmptyKind(
  load: ForwardLoad,
  hasAnyChats: boolean,
  query: string,
): ForwardEmptyKind {
  if (load === 'failed') return 'failed';
  if (load === 'loading') return 'loading';
  if (query.trim() && hasAnyChats) return 'not-found';
  return 'empty';
}

export function forwardEmptyText(kind: ForwardEmptyKind): string {
  switch (kind) {
    case 'loading': return FWD_LOADING_TEXT;
    case 'failed': return FWD_FAILED_TEXT;
    case 'not-found': return FWD_NOT_FOUND_TEXT;
    default: return FWD_EMPTY_TEXT;
  }
}
