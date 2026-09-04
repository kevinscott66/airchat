/**
 * Альбомы историй в облачной копии аккаунта (v4.32.576).
 *
 * Альбом — это то, что человек решил оставить после суток, и привязывать его к
 * одной установке нечестно: телефон меняют, приложение переустанавливают.
 * Поэтому альбомы едут тем же путём, что переписка и лента, — через
 * liveAccountSync, зашифрованными наверх и обратно.
 *
 * Уезжает не файл, а общий адрес снимка. media_file — имя копии в каталоге
 * ЭТОЙ установки, и второму устройству оно не говорит ничего: там такого файла
 * нет и не будет. Хуже того, уехав, оно вернулось бы обратно и затёрло бы у
 * себя же живое имя — копия осталась бы на диске, а плитка опустела. Поэтому
 * media_file в значении отсутствует вовсе, а приём его не трогает.
 *
 * Строка без CID наверх не идёт (`hold`): на втором устройстве ей нечего
 * показать, и она дала бы там пустую плитку навсегда. Придержанная строка
 * при этом остаётся в наборе ключей — иначе синхронизация выписала бы ей
 * надгробие и стёрла бы её на исходном телефоне (тот же разбор, что у ленты,
 * v4.32.588).
 */

import {
  deleteStoryAlbum as deleteStoryAlbumRows,
  deleteStoryAlbumItem,
  getStoryAlbumItem,
  listAllStoryAlbumItems,
  listStoryAlbumItems,
  listStoryAlbums,
  upsertStoryAlbumFromSync,
  upsertStoryAlbumItemFromSync,
} from '../storage/local';
import { deleteStoryAlbumFiles } from '../media/storyAlbumFiles';
import { log } from '../logger';

/** Что уезжает про альбом. */
export type StoryAlbumSyncValue = {
  id: string;
  title: string;
  createdAt: number;
};

/** Что уезжает про строку альбома. Имени файла здесь нет намеренно. */
export type StoryAlbumItemSyncValue = {
  id: string;
  albumId: string;
  mediaCid: string | null;
  mediaType: 'image' | 'video';
  text: string | null;
  createdAt: number;
  addedAt: number;
};

export type StoryAlbumSyncSnapshot = {
  albums: Array<{ value: StoryAlbumSyncValue; hold: boolean }>;
  items: Array<{ value: StoryAlbumItemSyncValue; hold: boolean }>;
};

/** Выгрузка альбомов профиля для облачной копии. */
export async function exportStoryAlbumSyncSnapshot(
  ownerProfileId: number
): Promise<StoryAlbumSyncSnapshot> {
  const [albums, items] = await Promise.all([
    listStoryAlbums(ownerProfileId),
    listAllStoryAlbumItems(ownerProfileId),
  ]);
  return {
    albums: albums.map((a) => ({
      value: { id: a.id, title: a.title, createdAt: a.createdAt },
      // Название, не открывшееся ключом этого устройства, уехало бы пустой
      // строкой с новой ревизией — и стёрло бы читаемое название на другом.
      hold: a.titleUnreadable === true,
    })),
    items: items.map((i) => ({
      value: {
        id: i.id,
        albumId: i.albumId,
        mediaCid: i.mediaCid,
        mediaType: i.mediaType,
        text: i.text,
        createdAt: i.createdAt,
        addedAt: i.addedAt,
      },
      hold: !i.mediaCid || i.textUnreadable === true,
    })),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Принять альбом из облачной копии. */
export async function applySyncStoryAlbum(value: unknown, ownerProfileId: number): Promise<void> {
  if (!isRecord(value)) throw new Error('Некорректный альбом историй.');
  const id = value.id;
  const title = value.title;
  const createdAt = value.createdAt;
  if (typeof id !== 'string' || id.length === 0
    || typeof title !== 'string'
    || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw new Error('Некорректный альбом историй.');
  }
  await upsertStoryAlbumFromSync({ id, title, ownerProfileId, createdAt });
}

/** Принять строку альбома из облачной копии. */
export async function applySyncStoryAlbumItem(
  value: unknown, ownerProfileId: number
): Promise<void> {
  if (!isRecord(value)) throw new Error('Некорректная строка альбома.');
  const id = value.id;
  const albumId = value.albumId;
  const createdAt = value.createdAt;
  const addedAt = value.addedAt;
  if (typeof id !== 'string' || id.length === 0
    || typeof albumId !== 'string' || albumId.length === 0
    || typeof createdAt !== 'number' || !Number.isFinite(createdAt)
    || typeof addedAt !== 'number' || !Number.isFinite(addedAt)) {
    throw new Error('Некорректная строка альбома.');
  }
  await upsertStoryAlbumItemFromSync({
    id,
    albumId,
    ownerProfileId,
    mediaCid: textOrNull(value.mediaCid),
    mediaType: value.mediaType === 'video' ? 'video' : 'image',
    text: textOrNull(value.text),
    createdAt,
    addedAt,
  });
}

/**
 * Удаление альбома, пришедшее с другого устройства.
 *
 * Копии собираются ДО удаления строк: после него имён файлов не останется
 * нигде, и они пролежат на диске до конца жизни установки.
 */
export async function applySyncStoryAlbumDelete(
  albumId: string, ownerProfileId: number
): Promise<void> {
  const items = await listStoryAlbumItems(albumId, ownerProfileId);
  await deleteStoryAlbumRows(albumId, ownerProfileId);
  const files = items.map((i) => i.mediaFile).filter((n): n is string => !!n);
  if (files.length > 0) await deleteStoryAlbumFiles(files);
  log.info('story_album_sync_deleted', { items: items.length });
}

/** Удаление одной строки альбома, пришедшее с другого устройства. */
export async function applySyncStoryAlbumItemDelete(
  itemId: string, ownerProfileId: number
): Promise<void> {
  const item = await getStoryAlbumItem(itemId, ownerProfileId);
  await deleteStoryAlbumItem(itemId, ownerProfileId);
  if (item?.mediaFile) await deleteStoryAlbumFiles([item.mediaFile]);
}
