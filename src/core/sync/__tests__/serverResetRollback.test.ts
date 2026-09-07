/**
 * Сброс серверной копии не должен открывать дорогу откату (v4.32.615).
 *
 * Метку `serverEpoch` называет сервер, и ответ с ней ничем не подписан.
 * Расхождение метки означает «серверная копия заведена заново», и до этой
 * версии клиент отвечал на него `DELETE FROM sync_entity_heads`. Вместе с
 * ложным утверждением «это содержимое там уже лежит» уходило и второе,
 * правдивое: номер ревизии. А на нём держится единственная защита от отката
 * (`applyMutation`: пришедшее с номером не выше известного не применяется).
 *
 * Значит сервер, отдавший новую метку вместе со СТАРЫМИ мутациями — копия
 * поднята из вчерашнего снимка, а то и злонамеренно, — возвращал переписку на
 * день назад, и отбить это было нечем.
 *
 * Проверка поведенческая: оператор берётся прямо из local.ts и выполняется на
 * настоящем SQLite поверх настоящей схемы. Рядом — два правила, которые эти
 * строки и читают, выписанные ровно так, как в liveAccountSync.
 */
import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const LOCAL = readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const LIVE = readFileSync(join(__dirname, '..', 'liveAccountSync.ts'), 'utf8');
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Оператор из тела названной функции: первое строковое литеральное SQL. */
function statementIn(fn: string, verb: string): string {
  const at = LOCAL.indexOf(`export async function ${fn}(`);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = LOCAL.indexOf(`'${verb}`, at);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = LOCAL.indexOf("'", start + 1);
  expect(end).toBeGreaterThan(start);
  return LOCAL.slice(start + 1, end);
}

type Row = { entity_kind: string; entity_id: string; revision: number; fingerprint: string | null; deleted: number };

/** Схема из local.ts плюс две головы: живая запись и надгробие. */
function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE sync_entity_heads (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      owner_profile_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      fingerprint TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity_kind, entity_id, owner_profile_id)
    );
  `);
  const ins = d.prepare(
    'INSERT INTO sync_entity_heads VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  ins.run('message', 'm-live', 1, 7, 'fp-live', 0, 100);
  ins.run('message', 'm-gone', 1, 4, null, 1, 100);
  // Соседний профиль: его головы трогать нельзя ни при каком исходе.
  ins.run('message', 'm-live', 2, 9, 'fp-other', 0, 100);
  return d;
}

const rows = (d: DatabaseSync, pid: number): Row[] =>
  d.prepare('SELECT entity_kind, entity_id, revision, fingerprint, deleted FROM sync_entity_heads WHERE owner_profile_id = ? ORDER BY entity_id')
    .all(pid) as unknown as Row[];

/** Правило отправки из collectPending: одинаковый отпечаток — не шлём. */
const willPush = (row: Row | undefined, nextFingerprint: string): boolean =>
  !(row && row.deleted === 0 && row.fingerprint === nextFingerprint);

/** Правило приёма из applyMutation: не новее известного — не применяем. */
const willApply = (row: Row | undefined, incomingRevision: number): boolean =>
  !(row && row.revision >= incomingRevision);

describe('серверная копия заведена заново', () => {
  it('отпечатки гаснут — отправка собирается целиком', () => {
    const d = freshDb();
    d.prepare(statementIn('forgetSyncEntityFingerprints', 'UPDATE')).run(1);
    const after = rows(d, 1);
    expect(after.map((r) => r.fingerprint)).toEqual([null, null]);
    expect(willPush(after.find((r) => r.entity_id === 'm-live'), 'fp-live')).toBe(true);
    d.close();
  });

  it('номера ревизий остаются — старую мутацию по-прежнему отбивает', () => {
    const d = freshDb();
    d.prepare(statementIn('forgetSyncEntityFingerprints', 'UPDATE')).run(1);
    const live = rows(d, 1).find((r) => r.entity_id === 'm-live');
    expect(live?.revision).toBe(7);
    expect(willApply(live, 6)).toBe(false);
    expect(willApply(live, 7)).toBe(false);
    expect(willApply(live, 8)).toBe(true);
    d.close();
  });

  it('надгробие остаётся надгробием: старая мутация не воскрешает запись', () => {
    const d = freshDb();
    d.prepare(statementIn('forgetSyncEntityFingerprints', 'UPDATE')).run(1);
    const gone = rows(d, 1).find((r) => r.entity_id === 'm-gone');
    expect(gone?.deleted).toBe(1);
    expect(gone?.revision).toBe(4);
    expect(willApply(gone, 3)).toBe(false);
    d.close();
  });

  it('прежнее удаление строк отбивать откат было нечем', () => {
    const d = freshDb();
    d.prepare('DELETE FROM sync_entity_heads WHERE owner_profile_id = ?').run(1);
    expect(rows(d, 1)).toEqual([]);
    // Ровно то, чем это кончалось: вчерашняя ревизия применяется как новая.
    expect(willApply(undefined, 6)).toBe(true);
    d.close();
  });

  it('соседний профиль не затронут', () => {
    const d = freshDb();
    d.prepare(statementIn('forgetSyncEntityFingerprints', 'UPDATE')).run(1);
    expect(rows(d, 2)).toEqual([
      { entity_kind: 'message', entity_id: 'm-live', revision: 9, fingerprint: 'fp-other', deleted: 0 },
    ]);
    d.close();
  });
});

describe('вызов сброса стоит на месте', () => {
  it('local.ts не удаляет головы, а гасит отпечатки', () => {
    expect(code(LOCAL)).toContain("'UPDATE sync_entity_heads SET fingerprint = NULL WHERE owner_profile_id = ?'");
    expect(code(LOCAL)).not.toContain('DELETE FROM sync_entity_heads');
  });

  it('onServerReset зовёт именно его', () => {
    const at = LIVE.indexOf('onServerReset: async () => {');
    expect(at).toBeGreaterThan(0);
    const body = LIVE.slice(at, LIVE.indexOf('},', at));
    expect(body).toContain('await forgetSyncEntityFingerprints(ownerProfileId);');
    expect(code(LIVE)).not.toContain('clearSyncEntityHeads');
  });
});
