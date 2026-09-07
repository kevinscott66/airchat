/**
 * v4.32.625. Смена DEK не должна упираться в память.
 *
 * reencryptAtRest читал каждую таблицу целиком, а следом — все строки kv с
 * шифртекстом. Третий запрос поднимал в память БАЙТЫ ВСЕХ вложений ленты
 * разом: одно вложение — до 8 МБ, то есть около 11 млн символов base64.
 * Полсотни фотографий, и переход на выводимый из seed ключ падал по памяти,
 * откатывался вместе с транзакцией и повторял то же самое при каждом запуске.
 * Наружу это выглядело как «восстановление по секретным словам не появляется».
 *
 * Проверяется форма исходника: сам обход внутри открытой транзакции и его в
 * тесте не поднять, а вернуть `SELECT ... FROM таблица` без предела — правка
 * на одну строку.
 */
import fs from 'fs';
import path from 'path';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

/** Тело reencryptAtRest: от заголовка до закрывающей скобки в нулевой колонке. */
function reencryptBody(): string {
  const start = LOCAL.indexOf('async function reencryptAtRest(');
  expect(start).toBeGreaterThan(-1);
  const end = LOCAL.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return LOCAL.slice(start, end);
}

/** Строки тела без комментариев — чтобы пояснение не подтверждало само себя. */
function codeLines(body: string): string {
  return body
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('смена DEK читает базу порциями', () => {
  it('каждое чтение в перешифровке ограничено пределом', () => {
    const code = codeLines(reencryptBody());
    const reads = code.match(/getAllAsync/g) ?? [];
    // ПРОВЕРКА НЕ ПУСТАЯ: три обхода — таблицы at-rest, шифртекст kv, вложения.
    expect(reads).toHaveLength(3);
    const limits = code.match(/LIMIT \?/g) ?? [];
    expect(limits).toHaveLength(reads.length);
  });

  it('обход вложений берёт в порцию только имена, а тело — по одному', () => {
    const code = codeLines(reencryptBody());
    const at = code.indexOf('INLINE_BLOB_PREFIX');
    expect(at).toBeGreaterThan(-1);
    const query = code.slice(Math.max(0, at - 300), at);
    expect(query).toContain('SELECT rowid AS kv_rowid, k FROM kv');
    expect(query).not.toContain('k, v FROM kv');
    // Тело берётся отдельным запросом на запись.
    expect(code).toContain("await database.getFirstAsync<{ v: string }>(");
    expect(code).toContain("'SELECT v FROM kv WHERE k = ?'");
  });

  it('порция вложений мельче порции строк', () => {
    const rowBatch = /const REENCRYPT_ROW_BATCH = (\d+);/.exec(LOCAL);
    const blobBatch = /const REENCRYPT_BLOB_BATCH = (\d+);/.exec(LOCAL);
    expect(rowBatch).not.toBeNull();
    expect(blobBatch).not.toBeNull();
    const rows = Number(rowBatch![1]);
    const blobs = Number(blobBatch![1]);
    expect(rows).toBeGreaterThan(0);
    expect(blobs).toBeGreaterThan(0);
    expect(blobs).toBeLessThan(rows);
  });

  it('курсор двигается раньше любого continue в теле порции', () => {
    const code = codeLines(reencryptBody());
    for (const [cursor, next] of [
      ['afterRowid = r.at_rest_rowid as number;', 'const sets: string[] = [];'],
      ['afterKvRowid = row.kv_rowid;', 'const plain = tryDecryptAtRest(row.v, from);'],
      ['afterBlobRowid = key.kv_rowid;', 'const row = await database.getFirstAsync'],
    ]) {
      const a = code.indexOf(cursor);
      const b = code.indexOf(next);
      expect(a).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(a);
    }
  });

  it('каждый обход умеет останавливаться', () => {
    const code = codeLines(reencryptBody());
    expect(code.match(/for \(;;\) \{/g) ?? []).toHaveLength(3);
    expect(code.match(/\.length === 0\) break;/g) ?? []).toHaveLength(3);
    expect(code.match(/_BATCH\) break;/g) ?? []).toHaveLength(3);
  });

  it('нерасшифрованное по-прежнему остаётся нетронутым', () => {
    const code = codeLines(reencryptBody());
    // ПРОВЕРКА НЕ ПУСТАЯ: правило «не расшифровалось — не трогаем» старше
    // порций и переживать их обязано, иначе смена ключа сотрёт переписку.
    expect(code).toContain('const plain = tryDecryptAtRest(cur, from);');
    expect(code).toContain('if (plain == null) continue;');
    expect(code).toContain('const moved = reencryptInlineBlob(row.v, from, to);');
    expect(code).toContain('if (moved == null) continue;');
    expect(code).toContain('vals.push(encryptAtRestString(plain, to));');
  });
});
