/**
 * Судьба уже сохранённой записи после попытки разослать её (v4.32.554).
 *
 * Пост в ленте пишется в свою базу первым, а рассылка контактам идёт вторым
 * шагом. До этой версии публикация начиналась с проверки сети и без интернета
 * обрывалась ещё до записи: набранный текст с фотографиями исчезал целиком,
 * хотя рядом уже лежала очередь повторов, заведённая ровно на этот случай.
 * Репост терялся так же, а его очередь вдобавок не умела пересобрать
 * репост-конверт и отправляла бы обычный пост.
 *
 * Ошибка тут в том, что «рассылка не состоялась» сваливали в одну кучу с
 * «публиковать нельзя». Это разные вещи, и разводит их этот модуль: сначала
 * называем, чем закончилась попытка рассылки, и только потом — что делать с
 * записью, которая в базе уже есть.
 *
 * Пять исходов попытки:
 *  - `skipped-offline` — рассылку не начинали, сети нет;
 *  - `no-recipients`   — рассылать некому, контактов нет;
 *  - `failed`          — отправили всем, не дошло никому;
 *  - `partial`         — дошло не до всех;
 *  - `complete`        — дошло до всех.
 *
 * И три судьбы записи: `queue-retry` (лежит в очереди, попытки продолжатся),
 * `local-only` (адресатов нет, повторять нечего) и `done` (доставлена).
 * `local-only` и `done` внешне похожи — в обоих случаях очередь пуста, — но
 * различать их обязан вызывающий: «никто не получил, потому что некому» нельзя
 * показывать человеку как «отправлено».
 */

/** Чем закончилась попытка разослать уже сохранённую запись. */
export type BroadcastAttempt =
  | 'skipped-offline'
  | 'no-recipients'
  | 'failed'
  | 'partial'
  | 'complete';

/** Что делать с записью после этой попытки. */
export type PublishDisposition = 'queue-retry' | 'local-only' | 'done';

/**
 * Разобрать исход попытки. `attempted` — пробовали ли вообще (без сети не
 * пробуем: ответ известен заранее, а сетевой стек будет молотить впустую).
 * `total` — сколько адресатов было, `success` — до скольких дошло.
 */
export function classifyBroadcast(
  attempted: boolean,
  total: number,
  success: number,
): BroadcastAttempt {
  if (!attempted) return 'skipped-offline';
  if (total <= 0) return 'no-recipients';
  if (success <= 0) return 'failed';
  return success < total ? 'partial' : 'complete';
}

/** Судьба записи по исходу попытки. */
export function dispositionOf(attempt: BroadcastAttempt): PublishDisposition {
  switch (attempt) {
    case 'skipped-offline':
    case 'failed':
    case 'partial':
      return 'queue-retry';
    case 'no-recipients':
      return 'local-only';
    case 'complete':
      return 'done';
  }
}

/** Нужно ли класть запись в очередь повторов. */
export function needsRetryQueue(attempt: BroadcastAttempt): boolean {
  return dispositionOf(attempt) === 'queue-retry';
}

/**
 * Дошла ли запись до всех, кому предназначалась. Отсутствие адресатов — не
 * доставка: очередь пуста, но и «отправлено» говорить не о чем.
 */
export function isDelivered(attempt: BroadcastAttempt): boolean {
  return dispositionOf(attempt) === 'done';
}
