/**
 * storagePressure — «на устройстве кончилось место» как событие для экрана.
 *
 * v4.32.126 завёл наблюдателя: писатели в SQLite ловят известные подписи
 * переполнения и зовут notifyStoragePressure, а UI может подписаться и
 * показать человеку предупреждение. Подписаться было некому — ни одного
 * вызова subscribeStoragePressure во всём приложении не появилось, и
 * v4.32.300 добавляет и подписчика, и недостающие места публикации.
 *
 * Почему это важнее, чем звучит: запись сообщения в базу ошибку НЕ бросает —
 * она пишет строку в журнал и возвращает управление как ни в чём не бывало.
 * На переполненном диске человек отправляет сообщение, видит его в переписке
 * (список рисуется из памяти), выходит из чата — и сообщения нет. Ни ошибки,
 * ни пометки «не отправлено»: оно просто исчезает, и так каждый раз.
 *
 * Правила разбора и показа лежат отдельно от SQLite и React: подписи ошибок
 * приходят от разных платформ, и проверять их надо тестами, а не на
 * переполненном телефоне.
 */

/** disk_full — места нет; io_error — часто тот же диск, но через ошибку ввода-вывода. */
export type StoragePressureKind = 'disk_full' | 'io_error';

/**
 * Ошибка SQLite — это про нехватку места?
 *
 * Коды разъезжаются по платформам: одна и та же ситуация на Android
 * показывается как SQLITE_FULL, на iOS — текстом «database or disk is full», а
 * во внешнем хранилище — как ошибка ввода-вывода. Всё, что не опознано,
 * остаётся обычной ошибкой: показывать человеку «кончилось место», когда его
 * не кончилось, — хуже, чем промолчать.
 */
export function classifyStorageError(e: unknown): StoragePressureKind | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (/SQLITE_FULL|disk is full|no space left|ENOSPC/i.test(msg)) return 'disk_full';
  if (/SQLITE_IOERR|disk I\/O|EIO\b/i.test(msg)) return 'io_error';
  return null;
}

/** Через сколько предупреждение может появиться снова после закрытия. */
export const PRESSURE_SNOOZE_MS = 10 * 60_000;

/**
 * Что сейчас на экране и когда предупреждение закрыли руками.
 * `shown === null` — предупреждения не видно.
 */
export type PressureState = {
  shown: StoragePressureKind | null;
  dismissedAt: number | null;
};

export const NO_PRESSURE: PressureState = { shown: null, dismissedAt: null };

/**
 * Пришло событие переполнения.
 *
 * Событий будет много: на полном диске падает каждая запись, а пишет
 * приложение постоянно. Поэтому повторы ничего не меняют — предупреждение уже
 * висит; а закрытое рукой молчит PRESSURE_SNOOZE_MS, иначе оно возвращалось бы
 * тут же и закрыть его было бы нельзя вовсе.
 *
 * disk_full важнее io_error: если пришло и то и другое, показывается прямое
 * «место кончилось», а не расплывчатая ошибка чтения-записи.
 */
export function onPressureEvent(
  state: PressureState,
  kind: StoragePressureKind,
  now: number
): PressureState {
  if (state.dismissedAt != null && now - state.dismissedAt < PRESSURE_SNOOZE_MS) return state;
  if (state.shown === 'disk_full' && kind === 'io_error') return { shown: 'disk_full', dismissedAt: null };
  return { shown: kind, dismissedAt: null };
}

/** Человек закрыл предупреждение. */
export function onPressureDismiss(state: PressureState, now: number): PressureState {
  return { shown: null, dismissedAt: now };
}
