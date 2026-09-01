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
 * Модуль без импортов: подсчёт и выбор текста проверяются отдельно от сети,
 * файловой системы и шифрования.
 */

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
