/**
 * Папки списка чатов: цветная метка переписки → название папки, которое человек
 * придумал сам («Врач», «Работа», «Адвокат»).
 *
 * v4.32.294. Названия лежали одной записью `folder_names` — общей для
 * устройства и открытым текстом, — а вся работа с ней жила прямо в JSX
 * ChatListScreen. Что из этого следовало:
 *
 * - Метки переписок принадлежат профилю (colour_tag в conversations, с
 *   owner_profile_id), а названия папок — нет. Второй аккаунт получал в шапке
 *   чужие вкладки: «Врач», «Адвокат», «Долг» — от человека, с которым его как
 *   раз и не должно было ничто связывать. Тот же класс, что общий блок-лист
 *   (v4.32.281), список переписок (v4.32.290) и заглушённые в ленте (v4.32.293).
 * - Удаление профиля названия не уносило: уборка ищет `p<id>:%`.
 * - Открытым текстом в базе. Название папки — это ярлык, который человек дал
 *   группе своих контактов, то есть сведения ровно о них.
 * - Разбор проверял только «объект и не массив». Значения не проверялись
 *   вовсе, а вкладка рисует `{name}`: подменённое `{"#e74c3c": {"a": 1}}`
 *   роняло экран списка чатов целиком («Objects are not valid as a React
 *   child»). Ни числа папок, ни длины названия тоже никто не ограничивал.
 * - Запись была скопирована в два обработчика подряд («Сохранить» с пустым
 *   полем и «Удалить папку»), и оба писали в kv, не проверяя результат.
 */
import { log } from '../logger';
import { isColorTag } from './conversationMeta';
import { tryReadProfileSharedSecret, writeProfileSharedSecret } from './profileSharedKv';

export const FOLDER_NAMES_KEY = 'folder_names';

/**
 * Палитра меток. Лежит здесь, а не на экране: значение метки — это и ключ
 * записи названий, поэтому правило «что бывает меткой» должно быть одно на
 * запись, чтение и проверку. (Заодно список перестал пересобираться на каждый
 * рендер списка чатов.)
 */
export const FOLDER_COLORS = [
  { label: 'Красный', value: '#e74c3c' },
  { label: 'Оранжевый', value: '#e67e22' },
  { label: 'Жёлтый', value: '#f1c40f' },
  { label: 'Зелёный', value: '#2ecc71' },
  { label: 'Голубой', value: '#3498db' },
  { label: 'Фиолетовый', value: '#9b59b6' },
  { label: 'Розовый', value: '#e91e8c' },
] as const;

/** Больше — уже не «папки», а испорченная или подложенная запись. */
const MAX_FOLDERS = 32;
/** Во вкладку всё равно не помещается; длинное название — признак подмены. */
export const FOLDER_NAME_MAX_LEN = 40;

export type FolderNames = Record<string, string>;

/**
 * Чем кончилась попытка записи (v4.32.904).
 *
 * Прежде и удача, и неудача возвращались набором названий: при отказе — тем,
 * что лежало в базе до попытки. Экран отличал от него только `null` («не
 * прочитали»), а остальные отказы принимал за удачу — окно переименования
 * закрывалось, и человек уходил с уверенностью, что папка названа.
 *
 * `names` при отказе — то, что в базе на самом деле: шапку по нему всё равно
 * можно освежить, соврав при этом только в одном — в молчании, которого
 * теперь нет.
 */
export type FolderWrite =
  | { ok: true; names: FolderNames }
  | { ok: false; why: 'unreadable'; names: null }
  | { ok: false; why: 'write_failed' | 'limit' | 'bad_color'; names: FolderNames };

/** Предел числа папок — показывается человеку, когда он в него упёрся. */
export { MAX_FOLDERS };

/**
 * Ключом может быть только цвет метки — то же правило, что у самой метки
 * переписки (v4.32.295, conversationMeta.isColorTag): разъехавшись, они дали бы
 * метку, для которой папку не назвать. Палитрой не ограничиваемся: она менялась
 * и ещё поменяется, а папка, созданная на прошлой версии, не должна молча
 * исчезать вместе с названием.
 */
const isColorKey = isColorTag;

/** Разбор с границами. Всё, что не подошло, отбрасывается поштучно. */
export function parseFolderNames(raw: string | null): FolderNames {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FolderNames = {};
    let count = 0;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isColorKey(key)) continue;
      if (typeof value !== 'string') continue;
      const name = value.trim().slice(0, FOLDER_NAME_MAX_LEN);
      // Пустое название — вкладка без подписи, в которую нельзя попасть и
      // которую нельзя отличить от отсутствующей папки.
      if (!name) continue;
      out[key] = name;
      if (++count >= MAX_FOLDERS) break;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Названия папок активного профиля (со снятием старой общей записи).
 * `null` — не прочитали.
 */
async function readFolderNames(): Promise<FolderNames | null> {
  try {
    const read = await tryReadProfileSharedSecret(FOLDER_NAMES_KEY);
    return read === null ? null : parseFolderNames(read.value);
  } catch (e) {
    log.warn('folder_names_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Для показа: не прочитали — рисуем шапку без вкладок, ничего при этом не теряя. */
export async function loadFolderNames(): Promise<FolderNames> {
  return (await readFolderNames()) ?? {};
}

/**
 * Задать (или, при пустом названии, удалить) папку. Возвращает то, что
 * действительно записано: интерфейс показывает состояние базы, а не своё
 * предположение о нём.
 *
 * Текущий набор перечитывается здесь же, а не приходит с экрана: писать
 * `{...folderNames}` из состояния React значило бы затирать изменения, о
 * которых экран ещё не знает.
 *
 * `ok: false` — не записано, и `why` говорит почему. v4.32.699: перечитывание
 * отвечало пустым набором и на отказ базы, а записывается набор целиком —
 * значит переименование одной папки стирало названия всех остальных.
 * v4.32.904: неудача возвращалась прежним набором, то есть объектом, и экран
 * её не отличал — окно закрывалось как после удачи.
 */
export async function setFolderName(color: string, rawName: string): Promise<FolderWrite> {
  const current = await readFolderNames();
  if (current === null) {
    log.warn('folder_names_unreadable', { color });
    return { ok: false, why: 'unreadable', names: null };
  }
  if (!isColorKey(color)) {
    log.warn('folder_names_bad_color', { len: color.length });
    return { ok: false, why: 'bad_color', names: current };
  }
  const name = rawName.trim().slice(0, FOLDER_NAME_MAX_LEN);
  const next = { ...current };
  if (!name) {
    // Папки и так нет: просить нечего, и в базе уже то, что человек хотел.
    if (!(color in next)) return { ok: true, names: current };
    delete next[color];
  } else {
    if (next[color] === name) return { ok: true, names: current };
    if (!(color in next) && Object.keys(next).length >= MAX_FOLDERS) {
      log.warn('folder_names_limit', { count: Object.keys(next).length });
      return { ok: false, why: 'limit', names: current };
    }
    next[color] = name;
  }
  if (!(await writeProfileSharedSecret(FOLDER_NAMES_KEY, JSON.stringify(next)))) {
    log.warn('folder_names_write_failed', { color });
    return { ok: false, why: 'write_failed', names: current };
  }
  return { ok: true, names: next };
}

/** Удалить папку. Метки с переписок не снимает — они принадлежат перепискам. */
export async function removeFolderName(color: string): Promise<FolderWrite> {
  return await setFolderName(color, '');
}
