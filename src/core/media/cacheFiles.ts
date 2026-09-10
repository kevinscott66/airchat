/**
 * Временные файлы в cacheDirectory: кто их пишет и кто за ними убирает
 * (v4.32.310).
 *
 * Здесь оседает открытый текст. Экспорт переписки пишет расшифрованную беседу в
 * .txt, чтобы отдать её в «Поделиться»; сохранённый документ поста, вложения,
 * снимки — тоже расшифрованными файлами. Шифрование на диске (`enc2:`) до этих
 * файлов не достаёт: они и создаются затем, чтобы их прочитало другое
 * приложение.
 *
 * Пока имена придумывались на месте — а их было три на один и тот же экспорт
 * переписки (`airchat_export_`, `group_export_`, `chat_`), — за ними не убирал
 * НИКТО: ни «Очистить кэш» в настройках, ни суточная чистка вложений, ни сброс
 * устройства. Расшифрованная переписка лежала в кэше до тех пор, пока место не
 * понадобится системе.
 *
 * Поэтому имена знает один модуль, и он же держит списки для уборки.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { log } from '../logger';
import { cacheFileBlobId, sweepVerdict } from './cacheSweepPolicy';

/**
 * Приставки файлов, каждый из которых может быть единственной копией вложения.
 *
 * v4.32.702. Список тот же, по которому ходит суточная уборка (mediaBlob), и
 * причина, по которой он отделён от остальных, изложена в cacheSweepPolicy:
 * у шифртекста, доехавшего по LAN, ссылки на сеть нет вовсе, а расшифрованная
 * копия приехавшего с релея переживает само вложение — оно живёт на ntfy около
 * трёх часов. Стереть такой файл значит стереть вложение из живой переписки:
 * строка на месте, превью на месте, а по нажатию — ничего.
 */
export const REFERENCED_CACHE_PREFIXES = ['airchat_media_', 'airchat_blobcache_'] as const;

/** Откуда «Очистить кэш» берёт список ещё нужных вложений. */
export type LiveBlobIdsLoader = () => Promise<ReadonlySet<string>>;

/**
 * Префиксы, которые убирает «Очистить кэш» в настройках.
 *
 * Список осторожный: приложение в этот момент работает, и снести файл, который
 * прямо сейчас показывают, значит получить пустой квадрат вместо картинки.
 * Поэтому здесь только то, что уже отдано наружу или пересоздаётся по запросу.
 */
export const CLEARABLE_CACHE_PREFIXES = [
  'airchat_export_',
  'ac_share_',
  'img_',
  'thumb_',
  'translate_',
  'preview_',
  'dlg-import-',
  'ExponentExperienceData',
] as const;

/**
 * Префиксы, которые убирает полный сброс устройства.
 *
 * Здесь осторожничать не перед кем: профилей не осталось, показывать нечего, а
 * всё перечисленное — расшифрованное содержимое чужой теперь переписки.
 */
export const WIPE_CACHE_PREFIXES = [
  ...CLEARABLE_CACHE_PREFIXES,
  // Сброс — единственное место, где вложения уходят безусловно: профилей не
  // осталось, и терять уже нечего.
  ...REFERENCED_CACHE_PREFIXES,
  // Документы и картинки постов ленты: `feed_<postId>_<i>_<имя>`, `feed_q_*.img`.
  'feed_',
  // Промежуточный файл выгрузки в IPFS.
  'ipfs_http_add_',
] as const;

/** Расширения медиа, которые «Очистить кэш» убирает независимо от имени. */
export const CLEARABLE_CACHE_SUFFIXES = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov'] as const;

/** Откуда выгрузка: переписка с человеком или группа. */
export type ExportKind = 'chat' | 'group';

/**
 * Имя файла для выгрузки переписки в открытом виде.
 *
 * Вид выгрузки попадает в имя, чтобы человек в «Поделиться» видел, что именно
 * отдаёт. Перечисление, а не строка: имя файла всплывает в чужих приложениях и
 * в списке недавних, и подставить туда имя собеседника или название группы
 * значило бы выдать ровно тот факт «кто с кем», который вся переписка и прячет.
 * С открытым типом это было бы вопросом невнимательности одного вызова.
 */
export function exportTextCacheUri(kind: ExportKind, stampMs: number): string {
  return `${FileSystem.cacheDirectory ?? ''}airchat_export_${kind}_${stampMs}.txt`;
}

/**
 * Отдать выгруженную переписку в «Поделиться» (v4.32.313).
 *
 * Отдача была написана трижды — в карточке контакта, в меню переписки и в меню
 * группы, — и все три расходились ровно там, где «Поделиться» недоступно. Двое
 * показывали `file:///…/cache/…` — путь, который человеку некуда ввести, — а
 * третий отправлял ВСЮ переписку текстом сообщения. Второе не безобидно: на
 * Android содержимое так уезжает через Binder, который рвётся примерно на
 * мегабайте (переписка на пару тысяч строк — это уже он), а до разрыва
 * расшифрованная беседа целиком ложится в буфер принимающего приложения вместо
 * файла, который оно бы просто сохранило.
 *
 * Поэтому отдача одна и здесь же, рядом с именем файла: выгрузка — это про
 * временный файл в кэше, а кто за ним убирает, знает этот модуль.
 *
 * Возвращает `false`, если системного «Поделиться» нет: файл при этом записан,
 * и решать, что сказать человеку, — дело экрана.
 */
