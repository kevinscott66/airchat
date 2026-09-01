/**
 * fileSize — размер локального файла, не поднимая его в память.
 *
 * v4.32.358. Отдельный модуль, потому что спрашивают его обе стороны загрузки:
 * mediaUpload — чтобы выбрать путь, mediaBlob — чтобы не читать файл, который
 * всё равно не примет. Общий предок у них только expo-file-system.
 */

import * as FileSystem from 'expo-file-system/legacy';

/** Размер файла в байтах, или null — если система его не сообщает. */
export async function fileSizeBytes(uri: string): Promise<number | null> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const size = (info as { size?: number }).size;
    return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    // Недоступный файл — размер неизвестен, а не «ноль»: ноль читающая сторона
    // приняла бы за пустой файл и отвергла бы его до попытки чтения.
    return null;
  }
}
