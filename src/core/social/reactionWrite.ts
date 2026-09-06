/**
 * Почему реакция не легла в строку — и что об этом сказать (v4.32.599).
 *
 * `toggleReaction` возвращала `{ on } | null`, и в этом `null` жили сразу
 * четыре разных исхода: строки сообщения нет; столбец с реакциями не открылся
 * нашим ключом (запись в него запрещена с v4.32.544, иначе прежние реакции
 * были бы стёрты необратимо); карта упёрлась в потолок различных эмодзи
 * (v4.32.509); запрос к базе упал.
 *
 * Слоем выше все четыре превращались в «Сообщение не найдено» — единственный
 * текст, который там был. Человек читал про пропавшее сообщение, глядя прямо
 * на него: он идёт искать не ту беду, а настоящая — ключ, который не
 * открывает часть его же данных, — остаётся неназванной. То же самое, что
 * v4.32.447 исправила этажом выше, только внутри самой записи.
 *
 * Причина отделена от текста намеренно. Причину читает и код (входящий
 * конверт роняется молча, но в журнал должно попасть, почему именно), текст
 * читает человек — и меняться они будут по-разному.
 *
 * v4.32.608: причин стало пять. Потолок «слишком много реакций» распался на
 * две: общий на записи и личный — сколько разных эмодзи навесил сам нажавший.
 * Смешивать их нельзя: от первого человек ничего сделать не может, а второй
 * снимается его же собственной реакцией, и текст обязан это сказать.
 */
import { MAX_REACTIONS_PER_ACTOR, type ReactionLimit } from './reactionMapPolicy';

/** Отчего запись реакции не состоялась. */
export type ReactionWriteFailure = 'missing' | 'unreadable' | 'limit' | 'ownLimit' | 'failed';

/** Итог записи реакции в свою базу: либо новое состояние, либо названная причина. */
export type ReactionWriteResult = { ok: true; on: boolean } | { ok: false; reason: ReactionWriteFailure };

/**
 * Текст отказа для человека.
 *
 * Каждая причина названа своими словами: подсказывать «попробуйте ещё раз»
 * там, где повтор заведомо не поможет, — значит гонять человека по кругу.
 */
export function reactionWriteFailureText(reason: ReactionWriteFailure): string {
  switch (reason) {
    case 'missing':
      return 'Сообщение не найдено';
    case 'unreadable':
      return 'Реакции этого сообщения не удалось прочитать: их не открывает ключ этого устройства';
    case 'limit':
      return reactionLimitText('keys', 'message');
    case 'ownLimit':
      return reactionLimitText('actor', 'message');
    case 'failed':
      return 'Не удалось сохранить реакцию';
  }
}

/** На чём стоит реакция — от этого зависит только слово в тексте. */
export type ReactionSubject = 'message' | 'post' | 'comment';

const SUBJECT_IN: Record<ReactionSubject, string> = {
  message: 'сообщении',
  post: 'посте',
  comment: 'комментарии',
};

/**
 * Текст потолка. Личный называет число — иначе «слишком много» не подсказывает
 * человеку, что делать; общий числа не называет, потому что складывается из
 * чужих действий и трогать его нажавшему нечем.
 */
export function reactionLimitText(limit: ReactionLimit, subject: ReactionSubject): string {
  const where = SUBJECT_IN[subject];
  if (limit === 'actor') {
    return `На этом ${where} у вас уже ${MAX_REACTIONS_PER_ACTOR} разных реакций — снимите одну, чтобы поставить новую`;
  }
  return `На этом ${where} уже слишком много разных реакций`;
}

/**
 * Отказ потолком как ошибка — для путей, которые возвращают не результат, а
 * бросок (реакция на пост и на комментарий). Не подкласс `Error`: под Hermes
 * наследование от встроенных типов ломает `instanceof`, а признак на самом
 * объекте работает везде одинаково.
 */
export type ReactionLimitError = Error & { reactionLimit: ReactionLimit };

export function reactionLimitError(limit: ReactionLimit, subject: ReactionSubject): ReactionLimitError {
  const e = new Error(reactionLimitText(limit, subject)) as ReactionLimitError;
  e.reactionLimit = limit;
  return e;
}

export function isReactionLimitError(e: unknown): e is ReactionLimitError {
  return e instanceof Error && typeof (e as { reactionLimit?: unknown }).reactionLimit === 'string';
}
