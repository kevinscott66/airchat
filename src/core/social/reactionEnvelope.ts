/**
 * reactionEnvelope — чистый кодек конверта реакции ('\x0freact:').
 *
 * v4.32.232. До этой версии реакции НЕ СИНХРОНИЗИРОВАЛИСЬ вообще: и в личке
 * (ChatScreen.applyReaction), и в группах (GroupsScreen.applyReaction) нажатие
 * писало JSON только в локальную БД. Собеседник о реакции не узнавал никогда —
 * фича выглядела рабочей ровно у того, кто её поставил.
 *
 * Отдельная деталь по личке: там ключом в карте реакций был ЛОКАЛЬНЫЙ
 * profile.id ("1"), одинаковый у всех устройств. Даже если бы карта дошла до
 * собеседника, различить авторов было бы невозможно, а «моя ли это реакция»
 * определялось бы неверно. Ключ переведён на base64-публичный ключ, как уже
 * было сделано в группах.
 *
 * Модуль без импортов, кроме такого же чистого envelopeBody, — разбор
 * недоверенного ввода должен тестироваться без SQLite и транспорта
 * (см. groupControlEnvelope.ts).
 *
 * '\x0f' — следующий свободный управляющий байт ('\x01' voice, '\x02' grp,
 * '\x03' grpr, '\x04' poll, '\x05' contact, '\x06' doc, '\x07' loc,
 * '\x08' fwd, '\x0a' gjr, '\x0b' sys, '\x0c' liveloc, '\x0e' gctl).
 */

import { readEnvelopeBody } from './envelopeBody';

export const REACTION_PREFIX = '\x0freact:';

export type ReactionEnvelope = {
  /** id сообщения, на которое ставится реакция (общий у обеих сторон). */
  msgId: string;
  emoji: string;
  /** true — поставить, false — снять. */
  on: boolean;
  ts: number;
  /** Для групповой реакции — id группы; для личной отсутствует. */
  groupId?: string;
};

/**
 * Эмодзи может быть составным (флаги, ZWJ-семьи, модификаторы тона) — до 8
 * code point'ов. Ограничение по code point'ам, а не по .length: «👩‍👩‍👧‍👦»
 * это 11 UTF-16 единиц при 7 code point'ах.
 */
const MAX_EMOJI_CODEPOINTS = 8;

/**
 * Разрешённые code point'ы реакции — именно allow-list, а не «запретить
 * control-символы»: без него собеседник ставит реакцией любой текст («ок»,
 * пробел, 8 иероглифов), и это рисуется в пузыре у всех участников. Проверять
 * \p{Extended_Pictographic} нельзя — Hermes не гарантирует unicode property
 * escapes, поэтому диапазоны заданы явно.
 *
 * Помимо самих пиктограмм разрешены модификаторы, из которых собираются
 * составные эмодзи: variation selector, ZWJ, тон кожи, tag-последовательности
 * (флаг Англии) и keycap (#️⃣, 1️⃣).
 */
const EMOJI_RANGES: [number, number][] = [
  [0x0023, 0x0023], [0x002a, 0x002a], [0x0030, 0x0039], // база keycap
  [0x00a9, 0x00a9], [0x00ae, 0x00ae],
  [0x200d, 0x200d],                                     // ZWJ
  [0x203c, 0x203c], [0x2049, 0x2049],
  [0x20e3, 0x20e3],                                     // combining keycap
  [0x2122, 0x2122], [0x2139, 0x2139],
  [0x2194, 0x21aa],
  [0x231a, 0x231b], [0x2328, 0x2328], [0x23cf, 0x23cf], [0x23e9, 0x23fa],
  [0x24c2, 0x24c2],
  [0x25aa, 0x25fe],
  [0x2600, 0x27bf],
  [0x2934, 0x2935], [0x2b00, 0x2bff],
  [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299],
  [0xfe0e, 0xfe0f],                                     // variation selectors
  [0x1f000, 0x1faff],
  [0xe0020, 0xe007f],                                   // tag sequences
];

function isEmojiCodePoint(cp: number): boolean {
  for (const [lo, hi] of EMOJI_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

export function encodeReactionEnvelope(env: ReactionEnvelope): string {
  return REACTION_PREFIX + JSON.stringify(env);
}

/** Разбирает и валидирует конверт реакции. null — не наш конверт либо мусор. */
export function decodeReactionEnvelope(text: string): ReactionEnvelope | null {
  // Конверт реакции — десятки байт; всё крупнее либо мусор, либо попытка
  // нагрузить JSON.parse.
  const env = readEnvelopeBody<ReactionEnvelope>(text, REACTION_PREFIX, 2048);
  if (!env) return null;
  if (typeof env.msgId !== 'string' || !env.msgId || env.msgId.length > 128) return null;
  if (typeof env.on !== 'boolean') return null;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null;
  if (env.groupId != null) {
    if (typeof env.groupId !== 'string' || !env.groupId || env.groupId.length > 128) return null;
  }
  if (typeof env.emoji !== 'string' || !env.emoji) return null;
  // Реакция рисуется как <Text> в пузыре: любой текст вместо эмодзи ломает
  // вёрстку у ВСЕХ участников, а не только у отправителя.
  const cps = [...env.emoji];
  if (cps.length > MAX_EMOJI_CODEPOINTS) return null;
  for (const ch of cps) {
    const cp = ch.codePointAt(0);
    if (cp == null || !isEmojiCodePoint(cp)) return null;
  }
  return env;
}
