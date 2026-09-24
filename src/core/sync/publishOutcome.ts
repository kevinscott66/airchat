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
 * Шесть исходов попытки:
 *  - `skipped-offline`    — рассылку не начинали, сети нет;
 *  - `no-recipients`      — рассылать некому, контактов нет;
 *  - `unknown-recipients` — кому рассылать, выяснить не удалось;
 *  - `failed`             — отправили всем, не дошло никому;
 *  - `partial`            — дошло не до всех;
 *  - `complete`           — дошло до всех.
 *
 * `unknown-recipients` появился в v4.32.752. Список контактов читается из базы,
 * и отказ чтения приходил сюда неотличимым от пустого списка — то есть как
 * `no-recipients`, судьба которого «повторять нечего». Пост оставался в своей
 * ленте с пометкой «только у вас», хотя контакты никуда не делись и не узнали
 * о нём никогда: следующей попытки у записи уже не было.
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
  | 'unknown-recipients'
  | 'failed'
  | 'partial'
  | 'complete';

/** Что делать с записью после этой попытки. */
export type PublishDisposition = 'queue-retry' | 'local-only' | 'done';

/**
 * Разобрать исход попытки. `attempted` — пробовали ли вообще (без сети не
 * пробуем: ответ известен заранее, а сетевой стек будет молотить впустую).
 * `total` — сколько адресатов было, `success` — до скольких дошло.
 * `recipientsUnknown` (v4.32.752) — список адресатов не прочитался; тогда
 * `total: 0` означает не «некому», а «неизвестно кому», и молчать об этом
 * нельзя: в ноль адресатов не отправляют ни одного из настоящих.
 *
 * `recipientsMissing` (v4.32.846) — то же самое, но не про весь список, а про
 * несколько строк в нём. Справочник читается по одной записи, и та, которую
 * не удалось расшифровать, пропускается: вычеркнуть её из указателя нельзя,
 * контакт тогда не вернуть ничем. Пропуск верный, а вот последствие — нет:
 * `total` считался по уцелевшим, `success === total` сходилось, и рассылка
 * объявляла себя дошедшей до всех, не назвав нескольких адресатов вовсе.
 */
export function classifyBroadcast(
  attempted: boolean,
  total: number,
  success: number,
  recipientsUnknown = false,
  recipientsMissing = 0,
): BroadcastAttempt {
  if (!attempted) return 'skipped-offline';
  if (recipientsUnknown) return 'unknown-recipients';
  if (recipientsMissing > 0) {
    // Адресаты есть, и часть из них этот проход даже не назвала. Полной такая
    // рассылка не бывает; `no-recipients` тем более неверен — повторять есть
    // ради кого, и очередь обязана это узнать.
    if (success > 0) return 'partial';
    return total > 0 ? 'failed' : 'unknown-recipients';
  }
  if (total <= 0) return 'no-recipients';
  if (success <= 0) return 'failed';
  return success < total ? 'partial' : 'complete';
}

/** Судьба записи по исходу попытки. */
export function dispositionOf(attempt: BroadcastAttempt): PublishDisposition {
  switch (attempt) {
    case 'skipped-offline':
    case 'unknown-recipients':
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

/**
 * Что сказать человеку о его записи (v4.32.739).
 *
 * `PublishDisposition` отвечает на вопрос «что делать дальше» и до этой версии
 * был единственным разбором исхода. Человеку же нужен другой ответ, и в двух
 * местах он расходился с первым:
 *
 *  - `local-only` показывался как «отправлено». Отправлять было некому, и
 *    docblock этого модуля прямо запрещал так говорить — но запрет остался
 *    словами: `isDelivered` не звали ниоткуда, кроме собственного теста.
 *  - `queue-retry` показывался как «отправлено» и тогда, когда очередь запись
 *    не приняла. Очередь — единственный повтор у публикации; её отказ значит,
 *    что до недоставленных контактов запись не дойдёт уже никогда, и сказать
 *    об этом некому, кроме как здесь.
 *
 * `queueAccepted` спрашивается только у `queue-retry`: у остальных исходов
 * очереди нет и быть не должно.
 */
export type PublishReport = 'delivered' | 'local-only' | 'queued' | 'stranded';

export function reportOf(attempt: BroadcastAttempt, queueAccepted: boolean): PublishReport {
  switch (dispositionOf(attempt)) {
    case 'done':
      return 'delivered';
    case 'local-only':
      return 'local-only';
    case 'queue-retry':
      return queueAccepted ? 'queued' : 'stranded';
  }
}
