/**
 * Рабочий каталог headless-экземпляра — единственный, куда ядру позволено
 * писать.
 *
 * На телефоне вопроса «куда» не возникает: у приложения ровно одна песочница,
 * и `documentDirectory` указывает в неё. В Node песочницы нет, и ядро,
 * запущенное дважды, по умолчанию открыло бы одну и ту же базу и один и тот
 * же secure-store — то есть второй экземпляр залез бы в переписку первого.
 * Поэтому корень здесь задаётся явно и до первого обращения к хранилищу, а
 * шимы `expo-file-system`, `expo-sqlite` и `expo-secure-store` ничего не
 * решают сами и спрашивают его тут.
 *
 * Корень отдаётся не значением, а подпиской. Разница существенная: импорты в
 * ESM выполняются раньше любого вызова, и шим, записавший путь в `const` при
 * загрузке модуля, зафиксировал бы его ещё до того, как запуск ядра успел
 * сказать, где работать. Подписка переносит это решение на момент, когда
 * каталог уже известен.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

type Listener = (root: string) => void;

let root: string | null = null;
const listeners = new Set<Listener>();

/**
 * Назначить рабочий каталог. Вызывается ровно один раз за процесс — из
 * `startCore`, первой же строкой, до того как что-либо коснётся диска.
 *
 * Повторное назначение другого каталога запрещено, и это не формальность:
 * половина ядра к этому моменту уже держит открытые дескрипторы и кеши в
 * памяти, привязанные к прежнему пути. Смена корня на ходу означала бы базу
 * из одного каталога и secure-store из другого.
 */
export function setWorkdir(dir: string): void {
  const resolved = path.resolve(dir);
  if (root !== null) {
    if (root === resolved) return;
    throw new Error(`workdir_already_set: ${root}`);
  }
  // 0700 на самом корне: ниже него лежат и база переписки, и обёрнутый ключ.
  // Права выставляются и на уже существующем каталоге — `mkdir recursive` для
  // существующего пути режим не меняет, а каталог мог остаться от прошлого
  // запуска с другой umask.
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  root = resolved;
  for (const listener of listeners) listener(root);
}

/** Текущий корень. Бросает, если запуск ядра его ещё не назначил. */
export function workdir(): string {
  if (root === null) throw new Error('workdir_not_set');
  return root;
}

/**
 * Аналог `FileSystem.documentDirectory`: каталог «документов» приложения.
 * Отдельная ступень под корнем нужна, чтобы служебное соседство (журнал
 * запуска, ключ обёртки secure-store) не перемешивалось с тем, что ядро
 * считает своими файлами и что оно вправе целиком стереть при выходе из
 * аккаунта.
 */
export function documentDir(): string {
  return path.join(workdir(), 'documents');
}

/** Аналог `FileSystem.cacheDirectory`. */
export function cacheDir(): string {
  return path.join(workdir(), 'cache');
}

/**
 * Подписаться на назначение корня. Если корень уже назначен, слушатель
 * вызывается немедленно — порядок загрузки модулей в бандле не задан, и шим
 * не должен зависеть от того, успел он подписаться раньше или позже.
 */
export function onWorkdir(listener: Listener): void {
  listeners.add(listener);
  if (root !== null) listener(root);
}
