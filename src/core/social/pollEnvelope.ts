/**
 * pollEnvelope — чистый кодек опроса ('\x04poll:').
 *
 * v4.32.240. Кодек жил в storage/local.ts — в модуле, который тянет SQLite,
 * то есть проверить разбор недоверенного JSON тестом было нельзя. При этом
 * сборка и разбор разошлись в требованиях, и разбор был заметно слабее:
 *
 *   makePollText  — вопрос непустой, вариантов 2..12, correctAnswer внутри
 *                   диапазона (иначе поле просто не пишется);
 *   parsePollText — вопрос любой (в том числе пустая строка), вариантов
 *                   0..12, correctAnswer — ЛЮБОЕ число.
 *
 * Отсюда две поломки на входящих опросах от чужого клиента:
 *
 * 1. Опрос без вариантов рисовался как заголовок без единой кнопки — строка,
 *    которую нельзя ни закрыть, ни проголосовать, ни отличить от сломанного
 *    приложения.
 * 2. correctAnswer вне диапазона (-1, 3.7, 1e9) делал опрос викториной, в
 *    которой правильного ответа нет вообще: PollBubble сравнивает
 *    `poll.correctAnswer === idx`, совпадения не будет никогда, а
 *    переголосовать в викторине нельзя — каждый участник получал «❌ Неверно»
 *    один раз и навсегда.
 *
 * Модуль без импортов, кроме таких же чистых sysLineGuard и envelopeBody.
 */

import { readEnvelopeBody } from './envelopeBody';
import { sanitizeDisplayName } from './sysLineGuard';

export const POLL_PREFIX = '\x04poll:';

/**
 * Лимиты опроса. Без них JSON опроса раздувал envelope: 100 вариантов по 300
 * символов — это 30 КБ в одном текстовом поле.
 */
export const POLL_MAX_QUESTION_LENGTH = 256;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 12;
export const POLL_MAX_OPTION_LENGTH = 100;

/**
 * Потолок всей строки до JSON.parse (v4.32.380). Настоящий опрос — вопрос до
 * 256 символов и двенадцать вариантов по сотне, то есть полторы тысячи знаков
 * даже без учёта того, что часть уйдёт на экранирование.
 *
 * Отдельная причина, по которой потолок здесь нужнее, чем у остальных
 * конвертов: parsePollText зовут не при приёме, а при ОТРИСОВКЕ пузыря
 * (PollBubble, DmPollBubble, FeedScreen). Строка приходит от чужого клиента и
 * разбирается заново на каждом проходе списка, синхронно в JS-потоке.
 */
export const POLL_MAX_ENVELOPE = 16 * 1024;

export type Poll = {
  question: string;
  options: string[];
  correctAnswer?: number;
  anonymous?: boolean;
  allowMultiple?: boolean;
};

export class PollValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PollValidationError';
  }
}

export function isPollMessage(text: string): boolean {
  return text.startsWith(POLL_PREFIX);
}

/**
 * Собирает опрос. Бросает PollValidationError с человеческим текстом —
 * экраны показывают его пользователю, поэтому формулировки здесь конечные.
 */
export function makePollText(
  question: string,
  options: string[],
  correctAnswer?: number,
  anonymous?: boolean,
  allowMultiple?: boolean
): string {
  // Управляющие символы вычищаются на отправке, а не только на разборе:
  // иначе свой же опрос выглядел бы у собеседника иначе, чем у автора.
  const q = (sanitizeDisplayName(question, POLL_MAX_QUESTION_LENGTH) ?? '').trim();
  if (!q) throw new PollValidationError('Вопрос не может быть пустым');
  if (question.trim().length > POLL_MAX_QUESTION_LENGTH) {
    throw new PollValidationError(`Вопрос слишком длинный (макс. ${POLL_MAX_QUESTION_LENGTH} символов)`);
  }
  const trimmed = options.map((o) => o.trim()).filter((o) => o.length > 0);
  if (trimmed.length < POLL_MIN_OPTIONS) throw new PollValidationError('Нужно минимум 2 варианта ответа');
  if (trimmed.length > POLL_MAX_OPTIONS) throw new PollValidationError(`Слишком много вариантов (макс. ${POLL_MAX_OPTIONS})`);
  const longOpt = trimmed.find((o) => o.length > POLL_MAX_OPTION_LENGTH);
  if (longOpt) {
    throw new PollValidationError(`Вариант слишком длинный (макс. ${POLL_MAX_OPTION_LENGTH} символов): «${longOpt.slice(0, 30)}…»`);
  }
  // Вариант целиком из управляющих символов после вычистки схлопывается в
  // пустую строку — такой в опрос не годится, и минимум проверяется заново.
  const opts = trimmed
    .map((o) => (sanitizeDisplayName(o, POLL_MAX_OPTION_LENGTH) ?? '').trim())
    .filter((o) => o.length > 0);
  if (opts.length < POLL_MIN_OPTIONS) throw new PollValidationError('Нужно минимум 2 варианта ответа');
  const payload: Poll = { question: q, options: opts };
  if (correctAnswer !== undefined && Number.isInteger(correctAnswer) && correctAnswer >= 0 && correctAnswer < opts.length) {
    payload.correctAnswer = correctAnswer;
  }
  if (anonymous) payload.anonymous = true;
  if (allowMultiple) payload.allowMultiple = true;
  return `${POLL_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * Разбирает опрос. null — это не опрос либо он не годится к показу;
 * пузырь в этом случае рисует нейтральное «Опрос» вместо кнопок.
 *
 * Требования здесь ровно те же, что у makePollText: всё, что нельзя
 * отправить, нельзя и принять — иначе чужой клиент рисует у нас то, чего
 * наш собственный интерфейс создать не даёт.
 */
export function parsePollText(text: string): Poll | null {
  const o = readEnvelopeBody(text, POLL_PREFIX, POLL_MAX_ENVELOPE);
  if (!o) return null;

  if (typeof o.question !== 'string') return null;
  if (o.question.length > POLL_MAX_QUESTION_LENGTH) return null;
  const question = (sanitizeDisplayName(o.question, POLL_MAX_QUESTION_LENGTH) ?? '').trim();
  if (!question) return null;

  if (!Array.isArray(o.options)) return null;
  if (o.options.length > POLL_MAX_OPTIONS) return null;
  // Один негодный вариант — негодный опрос целиком: молча выбросить его из
  // списка значит сдвинуть индексы, а по индексам уже разложены голоса.
  if (!o.options.every((x) => typeof x === 'string' && x.length <= POLL_MAX_OPTION_LENGTH)) return null;
  const options = (o.options as string[]).map((x) => (sanitizeDisplayName(x, POLL_MAX_OPTION_LENGTH) ?? '').trim());
  if (options.length < POLL_MIN_OPTIONS) return null;
  if (options.some((x) => x.length === 0)) return null;

  const out: Poll = { question, options };
  // Викторина: правильный ответ обязан существовать. Число вне диапазона
  // делало правильным ни один вариант, а переголосовать викторина не даёт.
  if (o.correctAnswer !== undefined) {
    if (!Number.isInteger(o.correctAnswer)) return null;
    const idx = o.correctAnswer as number;
    if (idx < 0 || idx >= options.length) return null;
    out.correctAnswer = idx;
  }
  if (typeof o.anonymous === 'boolean') out.anonymous = o.anonymous;
  if (typeof o.allowMultiple === 'boolean') out.allowMultiple = o.allowMultiple;
  return out;
}
