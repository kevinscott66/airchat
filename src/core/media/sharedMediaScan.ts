/**
 * Вложения, которых нет в галерее, потому что их не прочитали (v4.32.584).
 *
 * Столбец media_cids читался через `decryptAtRestString`, а он на неудаче
 * отдаёт пустую строку. Обе выборки общих медиа — переписки и группы — тут же
 * отсеивали пустое: `.filter((r) => r.mediaCids !== '')`. То есть строка,
 * которую не открыл ключ данных, исчезала бесследно, и окно «Медиа и файлы»
 * говорило «Нет медиафайлов» ровно тем же экраном, каким оно говорит это про
 * переписку без единой фотографии. Карточка контакта тем же способом
 * занижала счётчик вложений, не подавая вида.
 *
 * Хуже всего это там же, где и всегда: ключ расходится с данными не по одной
 * строке. При расхождении вся галерея становилась пустой — и человек делал
 * единственный доступный ему вывод, что вложения пропали, хотя они лежат
 * рядом и ждут правильного ключа.
 *
 * Правило: непрочитанная строка остаётся в списке и несёт признак рядом со
 * значением. Плитку из неё не построить — CID'ов нет, — но и молчать о ней
 * нельзя: место в сетке занято, счётчик честен, подпись объясняет.
 *
 * Модуль без единого импорта, кроме окончаний: считается это без базы,
 * ключей и отрисовки.
 */
import { pluralRu } from '../storage/ruPlural';

/** Строка общей галереи: её CID'ы либо признак того, что их не прочитать. */
export type SharedMediaLike = {
  mediaCids: string;
  unreadable?: boolean;
};

/** Есть ли у строки CID'ы, из которых можно построить плитку. */
export function mediaRowReadable(row: SharedMediaLike | null | undefined): boolean {
  return !!row && row.unreadable !== true && row.mediaCids !== '';
}

/** Сколько строк галереи не открылось ключом данных. */
export function countUnreadableMedia(rows: readonly SharedMediaLike[]): number {
  let n = 0;
  for (const r of rows) if (r && r.unreadable === true) n += 1;
  return n;
}

/** Сколько строк галереи можно показать. Именно это число и есть «вложений: N». */
export function readableMediaCount(rows: readonly SharedMediaLike[]): number {
  let n = 0;
  for (const r of rows) if (mediaRowReadable(r)) n += 1;
  return n;
}

/** Правильное окончание для числа вложений. */
export function attachmentWordForCount(n: number): string {
  return pluralRu(n, 'вложение', 'вложения', 'вложений');
}

/**
 * Подпись под сеткой галереи. null — жаловаться не на что.
 *
 * Число множит и глагол: «его не показать» против «их не показать». Иначе
 * строка звучит машинно ровно там, где человеку и без того тревожно.
 */
export function mediaSkippedNotice(rows: readonly SharedMediaLike[]): string | null {
  const n = countUnreadableMedia(rows);
  if (n <= 0) return null;
  const word = attachmentWordForCount(n);
  const tail = word === 'вложение' ? 'его не показать' : 'их не показать';
  return `${n} ${word} не удалось прочитать — ${tail}`;
}
