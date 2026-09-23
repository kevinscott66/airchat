/**
 * v4.32.724: сорванный PRAGMA больше не выдают за «шифровать тут нечего».
 *
 * Дефект. `existingColumnsOf` спрашивает у базы, какие из нужных колонок в ней
 * есть, и ловил любую ошибку в пустой список. Пустой список — законный ответ
 * для отставшей схемы: `PRAGMA table_info` на несуществующую таблицу не падает,
 * а отдаёт ноль строк. Но единственный вызывающий — `reencryptAtRest`, и там
 * пустой список значит `continue`: таблицу пропускают.
 *
 * Чем это кончается. Пропущенная таблица остаётся под СТАРЫМ ключом, остальная
 * база переезжает под новый, транзакция фиксируется, и `persistDek` объявляет
 * новый ключ действующим — старого после этого нет нигде. Строки пропущенной
 * таблицы не открываются больше никогда: при `chat_messages` это вся переписка,
 * при kv с вложениями — все картинки ленты. Отказ чтения у SQLite не выдумка:
 * та же занятая база, то же «database is locked», что и в остальных местах
 * этого файла.
 *
 * Развязка та же, что у канарейки: отказ уходит наверх. Транзакция миграции
 * откатывается, установка остаётся такой, какой её взяли, следующий запуск
 * пробует снова — а половинчатой перешифровки не случается.
 *
 * Проверка идёт по исходнику: обход живёт внутри открытой транзакции, поднять
 * его в тесте нечем (тот же довод, что в `dekReencryptPaging625.test.ts`).
 */
import fs from 'fs';
import path from 'path';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

/** Тело функции: от заголовка до закрывающей скобки в нулевой колонке. */
function bodyOf(head: string): string {
  const start = LOCAL.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const end = LOCAL.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return LOCAL.slice(start, end);
}

/** Строки без комментариев — пояснение не должно подтверждать само себя. */
function codeOnly(body: string): string {
  return body
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const COLUMNS = codeOnly(bodyOf('async function existingColumnsOf('));
const REENCRYPT = codeOnly(bodyOf('async function reencryptAtRest('));

describe('опрос схемы не гасит отказ', () => {
  it('в existingColumnsOf не осталось ни одного перехвата', () => {
    expect(COLUMNS).not.toMatch(/catch/);
    expect(COLUMNS).toContain('await database.getAllAsync<{ name: string }>');
  });

  it('пустой список отдаётся только по существу, а не по ошибке', () => {
    // Единственный ранний выход — «спрашивать нечего»; остальное считает фильтр.
    expect((COLUMNS.match(/return /g) ?? []).length).toBe(2);
    expect(COLUMNS).toContain('if (wanted.length === 0) return [];');
    expect(COLUMNS).toContain('return wanted.filter((c) => have.has(c));');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: перешифровка в остальном не тронута', () => {
  it('пропуск таблицы по пустому списку остаётся — это про отставшую схему', () => {
    expect(REENCRYPT).toContain('const cols = await existingColumnsOf(database, spec.table, spec.columns);');
    expect(REENCRYPT).toContain('if (cols.length === 0) continue;');
  });

  it('вызывающий по-прежнему держит транзакцию и откатывает её на любой ошибке', () => {
    const code = codeOnly(LOCAL);
    const at = code.indexOf('await reencryptAtRest(database, stored, derived);');
    expect(at).toBeGreaterThan(-1);
    const around = code.slice(at - 200, at + 300);
    expect(around).toContain('const txn = await beginImmediate(database);');
    expect(around).toContain('await txn.rollback();');
    expect(around).toContain('throw e;');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('после перешифровки действующим объявляют новый ключ, а старого не остаётся', () => {
    const code = codeOnly(LOCAL);
    const reenc = code.indexOf('await reencryptAtRest(database, stored, derived);');
    const persist = code.indexOf('if (!(await persistDek(derived))) {', reenc);
    expect(reenc).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(reenc);
    // Отметка о пройденной миграции ставится после — второй попытки не будет.
    expect(code.indexOf(`'${'true'}',`, persist)).toBeGreaterThan(persist);
  });

  it('другого источника пустого списка у обхода нет: он сам решает по колонкам', () => {
    expect((REENCRYPT.match(/existingColumnsOf\(/g) ?? []).length).toBe(1);
    const all = codeOnly(LOCAL).match(/existingColumnsOf\(/g) ?? [];
    // Объявление и единственный вызов.
    expect(all.length).toBe(2);
  });
});
