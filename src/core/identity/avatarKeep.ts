/**
 * Список «оставить» для уборки файлов аватаров (v4.32.636).
 *
 * sweepAvatarFiles (media/avatarFiles) сносит с диска всё, чего нет в списке, и
 * по-другому не умеет: имена файлов удалённого профиля к этому моменту стёрты
 * вместе с его записями в базе, идти можно только от живых. Отсюда условие,
 * записанное в его же docblock: список собирает вызывающий, и если собрать не
 * вышло — звать уборку нельзя вовсе. Неполный список там неотличим от «этих
 * аватаров больше нет».
 *
 * Собирался он строковым чтением (kvGetSecretScoped), а оно сводит «записи
 * нет» и «запись не открылась нашим ключом» к одному и тому же null. Первое
 * значит «у профиля нет аватара», второе — «мы не знаем, какой у него аватар»;
 * выдавая второе за первое, уборка сносила файл ЖИВОГО профиля — тот самый
 * снимок лица, ради которого модуль avatarFiles и написан.
 *
 * Поэтому здесь читают ячейкой и на нечитаемой поднимают исключение: пусть
 * уборка не состоится вовсе, чем состоится вслепую. Осиротевший файл подберёт
 * следующая, когда запись снова откроется.
 *
 * Имя ключа живёт здесь, а не в ownAvatar: читают запись оба модуля, а этот из
 * них ни от кого не зависит — обратная сторона потянула бы сюда и файловую
 * систему, и профили.
 */
import { cellTextOrNull, type AtRestCell } from '../storage/atRestCell';

/** Где лежит имя файла аватара. */
export const AVATAR_NAME_KEY = 'user_avatar_uri' as const;

/** Список собрать не удалось — значит, уборку звать нельзя. */
export class AvatarKeepUnknownError extends Error {
  constructor(what: string) {
    super(`avatar keep list incomplete: ${what}`);
    this.name = 'AvatarKeepUnknownError';
  }
}

/**
 * Имена (или пути) аватаров перечисленных профилей.
 *
 * Бросает AvatarKeepUnknownError, если хоть одна запись не прочиталась.
 */
export async function collectAvatarsToKeep(profileIds: readonly number[]): Promise<string[]> {
  // Пустой список для sweepAvatarFiles значит «профилей не осталось», то есть
  // снести все аватары до одного. Ни один живой вызов такого не имеет в виду:
  // удаление профиля всегда оставляет хотя бы один, а полный сброс устройства
  // (wallet/wipeLocalWallet) зовёт уборку сам и мимо этой функции.
  if (profileIds.length === 0) throw new AvatarKeepUnknownError('profiles unknown');
  const { kvGetSecretCell, kvGetSecretCellScoped } = await import('../storage/local');
  const keep: string[] = [];
  const take = (cell: AtRestCell, what: string): void => {
    if (cell.state === 'unreadable') throw new AvatarKeepUnknownError(what);
    const text = cellTextOrNull(cell);
    if (text) keep.push(text);
  };
  for (const id of profileIds) {
    take(await kvGetSecretCellScoped(id, AVATAR_NAME_KEY), `profile ${id}`);
    // Общая запись до v4.32.288 принадлежит первому профилю и до его первого
    // захода в карточку так и лежит неперенесённой.
    if (id === 1) take(await kvGetSecretCell(AVATAR_NAME_KEY), 'legacy shared');
  }
  return keep;
}
