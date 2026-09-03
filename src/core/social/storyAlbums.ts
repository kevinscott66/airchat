/**
 * Альбомы историй (v4.32.576).
 *
 * История живёт сутки — это обещание, а не недоделка: строка уходит из базы,
 * файл из кэша. Альбом — единственное место, где человек может сказать «эту
 * оставить», и потому он устроен не ссылкой, а копией: в каталог документов
 * кладётся свой файл (storyAlbumFiles), в базу — его ИМЯ. Ссылка на кэш
 * прожила бы до ближайшей уборки, и альбом состоял бы из пустых плиток.
 *
 * Альбомы лежат только на этом устройстве. Протокола, которым альбом уехал бы
 * к собеседнику, нет: сторис рассылается конвертом в момент публикации и живёт
 * сутки, а альбом — это то, что осталось ПОСЛЕ. Поэтому в чужом профиле
 * альбомов не видно, и обещать обратное экраном нельзя.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  deleteStoryAlbum as deleteStoryAlbumRows,
  deleteStoryAlbumItem,
  insertStoryAlbum,
  insertStoryAlbumItem,
  listStoryAlbumItems,
  storyAlbumFileNames,
  storyAlbumItemExists,
  type StoryAlbumItemRow,
  type StoryRow,
} from '../storage/local';
import {
  copyIntoStoryAlbum,
  deleteStoryAlbumFiles,
  newStoryAlbumFileName,
  sweepStoryAlbumFiles,
} from '../media/storyAlbumFiles';
import { log } from '../logger';

/** Завести альбом. Возвращает его id. */
export async function createStoryAlbum(title: string, ownerProfileId: number): Promise<string> {
  const id = uuidv4();
  await insertStoryAlbum({ id, title, ownerProfileId, createdAt: Date.now() });
  return id;
}

/** Чем кончилась попытка положить историю в альбом. */
export type AlbumAddResult = 'ok' | 'no-media' | 'copy-failed' | 'duplicate';

/**
 * Идентификатор строки альбома — из альбома и истории.
 *
 * Так одна история лежит в альбоме ровно один раз, но при этом свободно
 * попадает в несколько разных альбомов.
 */
function albumItemId(albumId: string, storyId: string): string {
  return `${albumId}_${storyId}`;
}

/**
 * Положить историю в альбом — вместе с копией снимка.
 *
 * История без снимка в альбом не идёт: альбом смотрят плитками, и текстовая
 * строка в нём была бы пустым квадратом. Не вышла копия — не пишется и
 * строка: запись без файла даёт ту же пустую плитку, только навсегда.
 */
export async function addStoryToAlbum(
  albumId: string,
  story: StoryRow,
  ownerProfileId: number
): Promise<AlbumAddResult> {
  if (!story.mediaUri || story.mediaUnreadable) return 'no-media';
  const itemId = albumItemId(albumId, story.id);
  if (await storyAlbumItemExists(itemId, ownerProfileId)) return 'duplicate';
  const name = newStoryAlbumFileName(Date.now(), story.mediaType);
  if (!(await copyIntoStoryAlbum(story.mediaUri, name))) return 'copy-failed';
  try {
    await insertStoryAlbumItem({
      id: itemId,
      albumId,
      ownerProfileId,
      mediaFile: name,
      mediaType: story.mediaType,
      text: story.textUnreadable ? null : story.text,
      createdAt: story.createdAt,
      addedAt: Date.now(),
    });
    return 'ok';
  } catch (e) {
    // Строка не записалась — копия уже лежит на диске и больше никому не
    // нужна: без строки её не покажет ничто, а уборка ходит по строкам.
    await deleteStoryAlbumFiles([name]);
    log.warn('story_album_item_insert_failed', { err: e instanceof Error ? e.message : String(e) });
    return 'copy-failed';
  }
}

/** Убрать одну историю из альбома — вместе с её копией на диске. */
export async function removeStoryFromAlbum(
  item: StoryAlbumItemRow,
  ownerProfileId: number
): Promise<void> {
  await deleteStoryAlbumItem(item.id, ownerProfileId);
  if (item.mediaFile) await deleteStoryAlbumFiles([item.mediaFile]);
}

/**
 * Удалить альбом целиком.
 *
 * Файлы собираются ДО удаления строк: после него адресов копий не останется
 * нигде, и они пролежат на диске до конца жизни установки.
 */
export async function removeStoryAlbum(albumId: string, ownerProfileId: number): Promise<void> {
  const items = await listStoryAlbumItems(albumId, ownerProfileId);
  await deleteStoryAlbumRows(albumId, ownerProfileId);
  const files = items.map((i) => i.mediaFile).filter((n): n is string => !!n);
  if (files.length > 0) await deleteStoryAlbumFiles(files);
}

/**
 * Подобрать копии, за которыми не осталось строки.
 *
 * Зовётся после удаления профиля: строки его альбомов уходят вместе с
 * остальными данными, а файлы лежат в общем каталоге и адресов больше нигде
 * нет. Неполный список «оставить» останавливает уборку — иначе она снесла бы
 * альбомы живого профиля (та же цена ошибки, что у аватаров, v4.32.309).
 */
export async function sweepOrphanAlbumFiles(): Promise<number> {
  const { names, complete } = await storyAlbumFileNames();
  if (!complete) {
    log.warn('story_album_sweep_skipped_unreadable', { known: names.length });
    return 0;
  }
  return await sweepStoryAlbumFiles(names);
}
