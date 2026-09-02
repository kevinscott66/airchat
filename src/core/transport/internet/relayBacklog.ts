/**
 * Откуда relay начинает отдавать накопленное при подключении.
 *
 * v4.32.545. До этой версии подписка открывалась с `?since=10m` — то есть при
 * каждом подключении relay отдавал последние десять минут и ни секундой
 * больше. Для переподключения на ходу этого хватает, для «человек закрыл
 * приложение вечером и открыл утром» — нет: relay держит сообщения 12 часов,
 * из которых мы забирали десять минут, а остальные одиннадцать с половиной
 * часов молча выбрасывали. Так терялись и личные сообщения, и групповые, и
 * публикации ленты: они едут одним и тем же topic'ом.
 *
 * Здесь считается параметр `since` от отметки последнего принятого кадра.
 * Отметка своя у каждого DID и переживает перезапуск, поэтому «сколько нас не
 * было» — это настоящее время отсутствия, а не время с момента запуска.
 *
 * Модуль намеренно без импортов транспорта: `sinceParam` — чистая функция,
 * её и проверяют тесты, а хранение отметки живёт отдельными двумя функциями
 * рядом. Транспорт помечен `@stable` и хранилища не знает; отметка приходит в
 * него колбэком из координатора.
 */
import { kvGet, kvSet } from '../../storage/local';
import { log } from '../../logger';

/** Сколько relay (ntfy.sh free tier) держит сообщения. Просить больше бессмысленно. */
export const RELAY_RETENTION_MS = 12 * 60 * 60 * 1000;

/**
 * Нахлёст назад от отметки.
 *
 * Отметка ставится по времени кадра, а кадры приходят не строго по порядку, и
 * часы устройства с часами relay совпадают лишь примерно. Без нахлёста любое
 * такое расхождение — это потерянное сообщение, с нахлёстом — повторно
 * присланное; повтор дешёв, потому что вставка идемпотентна
 * (INSERT OR IGNORE + проверки на стороне получателя).
 */
export const BACKLOG_OVERLAP_MS = 60_000;

/** Значение `since` для случая «отметки нет»: забираем всё, что relay ещё держит. */
export const BACKLOG_FALLBACK = '12h';

/**
 * Значение параметра `?since=` для подписки.
 *
 * @param lastFrameAtMs отметка последнего принятого кадра (мс) или null
 * @param nowMs         текущее время (мс)
 *
 * Числовой ответ — unix-секунды: ntfy принимает и длительность, и метку
 * времени, но длительность пришлось бы пересчитывать из той же разницы,
 * теряя точность на округлении.
 */
export function sinceParam(lastFrameAtMs: number | null | undefined, nowMs: number): string {
  if (typeof lastFrameAtMs !== 'number' || !Number.isFinite(lastFrameAtMs) || lastFrameAtMs <= 0) {
    return BACKLOG_FALLBACK;
  }
  const floor = nowMs - RELAY_RETENTION_MS;
  // Отметка из будущего — это переведённые назад часы, а не будущее сообщение.
  // Обрезаем по «сейчас»: просить у relay то, чего ещё не было, нельзя.
  const start = Math.min(Math.max(lastFrameAtMs - BACKLOG_OVERLAP_MS, floor), nowMs);
  return String(Math.floor(start / 1000));
}

function key(myDid: string): string {
  return `relay_backlog_at:${myDid}`;
}

/** Отметка последнего принятого кадра для этого DID; null, если её ещё нет. */
export async function loadBacklogWatermark(myDid: string): Promise<number | null> {
  try {
    const raw = await kvGet(key(myDid));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) {
    log.warn('relay_backlog_load_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function saveBacklogWatermark(myDid: string, atMs: number): Promise<void> {
  try {
    await kvSet(key(myDid), String(Math.floor(atMs)));
  } catch (e) {
    log.warn('relay_backlog_save_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Как часто отметка уходит в базу.
 *
 * Кадры приходят пачкой — при разборе накопленного их могут быть десятки
 * подряд, и писать базу на каждый значит писать её десятки раз ради одного
 * числа. Потеря последних секунд при внезапном завершении ничего не стоит:
 * нахлёст всё равно шире.
 */
export const WATERMARK_FLUSH_MS = 10_000;
