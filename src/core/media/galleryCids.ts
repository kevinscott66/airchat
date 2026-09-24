/**
 * Какие вложения галерея берётся расшифровать (v4.32.803).
 *
 * Выбор жил дважды в разметке — в полосе переписки и в окне группы, — и обе
 * копии брали подряд всё, у чего есть CID. Одноразовый снимок при этом
 * расшифровывался наравне с остальными: `useResolvedMediaUrls` кладёт открытый
 * файл в кэш, плитка рисуется обычной, и снимок становится видно ещё до того,
 * как его «открыли», а открыть его можно сколько угодно раз — ни один такой
 * показ сообщение не сжигает.
 *
 * Поэтому решение вынесено сюда целиком: не «не рисовать плитку», а не давать
 * адреса на расшифровку. Плитку можно было бы не рисовать и в разметке — файл
 * в кэше от этого не исчез бы.
 *
 * Модуль берёт ровно два правила: как разобрать столбец CID'ов и какую строку
 * показывать нельзя. Ни базы, ни ключей, ни отрисовки здесь нет.
 */
import { parseMediaCidsColumn } from './mediaCidPolicy';
import { mediaRowViewOnce, type SharedMediaLike } from './sharedMediaScan';

/**
 * Сколько вложений галерея расшифровывает за один заход.
 *
 * Потолок не косметика: каждое незакэшированное вложение — это загрузка до
 * 8 МБ, и в переписке на тысячу фотографий открытие вкладки означало бы
 * тысячу загрузок. Очередь на них общая (см. useResolvedMediaUrls).
 */
export const GALLERY_CID_LIMIT = 300;

/** Показывает ли галерея эту строку вообще. */
function shown(row: SharedMediaLike): boolean {
  return !mediaRowViewOnce(row);
}

/**
 * Все CID'ы подряд — так их берёт полоса переписки.
 *
 * Плитка потом ищет свой адрес в этом же списке по значению, поэтому строки
 * без показа выпадают из него насовсем, а не превращаются в пустые места.
 */
export function galleryCids(
  rows: readonly SharedMediaLike[],
  limit: number = GALLERY_CID_LIMIT,
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (!shown(row)) continue;
    for (const cid of parseMediaCidsColumn(row.mediaCids)) {
      const c = cid.trim();
      if (c) out.push(c);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/**
 * По первому CID на строку — так их берёт окно группы.
 *
 * Список позиционный: плитка берёт адрес по своему индексу в сетке. Поэтому
 * строка без показа остаётся в списке, но пустой строкой — сдвиг индексов
 * подписал бы чужие снимки чужими датами.
 */
export function galleryFirstCids(rows: readonly SharedMediaLike[]): string[] {
  return rows.map((row) => (shown(row) ? parseMediaCidsColumn(row.mediaCids)[0]?.trim() ?? '' : ''));
}
