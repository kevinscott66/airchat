/**
 * pollVoteEnvelope — чистый кодек конверта голоса в опросе ('\x15pv:').
 *
 * v4.32.250. До этой версии голоса в опросах НЕ СИНХРОНИЗИРОВАЛИСЬ вообще: и в
 * личке (DmPollBubble), и в группах (PollBubble) нажатие писало строку только в
 * локальную таблицу poll_votes. Собеседник о голосе не узнавал никогда, поэтому
 * счётчик «N голос(ов)» у каждого показывал ровно его собственные нажатия, а
 * опрос на двоих всегда выглядел как «1 голос» с обеих сторон. Фича смотрелась
 * рабочей ровно у того, кто голосовал.
 *
 * В ленте такая рассылка была с v4.32.51 (см. feedTransport) — здесь повторён
 * тот же принцип, но поверх личных сообщений, как у реакций.
 *
 * Модуль без импортов, кроме такого же чистого envelopeBody, — разбор
 * недоверенного ввода должен тестироваться без SQLite и транспорта
 * (см. reactionEnvelope.ts).
 *
 * '\x15' — следующий свободный управляющий байт ('\x01' voice, '\x02' grp,
 * '\x03' grpr, '\x04' poll, '\x05' contact, '\x06' doc, '\x07' loc, '\x08' fwd,
 * '\x09' vo, '\x0a' gif/gjr, '\x0b' sys, '\x0c' liveloc, '\x0e' gctl,
 * '\x0f' react, '\x10' dmpin, '\x11' dis, '\x12' pres, '\x13' story,
 * '\x14' prof).
 */

import { readEnvelopeBody } from './envelopeBody';

export const POLL_VOTE_PREFIX = '\x15pv:';

/**
 * Завершение опроса. Тот же управляющий байт, другая метка: «Завершить опрос»
 * тоже писал только в свою БД (ключ poll_closed_<id> в kv), поэтому остальные
 * участники продолжали голосовать в закрытом, по мнению автора, опросе.
 */
export const POLL_CLOSE_PREFIX = '\x15pc:';

export type PollVoteEnvelope = {
  /** id сообщения-опроса (общий у обеих сторон). */
  msgId: string;
  /** Номер варианта. Опрос допускает не более 12 вариантов (см. pollEnvelope). */
  idx: number;
  /** true — голос поставлен, false — снят. */
  on: boolean;
  /** Опрос с несколькими ответами: голоса за разные варианты не вытесняют друг друга. */
  multi: boolean;
  ts: number;
  /** Для группового опроса — id группы; для личного отсутствует. */
  groupId?: string;
};

/**
 * Верхняя граница номера варианта. Хранилище (setPollVote) отсекает всё выше
 * 255 самостоятельно, но здесь предел строже и совпадает с реальным потолком
 * опроса: вариантов не больше 12, значит индекс не больше 11.
 */
const MAX_OPTION_INDEX = 11;

export function encodePollVoteEnvelope(env: PollVoteEnvelope): string {
  return POLL_VOTE_PREFIX + JSON.stringify(env);
}

/** Разбирает и валидирует конверт голоса. null — не наш конверт либо мусор. */
export function decodePollVoteEnvelope(text: string): PollVoteEnvelope | null {
  // Конверт голоса — десятки байт; всё крупнее либо мусор, либо попытка
  // нагрузить JSON.parse.
  const env = readEnvelopeBody<PollVoteEnvelope>(text, POLL_VOTE_PREFIX, 2048);
  if (!env) return null;
  if (typeof env.msgId !== 'string' || !env.msgId || env.msgId.length > 128) return null;
  if (typeof env.on !== 'boolean') return null;
  if (typeof env.multi !== 'boolean') return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  // Дробный или отрицательный индекс попал бы в SQL как есть и создал строку,
  // которую не покажет ни один вариант, зато она вечно живёт в счётчике.
  if (typeof env.idx !== 'number' || !Number.isInteger(env.idx)) return null;
  if (env.idx < 0 || env.idx > MAX_OPTION_INDEX) return null;
  if (env.groupId != null) {
    if (typeof env.groupId !== 'string' || !env.groupId || env.groupId.length > 128) return null;
  }
  return env;
}

export type PollCloseEnvelope = {
  /** id сообщения-опроса. */
  msgId: string;
  ts: number;
  /** Для группового опроса — id группы; для личного отсутствует. */
  groupId?: string;
};

export function encodePollCloseEnvelope(env: PollCloseEnvelope): string {
  return POLL_CLOSE_PREFIX + JSON.stringify(env);
}

/** Разбирает и валидирует конверт завершения опроса. null — не наш конверт либо мусор. */
export function decodePollCloseEnvelope(text: string): PollCloseEnvelope | null {
  const env = readEnvelopeBody<PollCloseEnvelope>(text, POLL_CLOSE_PREFIX, 2048);
  if (!env) return null;
  if (typeof env.msgId !== 'string' || !env.msgId || env.msgId.length > 128) return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  if (env.groupId != null) {
    if (typeof env.groupId !== 'string' || !env.groupId || env.groupId.length > 128) return null;
  }
  return env;
}
