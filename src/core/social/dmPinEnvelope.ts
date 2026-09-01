/**
 * dmPinEnvelope — чистый кодек конверта закрепления в личном чате ('\x10dmpin:').
 *
 * v4.32.235. До этой версии «Закрепить» в личке писало ТОЛЬКО в свой kv
 * (`pinned_list_<peer>`) и в свою строку conversations.pinned_message_id.
 * Собеседник не узнавал о закреплении никогда — тот же класс бага, что уже
 * закрыт для реакций (4.32.232) и для групповых закреплений (4.32.233).
 *
 * Текст сообщения в конверте НЕ передаётся: получатель берёт его из своей же
 * строки chat_messages по msgId. Иначе закрепление стало бы способом показать
 * собеседнику в баннере произвольный текст от его собственного имени.
 *
 * Модуль без импортов, кроме такого же чистого envelopeBody, — разбор
 * недоверенного ввода должен тестироваться без SQLite и транспорта
 * (см. groupControlEnvelope.ts, reactionEnvelope.ts).
 *
 * '\x10' — следующий свободный управляющий байт ('\x01' voice, '\x02' grp,
 * '\x03' grpr, '\x04' poll, '\x05' contact, '\x06' doc, '\x07' loc, '\x08' fwd,
 * '\x09' vo, '\x0a' gjr, '\x0b' sys, '\x0c' liveloc, '\x0e' gctl, '\x0f' react).
 * '\x0d' пропущен намеренно: это CR, который слишком легко получить случайно
 * из обычного текста с переводом строки.
 */

import { readEnvelopeBody } from './envelopeBody';

export const DM_PIN_PREFIX = '\x10dmpin:';

export type DmPinEnvelope = {
  /** id сообщения; в личке он общий у обеих сторон. */
  msgId: string;
  /** true — закрепить, false — открепить. */
  on: boolean;
  ts: number;
  /** true — «открепить всё»; msgId в этом случае игнорируется. */
  all?: boolean;
};

export function encodeDmPinEnvelope(env: DmPinEnvelope): string {
  return DM_PIN_PREFIX + JSON.stringify(env);
}

/** Разбирает и валидирует конверт. null — не наш конверт либо мусор. */
export function decodeDmPinEnvelope(text: string): DmPinEnvelope | null {
  // Конверт — десятки байт; всё крупнее либо мусор, либо попытка нагрузить
  // JSON.parse.
  const env = readEnvelopeBody<DmPinEnvelope>(text, DM_PIN_PREFIX, 1024);
  if (!env) return null;
  if (typeof env.on !== 'boolean') return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  if (env.all != null && typeof env.all !== 'boolean') return null;
  // msgId обязателен всегда, кроме «открепить всё»: без него применять нечего.
  if (env.all !== true) {
    if (typeof env.msgId !== 'string' || !env.msgId || env.msgId.length > 128) return null;
  } else if (env.msgId != null && typeof env.msgId !== 'string') {
    return null;
  }
  // Поле text в конверте не предусмотрено; если отправитель его дописал —
  // вырезаем здесь, чтобы оно физически не дожило до применения.
  delete (env as { text?: unknown }).text;
  return env;
}
