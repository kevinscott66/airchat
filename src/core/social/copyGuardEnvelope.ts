/**
 * copyGuardEnvelope — конверт «запрет копирования и пересылки» для личного чата.
 *
 * v4.32.571. До этой версии запрет был чисто местным: он закрывал экран того,
 * кто его включил, а у собеседника «Копировать» и «Переслать» оставались на
 * месте. Для настройки, которую человек включает РАДИ собеседника, это ровно
 * половина обещания — и та половина, которая ему не нужна.
 *
 * Занятые байты: \x01 voice, \x02 grp, \x03 grpr, \x04 poll, \x05 contact,
 * \x06 doc, \x07 loc, \x08 fwd, \x09 vo, \x0a gjr, \x0b sys, \x0c liveloc,
 * \x0e gctl, \x0f react, \x10 dmpin, \x11 dis, \x12 pres, \x13 story,
 * \x14 prof, \x15 pv/pc. \x0d пропущен намеренно — это CR.
 *
 * Модуль без зависимостей, кроме общего разбора тела: конверт приходит от
 * другой стороны и МЕНЯЕТ поведение моего приложения, поэтому разбор
 * недоверенного ввода проверяется тестами отдельно — как у dmPinEnvelope и
 * disappearEnvelope.
 */
import { readEnvelopeBody } from './envelopeBody';

export const COPY_GUARD_PREFIX = '\x16cg:';

export type CopyGuardEnvelope = {
  /** true — собеседник включил запрет, false — снял. */
  on: boolean;
  ts: number;
};

export function encodeCopyGuardEnvelope(env: CopyGuardEnvelope): string {
  return COPY_GUARD_PREFIX + JSON.stringify({ on: env.on, ts: env.ts });
}

/**
 * Разбирает входящий конверт. null — конверт негоден, применять нельзя.
 *
 * Опасность здесь меньше, чем у таймера исчезающих сообщений: чужая команда
 * ничего не удаляет, а только убирает у меня две кнопки. Поэтому и проверок
 * ровно столько, сколько нужно, чтобы `on` был именно булевым: строка «false»
 * или число 0 из чужого клиента иначе прочитались бы как «включить».
 */
export function decodeCopyGuardEnvelope(text: string): CopyGuardEnvelope | null {
  const env = readEnvelopeBody<CopyGuardEnvelope>(text, COPY_GUARD_PREFIX, 256);
  if (!env) return null;
  if (typeof env.on !== 'boolean') return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  return { on: env.on, ts: env.ts };
}
