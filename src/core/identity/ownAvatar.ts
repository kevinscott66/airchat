/**
 * Фотография профиля: файл на диске и её копия в базе (v4.32.556).
 *
 * До этой версии в kv лежал абсолютный путь к файлу в documentDirectory, и
 * этого хватало ровно до первого обновления приложения. Каталог данных на iOS
 * лежит в контейнере, имя которого — UUID, и каждая установка получает новый
 * контейнер: содержимое система переносит, путь становится несуществующим.
 * Человек после каждого обновления видел на месте своего лица кружок с буквой
 * и заново выбирал снимок. Заодно этот же путь входил в свёртку версии
 * карточки (social/profileSync) — то есть после каждого обновления карточка
 * заново уезжала всем контактам, ничего им не сообщая, и фотография заново
 * заливалась вложением.
 *
 * Чинится в два слоя, и нужны оба:
 *
 * 1. В kv едет ИМЯ файла, а путь собирается от ТЕКУЩЕГО каталога при каждом
 *    чтении (media/avatarFiles). Этого достаточно, пока файл на месте, — а он
 *    на месте: теряется только путь.
 * 2. Сами байты снимка лежат в базе, в `user_avatar_img`, шифртекстом, как и
 *    остальная карточка. Файл после этого — кэш: не нашёлся, значит собираем
 *    его заново из базы. Это и есть «хранить аватар в базе»: запись входит в
 *    OWN_PROFILE_KEYS, а значит уезжает в облачное хранилище вместе с именем и
 *    «о себе» (storage/local, exportSyncProfileSettings), уходит вместе с
 *    удалённым профилем и переживает не только обновление, но и
 *    восстановление на другом устройстве.
 *
 * Почему не одна база, без файла: снимок нужен как `file://` — его читает
 * <Image> на экране профиля и его же заливает вложением рассылка карточки.
 * Держать вместо этого base64-строку в памяти каждого экрана незачем.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { avatarFileName, avatarUriFromName, newAvatarUri } from '../media/avatarFiles';
import { ownFieldGetFor, ownFieldSetFor } from './ownProfile';
import { profileManager } from './profileManager';
import { log } from '../logger';

/** Где лежит имя файла. */
const NAME_KEY = 'user_avatar_uri' as const;
/** Где лежат сами байты: base64 того же JPEG, что и в файле. */
const IMG_KEY = 'user_avatar_img' as const;

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

async function fileExists(uri: string): Promise<boolean> {
  try {
    return (await FileSystem.getInfoAsync(uri)).exists;
  } catch {
    return false;
  }
}

/** Положить байты файла в базу. Не вышло — снимок всё равно показан из файла. */
async function keepBytes(pid: number, uri: string): Promise<void> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    if (b64 && !(await ownFieldSetFor(pid, IMG_KEY, b64))) log.warn('avatar_bytes_not_stored', { pid });
  } catch (e) {
    log.warn('avatar_bytes_read_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Имя файла фотографии активного профиля; пустая строка — фотографии нет. */
export async function ownAvatarName(): Promise<string> {
  return await ownAvatarNameFor(activeProfileId());
}

/**
 * Имя файла фотографии заданного профиля — устойчивый признак «какая это
 * фотография». Именно им, а не путём, следует помечать загрузки и считать
 * версию карточки: путь меняется от установки к установке, имя — нет.
 */
export async function ownAvatarNameFor(pid: number): Promise<string> {
  return avatarFileName(await ownFieldGetFor(pid, NAME_KEY));
}

/** Путь к фотографии активного профиля; `null` — фотографии нет. */
export async function ownAvatarUri(): Promise<string | null> {
  return await ownAvatarUriFor(activeProfileId());
}

/**
 * Путь к фотографии заданного профиля, годный прямо сейчас.
 *
 * Файла может не оказаться — тогда он пересобирается из базы, за этим байты
 * там и лежат. Запись в kv по дороге приводится к имени: пока там путь,
 * следующее обновление сломает её снова.
 */
export async function ownAvatarUriFor(pid: number): Promise<string | null> {
  const stored = (await ownFieldGetFor(pid, NAME_KEY)) ?? '';
  let name = avatarFileName(stored);
  let uri = avatarUriFromName(name);
  if (uri && (await fileExists(uri))) {
    // Путь в записи означает, что снимок выбран версией до v4.32.556 и в базе
    // его ещё нет. Забираем байты один раз — дальше в записи стоит имя, и
    // сюда мы больше не заходим.
    if (stored !== name) await keepBytes(pid, uri);
  } else {
    const b64 = await ownFieldGetFor(pid, IMG_KEY);
    if (!b64) return null;
    // Имени может не быть вовсе — тогда запись сделана так давно, что от неё
    // остались одни байты; заводим файлу новое имя.
    const dst = uri || newAvatarUri(Date.now());
    try {
      await FileSystem.writeAsStringAsync(dst, b64, { encoding: FileSystem.EncodingType.Base64 });
    } catch (e) {
      log.warn('avatar_restore_failed', { err: e instanceof Error ? e.message : String(e) });
      return null;
    }
    uri = dst;
    name = avatarFileName(dst);
    log.info('avatar_restored_from_db', { pid });
  }
  if (name && stored !== name) await ownFieldSetFor(pid, NAME_KEY, name);
  return uri || null;
}

/**
 * Сохранить выбранный снимок активному профилю. Возвращает путь к файлу или
 * `null`, если сохранить не удалось, — экран обязан сказать об этом человеку,
 * а не ответить «сохранено» на несделанную работу.
 *
 * Прежний файл удаляется только после успеха: пока новый не лёг, старое лицо
 * лучше пустого кружка.
 */
export async function saveOwnAvatar(srcUri: string): Promise<string | null> {
  const pid = activeProfileId();
  const prev = avatarUriFromName(await ownAvatarNameFor(pid));
  const dst = newAvatarUri(Date.now());
  try {
    await FileSystem.copyAsync({ from: srcUri, to: dst });
  } catch (e) {
    log.warn('avatar_copy_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
  // Сначала имя, потом байты: не легло имя — снимка нет вовсе, и байты в базе
  // остались бы от фотографии, которой человек не увидит.
  if (!(await ownFieldSetFor(pid, NAME_KEY, avatarFileName(dst)))) {
    try { await FileSystem.deleteAsync(dst, { idempotent: true }); } catch { /* ignore */ }
    return null;
  }
  await keepBytes(pid, dst);
  if (prev && prev !== dst) {
    try { await FileSystem.deleteAsync(prev, { idempotent: true }); } catch { /* ignore */ }
  }
  return dst;
}
