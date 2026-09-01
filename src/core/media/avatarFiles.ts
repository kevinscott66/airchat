/**
 * Файлы аватаров на диске (v4.32.309).
 *
 * ProfileScreen копирует выбранный снимок в `avatar_<время>.jpg` в
 * documentDirectory и удаляет предыдущий только при СЛЕДУЮЩЕЙ смене аватара.
 * Пока аватар меняют, это работает; но когда профиль удаляют или сбрасывают
 * устройство целиком, менять уже нечего — и последний снимок лица остаётся
 * лежать открытым файлом, доступным любому файловому менеджеру.
 *
 * Отсюда сборка мусора, а не адресное удаление: путь удалённого профиля к этому
 * моменту уже стёрт вместе с его записями в kv, зато пути ЖИВЫХ профилей
 * известны. Заодно подбираются файлы, осиротевшие раньше — от профилей,
 * удалённых версиями до этой, и от сбоев копирования.
 *
 * Имя файла знает только этот модуль — как и с именем копии диалогов в
 * v4.32.307: разъехавшийся литерал имени там стоил экспорта чужой переписки.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { log } from '../logger';

const AVATAR_FILE_RE = /^avatar_\d+\.jpg$/;

/** Имя файла — наш ли это аватар. */
export function isAvatarFileName(name: string): boolean {
  return AVATAR_FILE_RE.test(name);
}

/** Путь, по которому сохраняется новый аватар. */
export function newAvatarUri(stampMs: number): string {
  return `${FileSystem.documentDirectory ?? ''}avatar_${stampMs}.jpg`;
}

/**
 * Удалить файлы аватаров, на которые никто не ссылается.
 *
 * `keepUris` — пути аватаров живых профилей; пустой список означает «не осталось
 * никого», то есть полный сброс устройства.
 *
 * Собрать список — забота вызывающего, и собрать его надо ДО удаления. Если у
 * него это не вышло, он обязан не вызывать эту функцию вовсе: неполный список
 * здесь неотличим от «этих аватаров больше нет», и сборка мусора снесёт живое
 * лицо. Поэтому у аргумента и нет значения по умолчанию.
 */
export async function sweepAvatarFiles(keepUris: readonly (string | null | undefined)[]): Promise<number> {
  const dir = FileSystem.documentDirectory;
  if (!dir) return 0;
  const keep = new Set(keepUris.filter((u): u is string => typeof u === 'string' && u.length > 0));
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch (e) {
    // Каталог не прочитался — удалять вслепую нечего и незачем.
    log.warn('avatar_sweep_scan_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isAvatarFileName(name)) continue;
    const uri = `${dir}${name}`;
    if (keep.has(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      removed++;
    } catch (e) {
      // Один файл не удалился — остальные всё равно надо снести.
      log.warn('avatar_delete_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
  if (removed > 0) log.info('avatar_files_swept', { removed });
  return removed;
}
