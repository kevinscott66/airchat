/**
 * Очистка того, что уходит в Sentry (v4.32.614).
 *
 * `ErrorHandler.handle` кладёт `context` ошибки в `extra` отчёта, а отчёт
 * уходит на чужой сервер. Опасность тут не в самих полях — сегодня их три, и
 * все безобидные, — а в том, что правило «сюда нельзя класть ключи и DID»
 * держалось на трёх комментариях в messaging.ts. Комментарий не выполняется:
 * первый же диагностический `to: peerDid` в новом месте уехал бы в отчёт, и
 * заметить это было бы некому.
 *
 * Здесь правило записано так, что оно работает само. Скрывается то, что и
 * так не годится в диагностику:
 *
 *  - значение под именем, в котором есть «key», «secret», «token», «password»,
 *    «seed», «mnemonic», «did», «pub», «phrase» — независимо от вида;
 *  - строка, целиком похожая на DID, на длинный base64 или на длинный hex,
 *    где бы она ни лежала.
 *
 * Совпадение всегда по строке целиком, а не по куску: `componentStack` из
 * границы ошибок — обычный многострочный текст, и разрезать его на «похожие
 * на ключ» куски незачем. Длина обрезается, вложенность ограничена, цикл в
 * объекте не уводит в бесконечность.
 *
 * Модуль без импортов: его решения проверяются без Sentry и без сети.
 */

/** Чем заменяется скрытое значение. Одна строка на все случаи. */
export const SCRUBBED = '[скрыто]';

/** Больше этого в отчёт не уходит: остальное обрезается с пометкой. */
export const SCRUB_MAX_LEN = 8192;

/** Глубже не идём: вложенный объект в диагностике и так читать нечем. */
const MAX_DEPTH = 4;

/** Длиннее не идём: список в отчёте нужен как образец, а не целиком. */
const MAX_ITEMS = 50;

/**
 * Имена, под которыми диагностике не место. Сравнение по СЛОВАМ, а не по куску
 * строки: `peerDid` разбирается на «peer» и «did», а «candidate» словом «did»
 * не становится, хотя эти три буквы в нём есть.
 */
const SENSITIVE_WORDS = new Set([
  'key', 'keys', 'privkey', 'pubkey', 'secret', 'token', 'password', 'passphrase',
  'phrase', 'seed', 'mnemonic', 'did', 'dids', 'pub', 'sig', 'signature', 'nonce', 'salt',
]);

function keyIsSensitive(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .some((word) => SENSITIVE_WORDS.has(word.toLowerCase()));
}
const DID_RE = /^did:[a-z0-9]+:/i;
const B64_RE = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const HEX_RE = /^[0-9a-fA-F]{32,}$/;

/** Похожа ли строка целиком на то, что связывает отчёт с человеком. */
export function looksSecret(s: string): boolean {
  return DID_RE.test(s) || HEX_RE.test(s) || B64_RE.test(s);
}

/**
 * Текст сообщения об ошибке: слова, похожие на ключ или DID, скрываются,
 * остальное остаётся читаемым. Разбор по пробелам — сообщение об ошибке
 * человеку показывается тем же текстом, и портить его незачем.
 */
export function scrubTelemetryText(text: string): string {
  const cut = text.length > SCRUB_MAX_LEN ? `${text.slice(0, SCRUB_MAX_LEN)}…` : text;
  return cut
    .split(' ')
    .map((word) => (looksSecret(word.replace(/[.,;:!?()[\]'"]+$/, '')) ? SCRUBBED : word))
    .join(' ');
}

function scrubValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (looksSecret(value)) return SCRUBBED;
    return value.length > SCRUB_MAX_LEN ? `${value.slice(0, SCRUB_MAX_LEN)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return SCRUBBED;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((v) => scrubValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      out[k] = keyIsSensitive(k) ? SCRUBBED : scrubValue(v, depth + 1);
    }
    return out;
  }
  // Функция, символ, bigint — в отчёте от них всё равно ничего не прочитать.
  return SCRUBBED;
}

/** Готовит `context` ошибки к отправке. Пустой вход остаётся пустым. */
export function scrubTelemetryContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return scrubValue(context, 0) as Record<string, unknown>;
}
