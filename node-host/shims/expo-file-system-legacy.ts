/**
 * Node-замена `expo-file-system/legacy` поверх `node:fs/promises`.
 *
 * Перенос, а не граница платформы: файловая система у Node настоящая, и
 * единственное, чего не хватает, — это песочница приложения, то есть ответ на
 * вопрос «где мои документы». Его даёт `runtime/workdir`.
 *
 * Адреса остаются в виде `file://…`, как их отдаёт настоящий expo-file-system,
 * и это не косметика: ядро на них полагается. `voiceUriPolicy` отличает своё
 * голосовое от чужого по `startsWith('file://')`, `ipfs/node` по тому же
 * признаку решает, дописывать схему или нет, а `mediaBlob` стирает кеш,
 * сверяя префикс адреса с `cacheDirectory`. Отдай мы голый путь — все три
 * проверки ответили бы «не наше».
 *
 * Расхождение с оригиналом одно и намеренное: `getInfoAsync` на
 * несуществующем пути возвращает `{ exists: false }`, а не бросает, — таков
 * контракт expo, и весь вызывающий код написан под него.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { cacheDir, documentDir, onWorkdir } from '../runtime/workdir';

/**
 * Каталоги — изменяемые привязки, а не константы.
 *
 * Модуль загружается раньше, чем `startCore` успевает назвать рабочий
 * каталог, поэтому значение проставляется подпиской. Внутри бандла esbuild
 * отдаёт такие экспорты через геттеры, так что `FileSystem.documentDirectory`
 * у потребителя читает текущее значение, а не снимок времени импорта.
 */
export let documentDirectory: string | null = null;
export let cacheDirectory: string | null = null;
export let bundleDirectory: string | null = null;

onWorkdir(() => {
  // Косая черта в конце обязательна: ядро строит пути конкатенацией —
  // `${documentDirectory}SQLite/${name}`, `${documentDirectory}airchat-config.json`.
  documentDirectory = `${pathToFileURL(documentDir()).href}/`;
  cacheDirectory = `${pathToFileURL(cacheDir()).href}/`;
  bundleDirectory = documentDirectory;
});

export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;

type Encoding = 'utf8' | 'base64' | (typeof EncodingType)[keyof typeof EncodingType];

/**
 * Превратить адрес в путь на диске.
 *
 * Принимаются обе формы — и `file://…`, и голый путь: часть вызывающего кода
 * получает адреса от нас же, а часть собирает их руками из имён файлов.
 */
function toPath(uri: string): string {
  if (uri.startsWith('file:')) return fileURLToPath(uri);
  return uri;
}

function toUri(p: string): string {
  return pathToFileURL(p).href;
}

/** Ошибки «нет такого файла» разбираются по коду, а не по тексту сообщения. */
function isMissing(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export type FileInfo = {
  exists: boolean;
  uri: string;
  size?: number;
  isDirectory?: boolean;
  modificationTime?: number;
};

export async function getInfoAsync(uri: string): Promise<FileInfo> {
  const p = toPath(uri);
  try {
    const st = await fs.stat(p);
    return {
      exists: true,
      uri: toUri(p),
      size: st.size,
      isDirectory: st.isDirectory(),
      // expo отдаёт время в секундах, а не в миллисекундах.
      modificationTime: Math.floor(st.mtimeMs / 1000),
    };
  } catch (e) {
    if (isMissing(e)) return { exists: false, uri: toUri(p), isDirectory: false };
    throw e;
  }
}

export async function readAsStringAsync(
  uri: string,
  options?: { encoding?: Encoding }
): Promise<string> {
  const enc = options?.encoding === 'base64' ? 'base64' : 'utf8';
  return fs.readFile(toPath(uri), enc);
}

export async function writeAsStringAsync(
  uri: string,
  contents: string,
  options?: { encoding?: Encoding }
): Promise<void> {
  const enc = options?.encoding === 'base64' ? 'base64' : 'utf8';
  const p = toPath(uri);
  // Родитель создаётся молча: нативный expo-file-system пишет в песочницу,
  // где каталог документов существует всегда, а здесь его может не быть —
  // и отказ был бы про отсутствующий каталог, а не про то, что писали.
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await fs.writeFile(p, contents, { encoding: enc, mode: 0o600 });
}

export async function deleteAsync(
  uri: string,
  options?: { idempotent?: boolean }
): Promise<void> {
  try {
    await fs.rm(toPath(uri), { recursive: true, force: false });
  } catch (e) {
    if (options?.idempotent && isMissing(e)) return;
    throw e;
  }
}

export async function makeDirectoryAsync(
  uri: string,
  options?: { intermediates?: boolean }
): Promise<void> {
  await fs.mkdir(toPath(uri), { recursive: options?.intermediates ?? false, mode: 0o700 });
}

export async function readDirectoryAsync(uri: string): Promise<string[]> {
  return fs.readdir(toPath(uri));
}

export async function copyAsync(options: { from: string; to: string }): Promise<void> {
  const to = toPath(options.to);
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await fs.cp(toPath(options.from), to, { recursive: true });
}

export async function moveAsync(options: { from: string; to: string }): Promise<void> {
  const to = toPath(options.to);
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await fs.rename(toPath(options.from), to);
}

/**
 * Свободное место на диске. Настоящее значение, а не выдуманное: ядро решает
 * по нему, браться ли за загрузку вложения, и завышенный ответ превратил бы
 * «не хватит места» в оборванную запись на полпути.
 */
export async function getFreeDiskStorageAsync(): Promise<number> {
  const st = await fs.statfs(documentDir()).catch(() => null);
  return st ? Number(st.bavail) * Number(st.bsize) : 0;
}

export async function getTotalDiskCapacityAsync(): Promise<number> {
  const st = await fs.statfs(documentDir()).catch(() => null);
  return st ? Number(st.blocks) * Number(st.bsize) : 0;
}
