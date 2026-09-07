/**
 * pollRead — чтение состояния опроса: голоса и отметка «завершён» одним
 * ответом, с честным различением «голосов нет» и «прочитать не удалось».
 *
 * v4.32.652. Оба пузыря опроса — групповой (PollBubble) и в личке
 * (DmPollBubble) — читали голоса через getPollVotes без единого try/catch.
 * getPollVotes падает вместе с db(): и на паузе после переоткрытия базы, и
 * на заблокированной таблице. Отказ приходил в компонент необработанным
 * промисом, а состояние оставалось начальным: votes = [], isClosed = false.
 * На экране это выглядело как «опрос открыт, вы ещё не голосовали».
 *
 * Для викторины, где переголосовать нельзя, это уже не косметика: кнопки
 * снова становились активными, нажатие уходило в castAndSyncPollVote, а тот
 * переписывал прежний голос локально и рассылал перезапись всем участникам.
 * Один сбой чтения стирал ответ, данный раньше, — и у себя, и у других.
 *
 * Отметка завершения читается через scopedKvTryGetFor, а не scopedKvGetFor:
 * второй склеивает «ключа нет» и «прочитать не удалось» в один null, и
 * завершённый опрос после сбоя снова выглядел бы открытым.
 */

import { log } from '../logger';
import { getPollVotes } from '../storage/local';
import { pollClosedKey } from '../storage/kvKeys';
import { scopedKvTryGetFor } from '../storage/profileScopedKv';

export type PollVoteRow = { voterPubB64: string; optionIndex: number };

/** Прочитанное состояние опроса целиком. */
export type PollSnapshot = { votes: PollVoteRow[]; closed: boolean };

/**
 * Что пузырь знает об опросе прямо сейчас:
 * pending — первое чтение ещё не завершилось;
 * ok — состояние прочитано;
 * failed — прочитать не удалось.
 */
export type PollReadPhase = 'pending' | 'ok' | 'failed';

export const POLL_UNREADABLE_TEXT = 'Голоса не прочитались — попробуйте позже';

/** Читает голоса и отметку завершения; null — прочитать не удалось. */
export async function readPollSnapshot(
  messageId: string,
  pid: number
): Promise<PollSnapshot | null> {
  try {
    const [votes, closedCell] = await Promise.all([
      getPollVotes(messageId, pid),
      scopedKvTryGetFor(pid, pollClosedKey(messageId)),
    ]);
    if (!closedCell) {
      log.warn('poll_closed_flag_read_failed', { pid });
      return null;
    }
    return { votes, closed: closedCell.value === '1' };
  } catch (e) {
    log.warn('poll_votes_read_failed', {
      pid,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Можно ли отдать голос. Непрочитанное состояние — это запрет, а не
 * разрешение: пока неизвестно, голосовал ли человек, нажатие в викторине
 * способно переписать его прежний ответ.
 */
export function mayCastPollVote(
  phase: PollReadPhase,
  closed: boolean,
  isQuiz: boolean,
  hasVoted: boolean
): boolean {
  if (phase !== 'ok') return false;
  if (closed) return false;
  if (isQuiz && hasVoted) return false;
  return true;
}
