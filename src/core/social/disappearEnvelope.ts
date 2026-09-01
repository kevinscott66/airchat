/**
 * disappearEnvelope — конверт «таймер исчезающих сообщений» для личного чата.
 *
 * v4.32.237. До этой версии таймер был чисто локальным: `setConversationDisappearTimer`
 * писал строку в свою БД, а у собеседника копия переписки оставалась навсегда —
 * при том что в шапке чата честно висело «⏱ Исчезают через N». Обещание в
 * интерфейсе не выполнялось ровно наполовину.
 *
 * Модуль без зависимостей (кроме такого же чистого autoDeletePolicy): разбор
 * недоверенного ввода, который ведёт к УДАЛЕНИЮ переписки, обязан проверяться
 * тестами — см. groupControlEnvelope.ts, dmPinEnvelope.ts.
 */
import { readEnvelopeBody } from './envelopeBody';
import { MIN_AUTO_DELETE_MS, MAX_AUTO_DELETE_MS } from '../storage/autoDeletePolicy';
import { ruPlural } from '../text/ruPlural';

/**
 * Занятые байты: \x01 voice, \x02 grp, \x03 grpr, \x04 poll, \x05 contact,
 * \x06 doc, \x07 loc, \x08 fwd, \x09 vo, \x0a gjr, \x0b sys, \x0c liveloc,
 * \x0e gctl, \x0f react, \x10 dmpin. \x0d пропущен намеренно — это CR.
 */
export const DISAPPEAR_PREFIX = '\x11dis:';

export type DisappearEnvelope = {
  /** Миллисекунды до удаления; 0 — таймер снят. */
  ms: number;
  ts: number;
};

export function encodeDisappearEnvelope(env: DisappearEnvelope): string {
  return DISAPPEAR_PREFIX + JSON.stringify({ ms: env.ms, ts: env.ts });
}

/**
 * Разбирает входящий конверт. null — конверт негоден, применять нельзя.
 *
 * Нижняя граница (минута) здесь важнее, чем где-либо ещё: конверт присылает
 * ДРУГАЯ сторона, и `ms: 1` означал бы «стирай всё сразу же» — то есть
 * дистанционное уничтожение чужой переписки одним сообщением.
 */
export function decodeDisappearEnvelope(text: string): DisappearEnvelope | null {
  const env = readEnvelopeBody<DisappearEnvelope>(text, DISAPPEAR_PREFIX, 512);
  if (!env) return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  if (typeof env.ms !== 'number' || !Number.isFinite(env.ms)) return null;
  if (!Number.isInteger(env.ms)) return null;
  if (env.ms !== 0 && (env.ms < MIN_AUTO_DELETE_MS || env.ms > MAX_AUTO_DELETE_MS)) return null;
  return { ms: env.ms, ts: env.ts };
}

/**
 * Человеческая подпись таймера: «1 день», «7 дней», «30 минут», «Выкл».
 *
 * Раньше шапка чата собирала её на месте как `${ms / 86400000} д` — «1 д»,
 * «7 д». Формулировка нужна и в системном сообщении, и в шапке, поэтому
 * живёт рядом с конвертом.
 */
export function formatDisappearLabel(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return 'Выкл';
  const day = 86_400_000;
  const hour = 3_600_000;
  const min = 60_000;
  if (ms % day === 0) {
    const n = ms / day;
    return `${n} ${ruPlural(n, ['день', 'дня', 'дней'])}`;
  }
  if (ms % hour === 0) {
    const n = ms / hour;
    return `${n} ${ruPlural(n, ['час', 'часа', 'часов'])}`;
  }
  const n = Math.round(ms / min);
  return `${n} ${ruPlural(n, ['минута', 'минуты', 'минут'])}`;
}
