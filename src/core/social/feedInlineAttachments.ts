/**
 * Вложения входящего поста: разбор без доверия отправителю (v4.32.614).
 *
 * Три дефекта, сросшихся в одном месте.
 *
 * 1. Тип содержимого приходил от отправителя и подставлялся в адрес как есть:
 *    `data:${mime};base64,${b64}`. Запятая или точка с запятой внутри `mime`
 *    рвёт этот адрес на части, и всё, что стоит после запятой, становится уже
 *    не типом, а САМИМ содержимым — то есть отправитель мог положить в место
 *    фотографии произвольное тело произвольного типа. Здесь тип либо проходит
 *    строгую проверку, либо заменяется на `application/octet-stream`.
 *
 * 2. Список `media` фильтровался (не строка, слишком длинная), а параллельный
 *    ему `mediaMime` — нет. После выпадения одного элемента типы разъезжались
 *    с содержимым на единицу: PDF показывался как картинка, картинка — как
 *    видео. Поэтому пары собираются вместе и выпадают вместе.
 *
 * 3. У документов base64 проверялся по набору символов, у фотографий — нет,
 *    хотя пишутся они одинаково. А метаданные документа попадали в строку
 *    поста независимо от того, легли ли байты: получатель видел вложение,
 *    которое невозможно открыть. Теперь в списке остаются только те, чьи
 *    байты действительно приняты, и порядковый номер ключа в kv считается по
 *    этому же, уже отфильтрованному списку.
 *
 * Модуль без импортов.
 */

/** Столько base64 максимум у одной фотографии (~2 МБ после раскодировки). */
export const FEED_INLINE_MEDIA_MAX_B64 = 3 * 1024 * 1024;
/** Столько base64 максимум у одного документа (~10 МБ после раскодировки). */
export const FEED_INLINE_DOC_MAX_B64 = 14 * 1024 * 1024;
/** Сколько фотографий и документов принимается с одного поста. */
export const FEED_INLINE_MEDIA_MAX_COUNT = 10;
export const FEED_INLINE_DOC_MAX_COUNT = 5;

/** Тип по умолчанию — им же подменяется всё, что не прошло проверку. */
export const FEED_INLINE_DEFAULT_MIME = 'application/octet-stream';

/**
 * `тип/подтип` из букв, цифр и разрешённых знаков. Ни запятой, ни точки с
 * запятой, ни пробела — именно они рвут `data:`-адрес.
 */
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$/;

/** Стандартный base64 без переносов: ровно то, что отдаёт чтение файла. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function safeInlineMime(value: unknown): string {
  return typeof value === 'string' && MIME_RE.test(value) ? value : FEED_INLINE_DEFAULT_MIME;
}

export function isInlineBase64(value: unknown, maxLen: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLen &&
    value.length % 4 === 0 &&
    BASE64_RE.test(value)
  );
}

/** Фотографии и их типы — одной парой, чтобы номера не разъезжались. */
export function sanitizeInlineMedia(
  media: unknown,
  mediaMime: unknown,
): { media: string[]; mediaMime: string[] } {
  if (!Array.isArray(media)) return { media: [], mediaMime: [] };
  const mimes = Array.isArray(mediaMime) ? mediaMime : [];
  const keptMedia: string[] = [];
  const keptMime: string[] = [];
  for (let i = 0; i < media.length && keptMedia.length < FEED_INLINE_MEDIA_MAX_COUNT; i += 1) {
    if (!isInlineBase64(media[i], FEED_INLINE_MEDIA_MAX_B64)) continue;
    keptMedia.push(media[i] as string);
    keptMime.push(safeInlineMime(mimes[i]));
  }
  return { media: keptMedia, mediaMime: keptMime };
}

export type SanitizedDocument = { name: string; mime: string; size: number };

/** Документы, чьи байты приняты. Метаданные без байтов не возвращаются вовсе. */
export function sanitizeInlineDocuments(
  documents: unknown,
): { meta: SanitizedDocument[]; data: string[] } {
  if (!Array.isArray(documents)) return { meta: [], data: [] };
  const meta: SanitizedDocument[] = [];
  const data: string[] = [];
  for (const raw of documents) {
    if (meta.length >= FEED_INLINE_DOC_MAX_COUNT) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const doc = raw as { name?: unknown; mime?: unknown; size?: unknown; data?: unknown };
    if (!isInlineBase64(doc.data, FEED_INLINE_DOC_MAX_B64)) continue;
    meta.push({
      name: typeof doc.name === 'string' ? doc.name.slice(0, 200) : 'document',
      mime: safeInlineMime(doc.mime),
      size: typeof doc.size === 'number' && Number.isFinite(doc.size) && doc.size >= 0 ? doc.size : 0,
    });
    data.push(doc.data as string);
  }
  return { meta, data };
}
