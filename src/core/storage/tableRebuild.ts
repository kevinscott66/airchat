/**
 * Перенос колонок при пересборке таблицы (v4.32.467).
 *
 * SQLite не умеет менять первичный ключ у существующей таблицы: её создают
 * заново и переливают содержимое. Список колонок при этом обычно пишут в коде
 * миграции руками — и он устаревает молча. У `groups` за тридцать с лишним
 * версий колонки добавлялись по одной (`ALTER TABLE`), так что захардкоженный
 * список потерял бы ту, что появилась последней: пользователь не увидел бы
 * ошибки, просто у части групп обнулился бы, скажем, срок исчезающих
 * сообщений.
 *
 * Поэтому список берётся у самой базы (`PRAGMA table_info`), а этот модуль
 * превращает ответ PRAGMA в кусок DDL. Он чистый и без зависимостей — ровно
 * чтобы его можно было проверить тестом, а не только глазами.
 */

/** Строка ответа `PRAGMA table_info(<таблица>)`, в тех полях, что нам нужны. */
export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

export interface RebuildColumns {
  /** Объявления колонок для CREATE TABLE, по одной на строку. */
  decls: string;
  /** Те же колонки через запятую — для INSERT … SELECT. */
  names: string;
  /** Что не переносим: имена, не похожие на нашу схему. */
  skipped: string[];
}

/**
 * Имя колонки попадает в DDL подстановкой, поэтому оно должно быть именем, а
 * не выражением. Всё, что приходит из PRAGMA, писала наша же схема, но
 * проверка стоит здесь, а не в вызывающем коде: правило «в DDL уходит только
 * это» удобнее держать рядом с самой подстановкой.
 */
const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;
/** Тип — тоже подстановка; всё непонятное станет TEXT (SQLite типы не строгие). */
const SAFE_TYPE = /^[A-Za-z ]+$/;

export function rebuildColumns(cols: ColumnInfo[], indent = '  '): RebuildColumns {
  const safe = cols.filter((c) => SAFE_NAME.test(c.name));
  const skipped = cols.filter((c) => !SAFE_NAME.test(c.name)).map((c) => c.name);
  const decls = safe
    .map((c) => {
      const type = SAFE_TYPE.test(c.type) ? c.type.trim() : 'TEXT';
      const nn = c.notnull ? ' NOT NULL' : '';
      // dflt_value приходит уже в том виде, в каком его писали в DDL:
      // строковые значения — вместе с кавычками. Кавычить ещё раз нельзя.
      const def = c.dflt_value == null ? '' : ` DEFAULT ${c.dflt_value}`;
      return `${indent}${c.name} ${type}${nn}${def}`;
    })
    .join(',\n');
  return { decls, names: safe.map((c) => c.name).join(', '), skipped };
}
