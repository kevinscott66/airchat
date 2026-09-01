/**
 * Облачный перевод — что можно отправлять наружу и что считать ответом.
 *
 * v4.32.366. Перевод устроен так: текст сообщения уходит на сторонний сервис
 * api.mymemory.translated.net. Для мессенджера со сквозным шифрованием это
 * самое чувствительное действие в приложении — расшифрованное сообщение
 * добровольно отдают третьей стороне, причём GET-запросом, то есть текст
 * оседает в журналах сервиса и любого прокси по дороге. У MyMemory к тому же
 * общая память переводов: отданный сегмент может вернуться другому клиенту.
 *
 * Ровно поэтому в настройках есть выключатель «Облачный перевод», по
 * умолчанию выключенный. Проверялся он в двух местах из пяти: авто-перевод
 * ленты сообщений спрашивал разрешение, а пункт «Перевести» в меню сообщения
 * — и в личке, и в группе — отправлял текст сразу. Выключатель обходился одним
 * тапом.
 *
 * Список исключений тоже разъехался: авто-путь пропускал \x01, \x02 и \x04, а
 * ручной — \x01 и \x02. Между тем служебных префиксов в приложении 22, и среди
 * них \x05contact: — карточка контакта с именем и ключом ТРЕТЬЕГО человека,
 * который в этом разговоре не участвовал и согласия не давал. Здесь правило
 * одно и не устаревает: текст, начинающийся с управляющего символа, — это
 * машинный конверт, а не речь, и наружу он не идёт никогда.
 *
 * Фильтр кодов (\b\d{4,8}\b) стоял только на авто-пути: одноразовый пароль,
 * присланный в сообщении, ручной перевод отправлял бы наружу целиком.
 *
 * И ответ: MyMemory при исчерпанной квоте отвечает HTTP 200, а текст ошибки
 * кладёт в то же поле translatedText. Приложение показывало его как перевод —
 * человек видел «MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS»
 * вместо своего сообщения и не понимал, при чём тут он.
 *
 * Модуль без React и без сети: решение, адрес, разбор ответа.
 */

export const TRANSLATE_ENDPOINT = 'https://api.mymemory.translated.net/get';

/** Сколько символов вообще отдаём наружу. */
export const MAX_TRANSLATE_CHARS = 500;

/** Потолок на ответ: он попадает в Alert, а его размер нам не подвластен. */
const MAX_TRANSLATION_CHARS = 2000;

/**
 * Почему текст не отправляем.
 * `payload` — служебный конверт, `secret` — похоже на одноразовый код.
 */
export type TranslateBlock = 'empty' | 'payload' | 'secret';

/**
 * Похоже на код подтверждения. Заведомо шире, чем нужно: под правило попадают
 * и годы, и суммы. Это осознанный перекос — не перевести «встретимся в 2026»
 * не стоит ничего, а отдать чужому серверу одноразовый пароль стоит доступа к
 * счёту.
 */
const CODE_LIKE = /\b\d{4,8}\b/;

/** null — отправлять можно. */
export function translateBlockReason(text: string): TranslateBlock | null {
  const raw = text ?? '';
  if (!raw.trim()) return 'empty';
  // Любой управляющий символ в начале — служебный конверт (\x01…\x15).
  // Перечислять префиксы поимённо бессмысленно: их 22, и список устаревает
  // с каждым новым типом сообщения.
  const first = raw.charCodeAt(0);
  if (first < 0x20 || first === 0x7f) return 'payload';
  if (CODE_LIKE.test(raw)) return 'secret';
  return null;
}

/** Что сказать человеку, когда перевод не состоялся по нашему решению. */
export function translateBlockMessage(reason: TranslateBlock): string {
  switch (reason) {
    case 'secret':
      return 'В сообщении есть цифровой код — оно не отправляется на перевод';
    case 'payload':
      return 'Это служебное сообщение, переводить в нём нечего';
    default:
      return 'Переводить нечего';
  }
}

/** Код языка перевода: 'en', 'pt-BR'. */
const LANG_CODE = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

/**
 * Адрес запроса, либо null — если язык не похож на код языка.
 *
 * Язык приезжает из хранилища, где с прошлых версий могло остаться что
 * угодно, и подставлялся в адрес БЕЗ кодирования: значение с «&» или «/»
 * дописывало бы к запросу свои параметры.
 */
export function buildTranslateUrl(text: string, lang: string): string | null {
  const target = (lang ?? '').trim();
  if (!LANG_CODE.test(target)) return null;
  const q = encodeURIComponent(text.slice(0, MAX_TRANSLATE_CHARS));
  return `${TRANSLATE_ENDPOINT}?q=${q}&langpair=${encodeURIComponent(`auto|${target}`)}`;
}

export type TranslateOutcome =
  | { ok: true; text: string }
  /** `quota` — лимит сервиса, `same` — перевод совпал с оригиналом. */
  | { ok: false; reason: 'quota' | 'service' | 'same' };

/**
 * Служебные ответы MyMemory, приходящие в поле перевода. Сервис пишет их
 * заглавными и по-английски вне зависимости от языков запроса.
 */
const SERVICE_NOTICE = /MYMEMORY WARNING|ALL AVAILABLE FREE TRANSLATIONS|PLEASE SELECT TWO DISTINCT LANGUAGES|INVALID (SOURCE|TARGET) LANGUAGE|QUERY LENGTH LIMIT/i;
const QUOTA_NOTICE = /ALL AVAILABLE FREE TRANSLATIONS|MYMEMORY WARNING/i;

/** Разбор недоверенного ответа. */
export function parseTranslation(json: unknown, source: string): TranslateOutcome {
  const root = (json ?? {}) as { responseData?: { translatedText?: unknown }; responseStatus?: unknown };
  // responseStatus приходит то числом, то строкой — сервис непоследователен.
  const status = Number(root.responseStatus);
  const raw = root.responseData?.translatedText;
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'service' };
  if (SERVICE_NOTICE.test(raw)) {
    return { ok: false, reason: QUOTA_NOTICE.test(raw) ? 'quota' : 'service' };
  }
  if (Number.isFinite(status) && status !== 200) return { ok: false, reason: 'service' };
  const text = raw.slice(0, MAX_TRANSLATION_CHARS);
  // Совпадение с оригиналом — не перевод, а «язык тот же» либо эхо сервиса.
  if (text.trim() === source.trim()) return { ok: false, reason: 'same' };
  return { ok: true, text };
}

/** Что сказать человеку про отказ сервиса. */
export function translateFailureMessage(reason: 'quota' | 'service' | 'same'): string {
  switch (reason) {
    case 'quota':
      return 'Дневной лимит бесплатных переводов исчерпан';
    case 'same':
      return 'Сообщение уже на выбранном языке';
    default:
      return 'Не удалось перевести';
  }
}
