/**
 * Node-замена `expo-sqlite` поверх встроенного `node:sqlite`.
 *
 * ─── Почему `node:sqlite`, а не `better-sqlite3` ────────────────────────────
 *
 * `better-sqlite3` быстрее и давно обкатан, но это нативный аддон: его нужно
 * собрать под конкретную версию Node и под конкретный ABI, а значит на машине
 * должен стоять компилятор, и каждое обновление Node требует пересборки.
 * Смысл этого этапа — «ядро живёт вне телефона», и добавлять к нему условие
 * «и вне телефона есть toolchain» не хочется: поднимать ядро будут в том
 * числе там, где ставить ничего нельзя.
 *
 * `node:sqlite` приезжает вместе с Node 22 и не требует ничего. Цена — метка
 * «экспериментальный»: при первом обращении Node печатает предупреждение, а
 * API может измениться в следующей мажорной версии. Поверхность, которой
 * пользуется ядро, при этом крошечная (prepare/run/all/get/exec/close), и
 * заменить основание на `better-sqlite3` — это правка одного этого файла.
 *
 * ─── Что именно подменяется ────────────────────────────────────────────────
 *
 * Ядро знает у соединения ровно шесть методов — `runAsync`, `getAllAsync`,
 * `getFirstAsync`, `execAsync`, `withTransactionAsync`, `closeAsync` (тот же
 * список, что перечислен в границах `dbLease`). Их и отдаём.
 *
 * `node:sqlite` синхронен, а ядро ждёт обещаний. Обёртка выполняет оператор
 * сразу и отдаёт уже готовый результат: это честно — работа действительно
 * закончена к моменту возврата, — но означает, что долгий оператор
 * задерживает весь цикл событий, включая сокет relay. Для одиночного
 * headless-процесса это приемлемо; очередь операторов (`sqlGate`) поверх
 * всё равно не даёт им перемешиваться.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { documentDir } from '../runtime/workdir';

/**
 * Что `node:sqlite` принимает параметром оператора. Тип объявлен здесь, а не
 * взят из `@types/node`: модуль экспериментальный, и его описание типов имя
 * для этого набора не экспортирует.
 */
type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * Путь базы повторяет раскладку expo: `<документы>/SQLite/<имя>`.
 *
 * Совпадение не декоративное: `wipeLocalDatabase` собирает эти пути сам, из
 * `FileSystem.documentDirectory`, чтобы после удаления базы проверить, что
 * файлов действительно не осталось. Положи мы базу в другое место — проверка
 * смотрела бы в пустоту и всегда докладывала об успехе.
 */
function databaseFile(name: string): string {
  return path.join(documentDir(), 'SQLite', name);
}

export type SQLiteBindValue = string | number | null | boolean | Uint8Array;

/**
 * Привести значение к тому, что `node:sqlite` соглашается связать с
 * параметром. Он принимает только null, число, строку, bigint и байты — на
 * `undefined` и на булевом он бросает «cannot be bound», причём сообщение не
 * называет ни оператора, ни номера параметра.
 *
 * Ядро же пишет булевы значения свободно: SQLite хранит их как 0/1, и на
 * телефоне это проходило молча. Перевод здесь — не послабление, а
 * восстановление того же поведения.
 */
function bind(value: unknown): SqliteValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new TypeError(`sqlite_unbindable_param: ${Object.prototype.toString.call(value)}`);
}

/** Хвост вызова у expo бывает и списком, и россыпью аргументов. */
function params(rest: unknown[]): SqliteValue[] {
  const flat = rest.length === 1 && Array.isArray(rest[0]) ? (rest[0] as unknown[]) : rest;
  return flat.map(bind);
}

export type SQLiteRunResult = { lastInsertRowId: number; changes: number };

export class SQLiteDatabase {
  constructor(
    private readonly handle: DatabaseSync,
    readonly databaseName: string
  ) {}

  async runAsync(sql: string, ...rest: unknown[]): Promise<SQLiteRunResult> {
    const r = this.handle.prepare(sql).run(...params(rest));
    // У expo поле называется `lastInsertRowId` (с большой I), у node:sqlite —
    // `lastInsertRowid`. Ядро читает первое.
    return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  async getAllAsync<T = unknown>(sql: string, ...rest: unknown[]): Promise<T[]> {
    return this.handle.prepare(sql).all(...params(rest)) as T[];
  }

  async getFirstAsync<T = unknown>(sql: string, ...rest: unknown[]): Promise<T | null> {
    // `get()` на пустой выборке отдаёт undefined, а весь вызывающий код
    // сравнивает с null и пишет `row?.field ?? …`.
    return (this.handle.prepare(sql).get(...params(rest)) as T | undefined) ?? null;
  }

  async execAsync(sql: string): Promise<void> {
    this.handle.exec(sql);
  }

  /**
   * Транзакция своими руками, как и в `dbLease`: нужен ровно тот же контракт —
   * откатить при исключении и не проглотить его.
   */
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.handle.exec('BEGIN');
    try {
      await task();
      this.handle.exec('COMMIT');
    } catch (e) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        /* Откатывать нечего: соединение уже сказало всё, что могло. */
      }
      throw e;
    }
  }

  async closeAsync(): Promise<void> {
    if (this.handle.isOpen) this.handle.close();
  }
}

const open = new Map<string, DatabaseSync>();

export async function openDatabaseAsync(name: string): Promise<SQLiteDatabase> {
  const file = databaseFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = new DatabaseSync(file);
  // WAL — то же, что делает expo-sqlite на телефоне. Без него читающий
  // оператор блокирует пишущего, и долгая транзакция останавливала бы чтение
  // целиком, а не пропускала его мимо себя.
  handle.exec('PRAGMA journal_mode=WAL;');
  handle.exec('PRAGMA foreign_keys=ON;');
  open.set(file, handle);
  return new SQLiteDatabase(handle, name);
}

export async function deleteDatabaseAsync(name: string): Promise<void> {
  const file = databaseFile(name);
  const handle = open.get(file);
  if (handle?.isOpen) handle.close();
  open.delete(file);
  // Спутники WAL сносятся вместе с базой: оставленный `-wal` при следующем
  // открытии того же имени восстановил бы часть только что удалённых строк.
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

export default { openDatabaseAsync, deleteDatabaseAsync, SQLiteDatabase };
