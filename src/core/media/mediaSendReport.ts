/**
 * mediaSendReport — что сказать человеку, когда вложение к сообщению не
 * загрузилось.
 *
 * v4.32.569. Личное сообщение с фотографиями уходило собеседнику даже тогда,
 * когда не загрузилась НИ ОДНА из них. Отправка складывала удачные ссылки в
 * список и молча выбрасывала неудачные, ни разу не сравнив его длину с числом
 * выбранных файлов. Человек видел свой пузырь с подписью — и был уверен, что
 * фотография ушла; если подписи не было, пузырь оставался пустым. Собеседник
 * не получал ничего. Повторить отправку было нельзя: файлы из выбора уже
 * пропали, а о том, что что-то не сложилось, не сообщалось нигде.
 *
 * Причина отказа при этом известна — `uploadMediaToCid` возвращает
 * `oversize` или `failed`, — но личный путь превращал её в `null` ещё до
 * возврата и терял. Остальные пути так не делают: видео, документы и
 * вложения в группах давно считают неудачи и показывают отдельный текст про
 * превышенный размер. Личная переписка была единственным исключением.
 *
 * Правило простое: сообщение существует ради вложений. Не загрузилось ни
 * одного — сообщение не отправляется вовсе, а подпись остаётся в поле ввода,
 * чтобы отправить ещё раз. Загрузилась часть — сообщение уходит, но человеку
 * говорят, сколько именно вложений в нём.
 *
 * Импорт один — подпись предела: число «8 МБ» в отчёте обязано читаться так
 * же, как в отказе рядом. Ни сети, ни файловой системы, ни шифрования: подсчёт
 * и выбор текста проверяются отдельно от них.
 */

import { formatLimit } from './uploadRoute';

/** Почему одно вложение не загрузилось (см. MediaUploadResult). */
export type MediaUploadFailure = 'oversize' | 'failed';

export type MediaUploadTally = {
  total: number;
  sent: number;
  oversize: number;
  failed: number;
};

export type MediaSendVerdict =
  /** Отправлять. `warn` — текст для человека, если ушло не всё. */
  | { kind: 'send'; warn: string | null }
  /** Не отправлять: сообщение существует ради вложений, а их нет. */
  | { kind: 'abort'; text: string };

type UploadOutcome = { ok: boolean; reason?: MediaUploadFailure };

/**
 * Сколько вложений загрузилось и почему остальные — нет.
 *
 * Неизвестная причина считается обычной неудачей: молча потерять вложение
 * из-за незнакомого слова в поле `reason` — ровно тот же дефект.
 */
export function tallyMediaUploads(results: ReadonlyArray<UploadOutcome>): MediaUploadTally {
  const tally: MediaUploadTally = { total: results.length, sent: 0, oversize: 0, failed: 0 };
  for (const r of results) {
    if (r.ok) tally.sent += 1;
    else if (r.reason === 'oversize') tally.oversize += 1;
    else tally.failed += 1;
  }
  return tally;
}

export function decideMediaSend(tally: MediaUploadTally): MediaSendVerdict {
  // Вложений не просили — обычное текстовое сообщение.
  if (tally.total === 0) return { kind: 'send', warn: null };
  if (tally.sent === 0) {
    const one = tally.total === 1;
    if (tally.oversize === tally.total) {
      return {
        kind: 'abort',
        text: one
          ? 'Файл слишком большой — сообщение не отправлено.'
          : 'Файлы слишком большие — сообщение не отправлено.',
      };
    }
    return {
      kind: 'abort',
      text: one
        ? 'Не удалось загрузить файл — сообщение не отправлено.'
        : 'Не удалось загрузить файлы — сообщение не отправлено.',
    };
  }
  if (tally.sent < tally.total) {
    const lost =
      tally.oversize > 0 && tally.failed > 0
        ? 'остальные слишком большие или не загрузились'
        : tally.oversize > 0
          ? 'остальные слишком большие'
          : 'остальные не загрузились';
    return { kind: 'send', warn: `Отправлено вложений: ${tally.sent} из ${tally.total} — ${lost}.` };
  }
  return { kind: 'send', warn: null };
}

