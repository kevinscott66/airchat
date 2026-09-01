/**
 * presenceEnvelope — конверт «показывай / не показывай моё время входа».
 *
 * v4.32.238. Отправитель уже применил своё правило (см. presencePolicy.ts) и
 * шлёт готовое «да/нет» — получателю нечего интерпретировать.
 *
 * Модуль без импортов, кроме такого же чистого envelopeBody: разбор
 * недоверенного ввода проверяется тестами.
 */

/**
 * Занятые байты: \x01…\x0c, \x0e…\x10 (см. dmPinEnvelope.ts) и \x11 —
 * таймер исчезающих сообщений. \x0d пропущен намеренно: это CR.
 */
import { readEnvelopeBody } from './envelopeBody';

export const PRESENCE_PREF_PREFIX = '\x12pres:';

export type PresencePrefEnvelope = {
  /** true — можно показывать моё «был(а) в сети»; false — нет. */
  show: boolean;
  ts: number;
};

export function encodePresencePrefEnvelope(env: PresencePrefEnvelope): string {
  return PRESENCE_PREF_PREFIX + JSON.stringify({ show: env.show, ts: env.ts });
}

export function decodePresencePrefEnvelope(text: string): PresencePrefEnvelope | null {
  const env = readEnvelopeBody<PresencePrefEnvelope>(text, PRESENCE_PREF_PREFIX, 512);
  if (!env) return null;
  if (typeof env.show !== 'boolean') return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  return { show: env.show, ts: env.ts };
}