export async function shareTextExport(
  kind: ExportKind,
  content: string,
  dialogTitle: string,
  stampMs: number
): Promise<boolean> {
  const uri = exportTextCacheUri(kind, stampMs);
  await FileSystem.writeAsStringAsync(uri, content, { encoding: 'utf8' });
  if (!(await Sharing.isAvailableAsync())) {
    log.warn('export_sharing_unavailable', { kind });
    return false;
  }
  await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle, UTI: 'public.plain-text' });
  return true;
}

async function deleteByPrefixes(
  prefixes: readonly string[],
  suffixes: readonly string[],
  spare: (name: string) => boolean = () => false
): Promise<number> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return 0;
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch (e) {
    log.warn('cache_sweep_scan_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (spare(name)) continue;
    const lower = name.toLowerCase();
    if (!prefixes.some((p) => name.startsWith(p)) && !suffixes.some((s) => lower.endsWith(s))) continue;
    try {
      await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
      removed++;
    } catch {
      // Один файл не удалился — остальные всё равно надо убрать.
    }
  }
  return removed;
}

/**
 * «Очистить кэш» в настройках. Возвращает число удалённых файлов.
 *
 * v4.32.702: вложения уходят не все подряд, а только те, на которые не
 * ссылается ни одна уцелевшая строка базы. До этой версии одно нажатие без
 * подтверждения стирало `airchat_media_*` и `airchat_blobcache_*` целиком — и
 * это ровно тот дефект, который у суточной уборки закрыт в v4.32.518, только
 * там условием был хотя бы возраст, а здесь не было и его. Под надписью
 * «Удалить временные файлы и освободить место» из живой переписки пропадали
 * снимки, голосовые и документы, и восстановить их нечем и неоткуда.
 *
 * Правило одно на оба места и живёт в cacheSweepPolicy; здесь возраст не
 * проверяется намеренно — человек попросил освободить место сейчас, — а
 * `ageMs = Infinity` при `ttlMs = 0` оставляет от вердикта ровно сверку со
 * списком живых ссылок. Не получив список, не удаляем ничего.
 */
export async function clearCacheFiles(loadLiveIds: LiveBlobIdsLoader): Promise<number> {
  const referenced = (name: string) => cacheFileBlobId(name, REFERENCED_CACHE_PREFIXES) !== null;
  const removed = await deleteByPrefixes(CLEARABLE_CACHE_PREFIXES, CLEARABLE_CACHE_SUFFIXES, referenced);
  return removed + (await clearUnreferencedBlobFiles(loadLiveIds));
}

/**
 * Вложения, на которые больше никто не ссылается.
 *
 * Порядок тот же, что у суточной уборки: сначала дешёвый проход по каталогу и
 * только потом — расшифровка всей переписки ради списка живых ссылок. На кэше
 * без вложений чистка стоит одного чтения каталога.
 */
async function clearUnreferencedBlobFiles(loadLiveIds: LiveBlobIdsLoader): Promise<number> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return 0;
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch (e) {
    log.warn('cache_sweep_scan_failed', { err: e instanceof Error ? e.message : String(e) });
    return 0;
  }
  const candidates = names.filter((name) => cacheFileBlobId(name, REFERENCED_CACHE_PREFIXES) !== null);
  if (candidates.length === 0) return 0;
  // Сбой — занятая база, недоступный ключ, неполный обход — оставляет liveIds
  // равным null, а null останавливает уборку целиком: место на диске вернётся
  // при следующей попытке, удалённое вложение не вернётся никогда.
  let liveIds: ReadonlySet<string> | null = null;
  try {
    liveIds = await loadLiveIds();
  } catch (e) {
    log.warn('cache_clear_live_refs_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  let removed = 0;
  for (const name of candidates) {
    if (sweepVerdict(name, Infinity, 0, REFERENCED_CACHE_PREFIXES, liveIds) !== 'delete') continue;
    try {
      await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
      removed++;
    } catch {
      // Один файл не удалился — остальные всё равно надо убрать.
    }
  }
  if (removed > 0) log.info('cache_cleared_unreferenced', { removed, kept: candidates.length - removed });
  return removed;
}

/**
 * Полный сброс устройства: убрать всё расшифрованное из кэша.
 *
 * До v4.32.308 сброс не трогал кэш вовсе, и снимки с голосовыми жили ещё сутки
 * — до суточной чистки, и то если приложение успеют запустить. С v4.32.308
 * уходили вложения, но не расшифровки переписки: у них не было ни общего имени,
 * ни хозяина.
 */
export async function purgeSensitiveCache(): Promise<number> {
  const removed = await deleteByPrefixes(WIPE_CACHE_PREFIXES, CLEARABLE_CACHE_SUFFIXES);
  if (removed > 0) log.info('cache_purged_on_wipe', { removed });
  return removed;
}
