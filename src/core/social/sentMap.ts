/**
 * Карта «кому что уже отправлено»: разбор, слияние и обрезка (v4.32.479).
 *
 * Таких карт две — «кому какая версия профиля ушла» (profileSync) и «кому
 * сообщено решение о времени последнего входа» (presencePrefSync), — и обе
 * писались одинаково неверно. Служба читала карту целиком, уходила рассылать
 * (секунды, а на плохой связи минуты), а потом записывала СВОЙ снимок обратно
 * поверх всего, что за это время записал сосед: рассылка и «досылка при
 * открытии чата» работают одновременно.
 *
 * Потерянная запись сама по себе стоила бы лишней отправки — не беда. Хуже
 * обратное: снимок ВОССТАНАВЛИВАЛ отменённое значение. Собеседнику ушла
 * просьба «не показывай, когда я был в сети», а в карте снова оказывалось
 * «ему сказано показывать» — и когда человек возвращал настройку обратно,
 * отправлять было «нечего», потому что карта считала, что тот уже в курсе.
 * Настройка приватности переставала действовать молча.
 *
 * Поэтому записывается не снимок, а ПРАВКА: что реально отправлено в этот
 * заход. Модуль чистый — ни базы, ни сети, ни профилей.
 */

/** Значение карты: число (версия профиля) или флаг (сказано «показывать»). */
export type SentValue = number | boolean;

/**
 * Разбор того, что лежало в kv. Всё непонятное — «ничего не отправляли»:
 * карта хранит бухгалтерию, а не данные человека, и пересчитать её дешевле,
 * чем разбираться в испорченной.
 */
export function parseSentMap<T extends SentValue>(
  raw: string | null,
  isValue: (v: unknown) => v is T,
): Record<string, T> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // '__proto__' в ключе — не адресат (ключи здесь base64 открытых ключей), а
    // присваивание по такому имени меняет прототип вместо записи поля.
    if (!k || k === '__proto__' || !isValue(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Версия профиля — конечное число. */
export function isSentVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Решение «сказано показывать» — строго булево. */
export function isSentFlag(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/**
 * Правка поверх того, что лежит в базе СЕЙЧАС. Ключи, которых правка не
 * касается, остаются как есть — в этом вся суть: соседний вызов, добавивший
 * свою запись, её не теряет.
 */
export function mergeSentMap<T extends SentValue>(
  stored: Record<string, T>,
  patch: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = {};
  // Правленые ключи переносятся в конец: обрезка ниже режет начало, и только
  // что отправленное не должно выпасть тем же вызовом, который его записал.
  for (const [k, v] of Object.entries(stored)) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(patch)) out[k] = v;
  return out;
}

/**
 * Обрезка до предела. Убираются САМЫЕ СТАРЫЕ записи — те, что появились
 * раньше: у объекта порядок ключей — порядок вставки, а свежая правка
 * оказывается в конце (mergeSentMap кладёт её последней), поэтому только что
 * отправленное не выбрасывается тем же вызовом, что его записал.
 */
export function trimSentMap<T extends SentValue>(
  map: Record<string, T>,
  max: number,
): Record<string, T> {
  const keys = Object.keys(map);
  if (max <= 0) return {};
  if (keys.length <= max) return map;
  const kept = keys.slice(keys.length - max);
  const out: Record<string, T> = {};
  for (const k of kept) out[k] = map[k];
  return out;
}
