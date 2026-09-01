/**
 * Карта реакций одного сообщения — v4.32.509.
 *
 * Дефект: сам эмодзи проверялся строго (белый список code point'ов, не больше
 * восьми, см. reactionEnvelope), а вот СКОЛЬКО различных эмодзи можно навесить
 * на одно сообщение — не проверял никто. Каждый входящий конверт '\x0freact:'
 * добавлял новый ключ в карту, карта целиком шифровалась и писалась в ячейку
 * `reactions`, а экран рисовал по чипу на ключ. Один участник группы,
 * отправив несколько тысяч разных валидных эмодзи на одно сообщение, раздувал
 * строку в SQLite и вешал отрисовку пузыря у ВСЕХ остальных — своих действий
 * для этого не требовалось никаких, кроме нажатий.
 *
 * Правило двухуровневое, и это важно:
 *   • на участника — сколько различных эмодзи может держать один ключ. Это
 *     основная граница: она ограничивает вклад каждого и никого не запирает.
 *   • на сообщение — общий потолок ключей. Нужен как страховка от множества
 *     личностей; он может помешать поставить НОВЫЙ эмодзи, но снять свой и
 *     переключить уже существующий не мешает никогда.
 *
 * Разбор ячейки живёт здесь же: карта приходит из базы, куда её мог положить
 * предыдущий формат или испорченная миграция, — своя же ячейка проверяется
 * как чужая.
 *
 * Модуль без импортов.
 */

/** Эмодзи → список base64-ключей тех, кто его поставил. */
export type ReactionMap = Record<string, string[]>;

/**
 * Сколько различных эмодзи вправе держать один участник на одном сообщении.
 * Восемь — заведомо больше живого поведения: обычно ставят один.
 */
export const MAX_REACTIONS_PER_ACTOR = 8;

/**
 * Общий потолок различных эмодзи на сообщении. Шестьдесят четыре чипа в
 * пузыре — уже сломанный экран; всё сверх этого только вредит.
 */
export const MAX_REACTION_KEYS = 64;

/**
 * Разбирает содержимое ячейки `reactions`. Мусор, не-объект, массив,
 * нестроковые ключи участников — всё это отбрасывается: карта возвращается
 * настолько, насколько её удалось понять.
 */
export function parseReactionMap(stored: string | null | undefined): ReactionMap {
  if (typeof stored !== 'string' || stored.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: ReactionMap = {};
  for (const [emoji, users] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(users)) continue;
    const keys = users.filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (keys.length) out[emoji] = keys;
  }
  return out;
}

/** Сколько различных эмодзи держит этот участник. */
export function actorReactionCount(map: ReactionMap, actorKey: string): number {
  let n = 0;
  for (const users of Object.values(map)) if (users.includes(actorKey)) n++;
  return n;
}

/**
 * Держит ли участник этот эмодзи. Отдельная функция, потому что от ответа
 * зависит и переключение, и то, считается ли действие добавлением.
 */
export function actorHasReaction(map: ReactionMap, emoji: string, actorKey: string): boolean {
  const users = map[emoji];
  return Array.isArray(users) && users.includes(actorKey);
}

/**
 * Разрешено ли ДОБАВИТЬ эту реакцию. Снятие не спрашивает разрешения никогда:
 * иначе упёршийся в потолок участник не смог бы убрать даже своё.
 */
export function canAddReaction(map: ReactionMap, emoji: string, actorKey: string): boolean {
  if (actorHasReaction(map, emoji, actorKey)) return true;
  if (actorReactionCount(map, actorKey) >= MAX_REACTIONS_PER_ACTOR) return false;
  const isNewKey = !Array.isArray(map[emoji]) || map[emoji].length === 0;
  if (isNewKey && Object.keys(map).length >= MAX_REACTION_KEYS) return false;
  return true;
}

/**
 * Применяет переключение к карте и возвращает новую карту вместе с итоговым
 * состоянием. `null` — действие отклонено потолком; вызывающий не должен ни
 * писать в базу, ни рассылать fanout.
 *
 * Карта на входе не меняется.
 */
export function applyReaction(
  map: ReactionMap,
  emoji: string,
  actorKey: string,
  on: boolean | 'toggle'
): { map: ReactionMap; on: boolean } | null {
  const has = actorHasReaction(map, emoji, actorKey);
  const next = on === 'toggle' ? !has : on;
  if (next === has) {
    // Состояние уже такое, какое просят. Это не отказ: карта не меняется, но
    // и врать вызывающему про «не получилось» не за что.
    return { map: { ...map }, on: next };
  }
  if (next && !canAddReaction(map, emoji, actorKey)) return null;
  const copy: ReactionMap = {};
  for (const [k, v] of Object.entries(map)) copy[k] = v.slice();
  const users = copy[emoji] ?? [];
  if (next) users.push(actorKey);
  else users.splice(users.indexOf(actorKey), 1);
  if (users.length) copy[emoji] = users;
  else delete copy[emoji];
  return { map: copy, on: next };
}

/** Содержимое ячейки для пустой карты — `null`; иначе JSON. */
export function serializeReactionMap(map: ReactionMap): string | null {
  return Object.keys(map).length ? JSON.stringify(map) : null;
}
