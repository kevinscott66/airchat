/**
 * Альбомы историй (v4.32.576).
 *
 * История живёт сутки — это обещание, а не недоделка: строка уходит из базы,
 * файл из кэша. Альбом — единственное место, где человек может сказать «эту
 * оставить», и потому он устроен не ссылкой, а копией: в каталог документов
 * кладётся свой файл (storyAlbumFiles), в базу — его ИМЯ. Ссылка на кэш
 * прожила бы до ближайшей уборки, и альбом состоял бы из пустых плиток.
 *
 * Альбомы — свои, но не привязаны к одному телефону: они уезжают в облачную
 * копию аккаунта (liveAccountSync) и собираются на втором устройстве. Уезжает
 * при этом не файл, а его общий адрес: имя файла — примета ЭТОЙ установки и
 * второму устройству не говорит ничего.
 *
 * К собеседнику альбом не уезжает, и это не недоделка: сторис рассылается
 * конвертом в момент публикации и живёт сутки, а альбом — то, что осталось
 * ПОСЛЕ; протокола «покажи собеседнику свой альбом» нет. Поэтому в чужом
 * профиле альбомов не видно, и обещать обратное экраном нельзя.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  deleteStoryAlbum as deleteStoryAlbumRows,
  deleteStoryAlbumItem,
  insertStoryAlbum,
  insertStoryAlbumItem,
  listStoryAlbumItems,
  setStoryAlbumItemMediaFile,
  storyAlbumFileNames,
  storyAlbumItemExists,
  type StoryAlbumItemRow,
  type StoryRow,
} from '../storage/local';
import {
  copyIntoStoryAlbum,
  deleteStoryAlbumFiles,
  newStoryAlbumFileName,
  storyAlbumUriFromName,
  sweepStoryAlbumFiles,
} from '../media/storyAlbumFiles';
import { uploadMediaToCid } from '../media/mediaUpload';
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
 * Общий адрес копии — чтобы альбом собрался на втором устройстве аккаунта.
 *
 * Загрузка здесь необязательная: альбом прежде всего лежит на ЭТОМ телефоне,
 * и файл уже скопирован — не вышел адрес, значит строка просто не уедет в
 * синхронизацию (её придержит entityHold), а тут она видна как обычно.
 *
 * Свой CID у альбома, а не тот, с которым историю рассылали: публикация его не
 * сохраняет (storyService кладёт в базу локальный адрес), да и жила та ссылка
 * ровно сутки.
 */
async function uploadAlbumCopy(name: string, mediaType: 'image' | 'video'): Promise<string | null> {
  const uri = storyAlbumUriFromName(name);
  if (!uri) return null;
  const up = await uploadMediaToCid(uri, {
    mime: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
  });
  if (!up.ok) {
    log.info('story_album_upload_skipped', { reason: up.reason });
    return null;
  }
  return up.cid;
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
  const mediaCid = await uploadAlbumCopy(name, story.mediaType);
  try {
    await insertStoryAlbumItem({
      id: itemId,
      albumId,
      ownerProfileId,
      mediaFile: name,
      mediaCid,
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

/**
 * Адрес плитки альбома — и, если копии тут ещё нет, её скачивание.
 *
 * Своя строка показывается сразу: файл лежит рядом. Строка, приехавшая с
 * другого устройства аккаунта, приходит без имени файла — там его и быть не
 * может, — зато с общим адресом снимка. Скачанное кладётся в каталог альбомов
 * НАСОВСЕМ и имя записывается в базу: иначе плитка каждый раз зависела бы от
 * того, жив ли ещё общий адрес, а альбом обещает обратное — «останется».
 *
 * Не вышло записать копию — возвращается временный адрес: показать снимок
 * сейчас лучше, чем не показать вовсе.
 */
export async function albumItemLocalUri(
  item: StoryAlbumItemRow,
  ownerProfileId: number
): Promise<string | null> {
  if (item.mediaFile) return storyAlbumUriFromName(item.mediaFile) || null;
  if (!item.mediaCid) return null;
  const { resolveStoryMedia } = await import('./storyService');
  const src = await resolveStoryMedia(item.mediaCid, item.mediaType);
  if (!src) return null;
  const name = newStoryAlbumFileName(item.createdAt, item.mediaType);
  if (!(await copyIntoStoryAlbum(src, name))) return src;
  try {
    await setStoryAlbumItemMediaFile(item.id, ownerProfileId, name);
  } catch (e) {
    // Имя не записалось — файл на диске никому не известен, и уборка снесёт
    // его как ничей. Убираем сразу, чтобы он не ждал этого зря.
    await deleteStoryAlbumFiles([name]);
    log.warn('story_album_name_save_failed', { err: e instanceof Error ? e.message : String(e) });
    return src;
  }
  return storyAlbumUriFromName(name) || src;
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
