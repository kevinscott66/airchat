/**
 * autoDeletePolicy — значение автоудаления по умолчанию для новых разговоров.
 *
 * v4.32.236. До этой версии ключ `default_auto_delete_ms` писался и читался
 * ТОЛЬКО экраном настроек — чтобы показать выбранное значение обратно. Ни один
 * разговор его не получал: человек выбирал «1 день», видел «1 день» в
 * настройках, а сообщения не удалялись никогда.
 *
 * Модуль без импортов: решение «ставить ли таймер этому разговору» ведёт к
 * удалению переписки, поэтому оно должно проверяться тестами, а не only
 * читаться глазами в середине SQLite-транзакции (см. groupSendPolicy.ts).
 */

/**
 * Имя записи в kv. Стоит рядом с разборщиком намеренно: в v4.32.483 оно
 * набиралось строкой в трёх местах, и одно из них читало запись мимо профиля.
 */
export const DEFAULT_AUTO_DELETE_KEY = 'default_auto_delete_ms';

/** Минимум, который предлагает экран настроек. */
export const MIN_AUTO_DELETE_MS = 60_000;
/** Год — выше этого значение считается мусором. */
export const MAX_AUTO_DELETE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Разбирает значение из kv. null — «не задано»/мусор.
 *
 * Нижняя граница обязательна: испорченный kv со значением «1» превратился бы
 * в таймер на миллисекунду и стёр бы переписку сразу после первого сообщения.
 */
export function parseAutoDeleteMs(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_AUTO_DELETE_MS || n > MAX_AUTO_DELETE_MS) return null;
  return n;
}

export type DefaultApplicability = {
  /** Значение по умолчанию из настроек; null — выключено. */
  defaultMs: number | null;
  /** Строка разговора уже существует. */
  exists: boolean;
  /**
   * Текущий таймер разговора. null — человек ничего не выбирал; 0 — выбрал
   * «Выкл» явно. Различать обязательно, иначе настройка возвращала бы таймер,
   * который только что сняли вручную.
   */
  currentMs: number | null;
  /** Время последнего сообщения; 0/null — сообщений ещё не было. */
  lastMessageAt: number | null;
};

/**
 * Ставить ли значение по умолчанию.
 *
 * «Новый разговор» — это разговор без сообщений, а не отсутствие строки:
 * строка появляется раньше первого сообщения, если контакт закрепили,
 * заархивировали, заглушили или начали писать ему черновик.
 */
export function shouldApplyDefaultAutoDelete({
  defaultMs,
  exists,
  currentMs,
  lastMessageAt,
}: DefaultApplicability): boolean {
  if (defaultMs == null || defaultMs <= 0) return false;
  if (!exists) return true;
  if (currentMs != null) return false;
  return !lastMessageAt;
}
