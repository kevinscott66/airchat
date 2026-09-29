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
import { AVATAR_NAME_KEY } from './avatarKeep';
import { ownFieldSetFor, ownFieldTryGetFor } from './ownProfile';
import { profileManager } from './profileManager';
import { log } from '../logger';

/** Где лежит имя файла: то же имя ключа, что читает уборка (см. avatarKeep). */
const NAME_KEY = AVATAR_NAME_KEY;
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

/**
 * Положить байты файла в базу.
 *
 * Возвращает и сами байты, и лёг ли они в базу, потому что спрашивают об этом
 * по-разному: сохранению снимка важно, что запись состоялась (без неё снимок
 * не переживёт обновления), а рассылке важны байты — записались они или нет,
 * отправить наружу можно те, что уже в руках.
 *
 * v4.32.1039: `read` разводит два пустых ответа. Пустой файл — это «снимка
 * нет», и справочник по @имени правильно снимает выставленное фото. Отказ
 * диска — не утверждение ни о чём, и такой же ответ означал бы, что фото
 * пропадает у всех по осечке чтения.
 */
async function keepBytes(
  pid: number,
  uri: string,
): Promise<{ b64: string | null; stored: boolean; read: 'ok' | 'empty' | 'failed' }> {
  let b64: string;
  try {
    b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch (e) {
    log.warn('avatar_bytes_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return { b64: null, stored: false, read: 'failed' };
  }
  if (!b64) {
    log.warn('avatar_bytes_empty', { pid });
    return { b64: null, stored: false, read: 'empty' };
  }
  const stored = await ownFieldSetFor(pid, IMG_KEY, b64);
  if (!stored) log.warn('avatar_bytes_not_stored', { pid });
  return { b64, stored, read: 'ok' };
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
  return (await ownAvatarNameTryFor(pid)) ?? '';
}

/**
 * То же имя файла, но с отдельным ответом «не прочитали» (v4.32.1023).
 *
 * `null` — запись на месте и не открылась; пустая строка — фотографии нет.
 * Строчная форма выше сводит оба случая к пустой строке, и месту, которое
 * просто показывает фотографию, этого довольно: рисовать нечего и там, и там.
 * А рассылке карточки — нет: пустое имя означает у неё «фотографии нет», и
 * получатель по такому конверту стирает `avatarCid` у себя (см. contacts,
 * setPeerProfileForChecked). Отказ базы обходился бы контактам в пропавшее
 * лицо.
 */
export async function ownAvatarNameTryFor(pid: number): Promise<string | null> {
  const cell = await ownFieldTryGetFor(pid, NAME_KEY);
  return cell === null ? null : avatarFileName(cell.text);
}

/** Путь к фотографии активного профиля; `null` — фотографии нет. */
export async function ownAvatarUri(): Promise<string | null> {
  return await ownAvatarUriFor(activeProfileId());
}

/**
 * Путь к фотографии активного профиля с отдельным ответом «не прочитали»
 * (v4.32.1065): `null` — ячейка на месте и не открылась, `{ uri: null }` —
 * фотографии нет.
 */
export async function ownAvatarUriTry(): Promise<{ uri: string | null } | null> {
  return await ownAvatarUriTryFor(activeProfileId());
}

/**
 * Путь к фотографии заданного профиля, годный прямо сейчас.
 *
 * Сводит «фотографии нет» и «прочитать не смогли» к одному `null`. Месту,
 * которое просто рисует кружок на экране, этого довольно: показать нечего и
 * там, и там. Всем, кто из ответа делает ВЫВОД о фотографии, — нет, см.
 * `ownAvatarUriTryFor`.
 */
export async function ownAvatarUriFor(pid: number): Promise<string | null> {
  return (await ownAvatarUriTryFor(pid))?.uri ?? null;
}

/**
 * То же, но «не прочитали» отдельно от «фотографии нет» (v4.32.1039).
 *
 * `null` — ячейка на месте и не открылась; `{ uri: null }` — фотографии нет.
 * Оба чтения здесь идут в шифрованные ячейки карточки, и отказ у них общий:
 * нет ключа шифрования при закрытом устройстве, занят SQLite. Разница ценой
 * в лицо — и не только на своём экране: на пустой ответ отсюда рассылка
 * карточки (social/profileSync) отправляла конверт БЕЗ `avatarCid`, а
 * получатель по такому конверту стирает фотографию у себя
 * (`setPeerProfileForChecked`), и справочник по @имени получал `del`
 * (social/publicAvatar) — то есть снимок пропадал разом у всех.
 *
 * Файла может не оказаться — тогда он пересобирается из базы, за этим байты
 * там и лежат. Запись в kv по дороге приводится к имени: пока там путь,
 * следующее обновление сломает её снова.
 */
export async function ownAvatarUriTryFor(pid: number): Promise<{ uri: string | null } | null> {
  const readName = await ownFieldTryGetFor(pid, NAME_KEY);
  if (readName === null) return null;
  const stored = readName.text ?? '';
  let name = avatarFileName(stored);
  let uri = avatarUriFromName(name);
  if (uri && (await fileExists(uri))) {
    // Путь в записи означает, что снимок выбран версией до v4.32.556 и в базе
    // его ещё нет. Забираем байты один раз — дальше в записи стоит имя, и
    // сюда мы больше не заходим.
    if (stored !== name) await keepBytes(pid, uri);
  } else {
    const readImg = await ownFieldTryGetFor(pid, IMG_KEY);
    if (readImg === null) return null;
    const b64 = readImg.text;
    if (!b64) return { uri: null };
    // Имени может не быть вовсе — тогда запись сделана так давно, что от неё
    // остались одни байты; заводим файлу новое имя.
    const dst = uri || newAvatarUri(Date.now());
    try {
      await FileSystem.writeAsStringAsync(dst, b64, { encoding: FileSystem.EncodingType.Base64 });
    } catch (e) {
      log.warn('avatar_restore_failed', { err: e instanceof Error ? e.message : String(e) });
      // Байты есть, а положить их файлом не вышло: это не «фотографии нет».
      return null;
    }
    uri = dst;
    name = avatarFileName(dst);
    log.info('avatar_restored_from_db', { pid });
  }
  if (name && stored !== name) await ownFieldSetFor(pid, NAME_KEY, name);
  return { uri: uri || null };
}

/**
 * Сохранить выбранный снимок активному профилю. Возвращает путь к файлу или
 * `null`, если сохранить не удалось, — экран обязан сказать об этом человеку,
 * а не ответить «сохранено» на несделанную работу.
 *
 * Прежний файл удаляется только после успеха: пока новый не лёг, старое лицо
 * лучше пустого кружка.
 *
 * v4.32.1010: байты — тоже успех, а не украшение. Раньше их незаписанность
 * сходила с рук: путь возвращался, экран отвечал «Фото профиля обновлено», а
 * в базе оставалось имя НОВОГО файла при байтах ПРЕЖНЕГО. Это состояние
 * ложное насквозь: имя и байты — одна запись, и та половина, что уезжает в
 * облако и на второе устройство, показывала бы там прежнее лицо под видом
 * нового. Стоит файлу пропасть (обновление, чистка, перенос) — и прежний
 * снимок вернётся уже и на этом устройстве, ровно тот случай, ради которого
 * в v4.32.309 и заведён отказ.
 */
export async function saveOwnAvatar(srcUri: string): Promise<string | null> {
  const pid = activeProfileId();
  const prevName = await ownAvatarNameFor(pid);
  const prev = avatarUriFromName(prevName);
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
  if (!(await keepBytes(pid, dst)).stored) {
    // Возвращаем имя прежнего снимка (пустое — значит его и не было): к
    // байтам в базе оно подходит, а имя нового файла — уже нет. Порядок тот
    // же, что и при успехе: сначала запись, потом файл, чтобы имя ни на
    // мгновение не указывало на удалённое.
    if (!(await ownFieldSetFor(pid, NAME_KEY, prevName))) log.warn('avatar_name_rollback_failed', { pid });
    try { await FileSystem.deleteAsync(dst, { idempotent: true }); } catch { /* ignore */ }
    return null;
  }
  if (prev && prev !== dst) {
    try { await FileSystem.deleteAsync(prev, { idempotent: true }); } catch { /* ignore */ }
  }
  return dst;
}

/**
 * Байты фотографии заданного профиля, base64 — то же, что лежит в файле.
 *
 * `null` здесь значит «фотографии нет», и только это. Читать одну базу
 * нельзя: снимок, выбранный до v4.32.556, лежит только файлом, и туда же
 * попадает снимок, чью запись байтов не приняли. Отсюда чтение с диска — файл
 * рядом, и спрашивающий получает ответ про ту фотографию, которую человек
 * видит у себя на экране, а не про её половину в базе.
 *
 * v4.32.1010: до этой версии «в базе пусто» отвечали `null`, и рассылка
 * (social/publicAvatar) читала это как «фотографии нет» — то есть СНИМАЛА в
 * справочнике снимок, который человек только что выбрал и видит перед собой.
 */
export async function ownAvatarBytesFor(pid: number): Promise<string | null> {
  return (await ownAvatarBytesTryFor(pid))?.b64 ?? null;
}

/**
 * То же, но «не прочитали» отдельно от «фотографии нет» (v4.32.1039).
 *
 * `null` — ячейку открыть не удалось; `{ b64: null }` — фотографии нет.
 * Единственный спрашивающий — справочник по @имени: на «нет» он шлёт `del`,
 * то есть снимает выставленное фото у всех, кто смотрит карточку. Вывести
 * такое из нечитаемой ячейки нельзя, поэтому разница и заведена.
 */
export async function ownAvatarBytesTryFor(pid: number): Promise<{ b64: string | null } | null> {
  const read = await ownAvatarUriTryFor(pid);
  if (read === null) return null;
  if (!read.uri) return { b64: null };
  const stored = await ownFieldTryGetFor(pid, IMG_KEY);
  if (stored === null) return null;
  if (stored.text) return { b64: stored.text };
  // Байты в базе пусты, а файл есть: снимок выбран версией до v4.32.556 либо
  // его запись не приняли. Дочитываем с диска. Отказ диска здесь тоже не
  // «фотографии нет» — файл мы только что видели; а вот пустой файл именно
  // это и значит (см. keepBytes).
  const kept = await keepBytes(pid, read.uri);
  return kept.read === 'failed' ? null : { b64: kept.b64 };
}
