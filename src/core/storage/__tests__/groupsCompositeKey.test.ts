/**
 * v4.32.467 — рэтчет: группа принадлежит аккаунту, а не установке.
 *
 * Дефект: у `groups` первичным ключом был один `id`. Идентификатор группы
 * оказывался общим на весь телефон, и второй профиль не мог завести группу,
 * которая уже есть у первого: `INSERT OR IGNORE` тихо не делал ничего.
 * Наружу это выходило так:
 *  - ссылка-приглашение во втором аккаунте не срабатывала никогда — группа не
 *    появлялась ни в списке, ни в поиске, а человеку говорили «откройте
 *    ссылку в другом профиле»;
 *  - восстановление резервной копии во второй профиль по той же причине
 *    пропускало все группы с занятыми идентификаторами — молча, без единой
 *    строки в отчёте.
 *
 * Держим здесь три вещи: ключ в схеме, безопасность самой пересборки (её
 * прерванные состояния) и то, что список колонок берётся у базы, а не пишется
 * руками.
 */
import * as fs from 'fs';
import * as path from 'path';

import { rebuildColumns, type ColumnInfo } from '../tableRebuild';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

/** Тело функции: от строки объявления до первой закрывающей `}` в 0-й колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > 0 && lines[i] === '}') break;
  }
  return out.join('\n');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const MIGRATION = bodyOf(LOCAL, 'async function ensureGroupsProfileScopedKey(');

describe('проверка не пустая', () => {
  it('bodyOf вырезает именно одну функцию', () => {
    expect(MIGRATION).toContain('ensureGroupsProfileScopedKey');
    expect(MIGRATION).not.toContain('ensureGroupMembersProfileScoped(database: ');
    expect(MIGRATION.trimEnd().endsWith('}')).toBe(true);
  });
});

describe('схема: ключ groups составной', () => {
  const ddl = LOCAL.slice(
    LOCAL.indexOf('CREATE TABLE IF NOT EXISTS groups ('),
    LOCAL.indexOf('CREATE TABLE IF NOT EXISTS group_members (')
  );

  it('таблица найдена', () => {
    expect(ddl).toContain('owner_profile_id INTEGER NOT NULL DEFAULT 1');
    expect(ddl).toContain('last_message_preview TEXT');
  });

  it('id больше не первичный ключ сам по себе', () => {
    expect(ddl).toContain('id TEXT NOT NULL,');
    expect(ddl).not.toContain('id TEXT PRIMARY KEY');
  });

  it('ключ — пара (id, профиль)', () => {
    expect(ddl).toContain('PRIMARY KEY (id, owner_profile_id)');
  });
});

describe('миграция: четыре состояния диска после обрыва', () => {
  it('уже переехали — выходим, ничего не трогая', () => {
    expect(MIGRATION).toContain("PRAGMA table_info(groups)");
    expect(MIGRATION).toContain("if (pkCols.includes('owner_profile_id')) return;");
  });

  it('обрыв между DROP и RENAME — доименовываем, а не теряем таблицу', () => {
    expect(MIGRATION).toContain('ALTER TABLE groups_v2 RENAME TO groups;');
    expect(MIGRATION).toContain('groups_migrate_recovered_from_rename_gap');
  });

  it('чистая установка — выходим молча', () => {
    expect(MIGRATION).toContain('return; // чистая установка');
  });

  it('пересборка целиком в одной транзакции', () => {
    const begin = MIGRATION.indexOf('BEGIN IMMEDIATE;');
    const commit = MIGRATION.indexOf('COMMIT;');
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    // Внутри транзакции шаги идут в этом порядке и все четыре — до COMMIT.
    const tx = MIGRATION.slice(begin, commit);
    const steps = [
      'CREATE TABLE IF NOT EXISTS groups_v2',
      'INSERT INTO groups_v2',
      'DROP TABLE groups;',
      'ALTER TABLE groups_v2 RENAME TO groups;',
    ];
    const at = steps.map((step) => tx.indexOf(step));
    expect(at.filter((i) => i < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('ошибка внутри — откат, а не полутаблица', () => {
    expect(MIGRATION).toContain("ROLLBACK;");
    expect(MIGRATION).toContain('groups_migrate_failed');
  });

  it('перелив без OR IGNORE: потерянная группа не должна быть тихой', () => {
    expect(MIGRATION).toContain('INSERT INTO groups_v2');
    expect(MIGRATION).not.toContain('INSERT OR IGNORE INTO groups_v2');
  });

  it('запускается до состава участников: тот берёт профиль у groups', () => {
    const chain = LOCAL.slice(LOCAL.indexOf('await ensurePollVotesMultipleChoice(database);'));
    const groupsAt = chain.indexOf('await ensureGroupsProfileScopedKey(database);');
    const membersAt = chain.indexOf('await ensureGroupMembersProfileScoped(database);');
    expect(groupsAt).toBeGreaterThan(-1);
    expect(membersAt).toBeGreaterThan(groupsAt);
  });

  it('вызывается ровно один раз', () => {
    expect(count(LOCAL, 'await ensureGroupsProfileScopedKey(database);')).toBe(1);
  });
});

describe('список колонок берётся у базы, а не из кода', () => {
  it('миграция не содержит рукописного перечня колонок groups', () => {
    expect(MIGRATION).toContain("getAllAsync<ColumnInfo>('PRAGMA table_info(groups)')");
    expect(MIGRATION).toContain('rebuildColumns(cols');
    // Ни одной колонки, добавленной поздними ALTER TABLE, здесь быть не должно:
    // если она тут перечислена — значит список опять пишут руками.
    for (const late of ['disappear_after_ms', 'slow_mode_seconds', 'admin_only_posting', 'invite_token', 'draft_text']) {
      expect(MIGRATION).not.toContain(late);
    }
  });
});

describe('rebuildColumns — перенос колонок', () => {
  const cols: ColumnInfo[] = [
    { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null },
    { name: 'owner_profile_id', type: 'INTEGER', notnull: 1, dflt_value: '1' },
    { name: 'type', type: 'TEXT', notnull: 1, dflt_value: "'group'" },
    { name: 'description', type: 'TEXT', notnull: 0, dflt_value: null },
  ];

  it('переносит все колонки, что дала база', () => {
    expect(rebuildColumns(cols).names).toBe('id, owner_profile_id, type, description');
  });

  it('сохраняет NOT NULL и значения по умолчанию', () => {
    const { decls } = rebuildColumns(cols);
    expect(decls).toContain('id TEXT NOT NULL');
    expect(decls).toContain('owner_profile_id INTEGER NOT NULL DEFAULT 1');
    expect(decls).toContain("type TEXT NOT NULL DEFAULT 'group'");
    expect(decls).toContain('description TEXT');
  });

  it('строковое умолчание не кавычится второй раз', () => {
    expect(rebuildColumns(cols).decls).not.toContain("DEFAULT ''group''");
  });

  it('NULL-умолчание не превращается в слово null', () => {
    expect(rebuildColumns([cols[3]]).decls).toBe('  description TEXT');
  });

  it('колонка с посторонним именем не уходит в DDL, а отмечается', () => {
    const weird: ColumnInfo[] = [...cols, { name: 'x"); DROP TABLE groups; --', type: 'TEXT', notnull: 0, dflt_value: null }];
    const r = rebuildColumns(weird);
    expect(r.decls).not.toContain('DROP TABLE');
    expect(r.names).not.toContain('DROP TABLE');
    expect(r.skipped).toEqual(['x"); DROP TABLE groups; --']);
  });

  it('непонятный тип становится TEXT, а не подстановкой', () => {
    const r = rebuildColumns([{ name: 'a', type: 'TEXT); DROP TABLE groups; --', notnull: 0, dflt_value: null }]);
    expect(r.decls).toBe('  a TEXT');
  });

  it('отступ задаётся вызывающим — DDL собирается читаемым', () => {
    expect(rebuildColumns([cols[0]], '    ').decls).toBe('    id TEXT NOT NULL');
  });

  it('пустой ответ PRAGMA не даёт битого DDL', () => {
    expect(rebuildColumns([])).toEqual({ decls: '', names: '', skipped: [] });
  });
});

describe('ссылка-приглашение: состояния больше не про соседний профиль', () => {
  const body = bodyOf(LOCAL, 'export async function groupIdState(');

  it('вопрос задаётся про свой аккаунт', () => {
    expect(body).toContain('FROM groups WHERE id = ? AND owner_profile_id = ?');
  });

  it('старого имени в коде не осталось', () => {
    expect(LOCAL).not.toContain('groupIdOwner');
  });
});
