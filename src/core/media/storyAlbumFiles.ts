/**
 * Файлы альбомов историй на диске (v4.32.576).
 *
 * История живёт сутки: строка уходит из `stories`, а расшифрованный снимок —
 * из кэша, и оба ухода правильные, эфемерность обещана. Альбом — обещание
 * обратное: «эту историю оставить». Поэтому в альбом кладётся СВОЯ копия
 * файла, в documentDirectory, а не ссылка на кэш: ссылка пережила бы ровно до
 * ближайшей уборки (deleteExpiredStories или sweepMediaCache), и альбом
 * состоял бы из пустых плиток.
 *
 * Имя файла знает только этот модуль — как у аватаров (avatarFiles,
 * v4.32.309): разъехавшийся литерал имени там означал, что уборка перестаёт
 * видеть свои же файлы.
 *
 * Запоминается ИМЯ, а не путь. Каталог данных лежит в контейнере, имя
 * которого — UUID, и новая версия приложения получает новый контейнер: путь,
 * записанный прошлой установкой, указывает в никуда. На этом уже один раз
 * пропали фотографии профилей (v4.32.556).
 */
import * as FileSystem from 'expo-file-system/legacy';
import { log } from '../logger';

const ALBUM_FILE_RE = /^storyalbum_\d+_[0-9a-z]{6}\.(?:jpg|mp4)$/;

/** Имя файла — наша ли это копия истории. */
export function isStoryAlbumFileName(name: string): boolean {
  return ALBUM_FILE_RE.test(name);
}

/**
 * Случайный хвост имени.
 *
 * Одного времени мало: две истории уходят в альбом одним нажатием подряд и
 * попадают в одну миллисекунду — второй файл затёр бы первый.
 */
export function storyAlbumFileToken(): string {
  return Math.random().toString(36).replace(/[^0-9a-z]/g, '').padEnd(6, '0').slice(0, 6);
}

/** Имя нового файла альбома. */
export function newStoryAlbumFileName(
  stampMs: number,
  kind: 'image' | 'video',
  token: string = storyAlbumFileToken()
): string {
  return `storyalbum_${stampMs}_${token}.${kind === 'video' ? 'mp4' : 'jpg'}`;
}

/** Имя файла из того, что записано, — путь это или уже имя. */
export function storyAlbumFileName(stored: string | null | undefined): string {
  if (!stored) return '';
  const name = stored.slice(stored.lastIndexOf('/') + 1);
  return isStoryAlbumFileName(name) ? name : '';
}

/** Путь к файлу альбома в ТЕКУЩЕМ каталоге приложения. */
export function storyAlbumUriFromName(name: string): string {
  const dir = FileSystem.documentDirectory;
  if (!dir || !isStoryAlbumFileName(name)) return '';
  return `${dir}${name}`;
}

/**
 * Положить копию медиа истории в каталог альбомов.
 *
 * Источников два, и они не взаимозаменяемы: своя история — файл с камеры или
 * из галереи, чужая, приехавшая через IPFS, — `data:`-адрес с байтами внутри
 * (storyService.resolveStoryMedia). Возвращает `false`, если копия не вышла:
 * записывать в альбом строку без файла нельзя, плитка была бы пустой.
 */
export async function copyIntoStoryAlbum(srcUri: string, name: string): Promise<boolean> {
  const dst = storyAlbumUriFromName(name);
  if (!dst || !srcUri) return false;
  try {
    const comma = srcUri.startsWith('data:') ? srcUri.indexOf(',') : -1;
    if (comma >= 0) {
      await FileSystem.writeAsStringAsync(dst, srcUri.slice(comma + 1), {
        encoding: FileSystem.EncodingType.Base64,
      });
    } else {
      await FileSystem.copyAsync({ from: srcUri, to: dst });
    }
    return true;
  } catch (e) {
    log.warn('story_album_copy_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Удалить один файл альбома. Нет файла — считаем, что дело сделано. */
export async function deleteStoryAlbumFiles(names: readonly string[]): Promise<number> {
  let removed = 0;
  for (const name of names) {
    const uri = storyAlbumUriFromName(name);
    if (!uri) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      removed++;
    } catch (e) {
      log.warn('story_album_delete_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
  return removed;
}

/**
 * Удалить файлы альбомов, на которые не осталось строки в базе.
 *
 * `keep` собирает вызывающий и собирает ДО удаления. Неполный список здесь
 * неотличим от «этих историй больше нет», и уборка снесёт то, что человек
 * оставил у себя навсегда, — поэтому у аргумента нет значения по умолчанию, а
 * непрочитанная строка базы обязана останавливать уборку целиком (см.
 * storyAlbumFileNames: она возвращает признак полноты списка).
 */
export async function sweepStoryAlbumFiles(keep: readonly (string | null | undefined)[]): Promise<number> {
  const dir = FileSystem.documentDirectory;
  if (!dir) return 0;
  const keepNames = new Set(keep.map(storyAlbumFileName).filter((n) => n !== ''));
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch (e) {
    log.warn('story_album_sweep_scan_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isStoryAlbumFileName(name)) continue;
    if (keepNames.has(name)) continue;
    try {
      await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
      removed++;
    } catch (e) {
      log.warn('story_album_delete_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
  if (removed > 0) log.info('story_album_files_swept', { removed });
  return removed;
}
