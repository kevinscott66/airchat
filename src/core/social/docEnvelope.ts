/**
 * docEnvelope — конверт документа '\x06doc:'.
 *
 * v4.32.241. Разбор конверта уже проверял размер и CID, но имя файла брал как
 * есть — любую строку до 256 символов. Имя рисуется в пузыре сообщения, в
 * списке «Файлы» общих вложений и задаёт расширение локальной копии при
 * открытии. Отсюда две поломки.
 *
 * Первая: подмена расширения. Имя «отчет\u202Eexe.pdf» с невидимым U+202E
 * показывается на экране как «отчетfdp.exe» — человек видит .pdf, а
 * открывается .exe. Ни одной проверки на это не было.
 *
 * Вторая: управляющие символы. Перевод строки внутри имени растягивает пузырь
 * и позволяет дописать к названию файла вторую строку — тем же приёмом, каким
 * подделывали системные строки (см. sysLineGuard).
 *
 * Третья, отдельная: список общих файлов группы разбирал конверт своим
 * JSON.parse без единой проверки, поэтому meta.name мог оказаться числом,
 * объектом или undefined и уезжал в <Text> как есть.
 *
 * Здесь лежит та часть разбора, которой не нужен ни IPFS, ни файловая
 * система: имя, размер и общая форма. Проверка самого CID (обычный IPFS или
 * зашифрованный blob 'nb:') осталась у вызывающего — она тянет core/media.
 */

import { readEnvelopeBody } from './envelopeBody';
import { stripBidiControls } from './sysLineGuard';

export const DOC_PREFIX = '\x06doc:';

/** Верхняя граница имени: длиннее реальные имена файлов не бывают. */
export const MAX_DOC_NAME = 256;

/** Больше 10 ГБ приложение не отправляет и принимать не должно. */
export const MAX_DOC_SIZE = 10 * 1024 * 1024 * 1024;

/**
 * Потолок всей строки до JSON.parse (v4.32.380). Настоящий конверт — имя до
 * 256 символов, число и CID до 512: меньше килобайта даже с запасом на
 * экранирование. Четырёх килобайт хватает с большим избытком, а мегабайтный
 * текст от чужого клиента до JSON.parse больше не доходит.
 */
export const MAX_DOC_ENVELOPE = 4096;

export function isDocMessage(text: string): boolean {
  return text.startsWith(DOC_PREFIX);
}

export function makeDocText(name: string, size: number, cid: string): string {
  return `${DOC_PREFIX}${JSON.stringify({ name, size, cid })}`;
}

/**
 * Приводит чужое имя файла к безопасному для показа виду.
 *
 * Возвращает null, если это не строка или после чистки не осталось ничего
 * видимого: пузырь без названия хуже, чем отброшенный конверт.
 */
export function sanitizeFileName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // v4.32.369: список был C0 и DEL. Имя файла — как раз то место, где
  // перевод строки заметен: '\u2028' ломает подпись пузыря на две, а U+0085 в
  // имени доезжает до диска при сохранении.
  // eslint-disable-next-line no-control-regex -- вырезание control-символов из недоверенного ввода и есть цель
  const cleaned = stripBidiControls(v.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DOC_NAME)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Разбирает конверт документа без проверки CID: имя вычищено, размер —
 * конечное неотрицательное число, cid — непустая строка разумной длины.
 * Вызывающий обязан проверить сам CID перед тем, как строить по нему адрес.
 */
export function parseDocEnvelope(text: string): { name: string; size: number; cid: string } | null {
  const o = readEnvelopeBody(text, DOC_PREFIX, MAX_DOC_ENVELOPE);
  if (!o) return null;
  const name = sanitizeFileName(o.name);
  if (name === null) return null;
  if (typeof o.size !== 'number' || !isFinite(o.size) || o.size < 0 || o.size > MAX_DOC_SIZE) return null;
  if (typeof o.cid !== 'string' || o.cid.length === 0 || o.cid.length > 512) return null;
  return { name, size: o.size, cid: o.cid };
}