/**
 * Отчёт о пачке, где каждое вложение уходит своим сообщением (v4.32.842).
 *
 * Дефект. Пять циклов отправки — видео в личной переписке и в группе, оба
 * листа вложений, фотографии в группу — считали одну причину из трёх и
 * докладывали цепочкой `else if`. Из-за этого вложение, не загрузившееся не
 * по размеру, пропадало без единого слова, если хоть одно другое ушло:
 * `skippedTooLarge === 0`, `sentAny === true` — и ни одной ветки. А там, где
 * причины считались, `else if` показывал только первую: отказ отправки прятал
 * превышение размера.
 *
 * Хуже всех был путь фотографий: любая потеря объявлялась превышением размера
 * («остальные слишком большие»), и к ней приписывался предел — тот самый
 * MAX_BLOB_BYTES по умолчанию, даже когда ни одного превышения не было.
 *
 * Правка. Считаются все причины, называются все случившиеся, и предел
 * называется только тогда, когда превышение вправду было.
 *
 * Голос тот же, что у `decideMediaSend`: причины без отдельных счётчиков —
 * «остальные слишком большие или не загрузились». Счёт по каждой причине
 * потребовал бы согласования числа с родом на каждом слове, а человеку тут
 * важно не «сколько именно чего», а «часть пропала, и вот почему».
 */
export type BatchKind = 'video' | 'photo';

export type BatchTally = {
  total: number;
  sent: number;
  oversize: number;
  failed: number;
  /** Загрузилось, но отправить не дали: ретранслятор отказал. */
  refused: number;
};

const BATCH_NOUN: Record<BatchKind, string> = { video: 'Видео', photo: 'Фото' };

/** Средний род: годится и «видео», и «фото», и единственному, и множественному. */
const BATCH_CAUSE: Record<keyof Omit<BatchTally, 'total' | 'sent'>, [string, string]> = {
  oversize: ['слишком большое', 'слишком большие'],
  failed: ['не загрузилось', 'не загрузились'],
  refused: ['не отправилось', 'не отправились'],
};

/** Все причины, которые вправду случились, — и ни одной лишней. */
function batchCauses(t: BatchTally, one: boolean): string {
  const said: string[] = [];
  for (const k of ['oversize', 'failed', 'refused'] as const) {
    if (t[k] > 0) said.push(BATCH_CAUSE[k][one ? 0 : 1]);
  }
  // Счёт не сошёлся: причину потеряли по дороге. Промолчать тут нельзя — это и
  // есть исходный дефект, — но и выдумывать причину не за что.
  return said.length > 0 ? said.join(' или ') : one ? 'не ушло' : 'не ушли';
}

/**
 * Что сказать после пачки. `null` — сказать нечего: ушло всё.
 *
 * `limitBytes` называется только при превышении: предел, приписанный к чужой
 * причине, — неправда, с которой человек ничего не сделает.
 */
export function batchSendReport(
  t: BatchTally,
  kind: BatchKind,
  limitBytes: number | null,
): string | null {
  const lost = t.total - t.sent;
  if (t.total === 0 || lost <= 0) return null;
  const one = lost === 1;
  const why = batchCauses(t, one);
  const tail = t.oversize > 0 && limitBytes !== null ? ` Предел — ${formatLimit(limitBytes)}.` : '';
  if (t.sent === 0) {
    const verb = t.total === 1 ? 'не отправлено' : 'не отправлены';
    return `${BATCH_NOUN[kind]} ${verb}: ${why}.${tail}`;
  }
  const rest = one ? 'остальное' : 'остальные';
  return `Отправлено ${BATCH_NOUN[kind].toLowerCase()}: ${t.sent} из ${t.total} — ${rest} ${why}.${tail}`;
}
