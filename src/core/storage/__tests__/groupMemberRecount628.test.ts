/**
 * Сбой чтения состава больше не записывается как «в группе никого» (v4.32.628).
 *
 * `listGroupMembers` ловил любую ошибку и отдавал `[]`. Для пятнадцати мест,
 * которые состав показывают, это допустимо: пустой список — «показывать
 * нечего», и следующий заход перерисует. Но одно место на этом не рисовало, а
 * ЗАПИСЫВАЛО: `recountGroupMembers` считал строки и клал число в
 * `groups.member_count`. Число хранится отдельно от состава и обновляется
 * только по событию — вошёл, вышел, сменил роль. Значит одной секундной
 * блокировки базы (соседняя транзакция, миграция, ротация ключа) во время
 * пересчёта хватало, чтобы записать «0 человек» на месяцы вперёд: состав цел,
 * а группа во всех списках пустая.
 *
 * Правило общее и записано в readResult.ts: сбой чтения не даёт права ни
 * менять список, ни делать по нему вывод. Здесь оно закреплено формой
 * исходника: `local.ts` требует живого SQLite, поэтому проверяется не поведение
 * во время работы, а то, что запись стоит ЗА проверкой исхода.
 */
import fs from 'fs';
import path from 'path';

import { countMembers } from '../../social/groupRolePolicy';
import { shouldApplyRows } from '../readResult';

/** Исходник без строк-комментариев: в них старая форма упомянута нарочно. */
const SRC = fs
  .readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');

/** Тело функции: от объявления до первой `}` в нулевой колонке. */
function bodyOf(head: string): string {
  const i = SRC.indexOf(head);
  expect(i).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf('\n}', i);
  expect(end).toBeGreaterThan(i);
  return SRC.slice(i, end + 2);
}

describe('состав группы читается тремя состояниями', () => {
  it('запрос живёт в readGroupMembers и отдаёт null при сбое', () => {
    const b = bodyOf('async function readGroupMembers(');
    expect(b).toContain('): Promise<DbRead<GroupMemberRow>> {');
    expect(b).toContain('FROM group_members WHERE group_id = ?');
    expect(b).toContain('  } catch {\n    return null;\n  }');
    expect(b).not.toContain('return [];');
  });

  it('listGroupMembers — только обёртка, снимающая третий исход', () => {
    const b = bodyOf('export async function listGroupMembers(');
    expect(b).toContain('return (await readGroupMembers(groupId, ownerProfileId))?.slice() ?? [];');
    expect(b).not.toContain('group_members');
    expect(b).not.toContain('catch');
  });

  it('shouldApplyRows ввезён значением, а не только типом', () => {
    expect(SRC).toContain("import { shouldApplyRows, type DbRead } from './readResult';");
  });
});

describe('пересчёт числа участников', () => {
  const recount = () => bodyOf('export async function recountGroupMembers(');

  it('читает проверяемым чтением, а не списком', () => {
    const b = recount();
    expect(b).toContain('const rows = await readGroupMembers(groupId, ownerProfileId);');
    expect(b).not.toContain('listGroupMembers(');
  });

  it('запись стоит за проверкой исхода', () => {
    const b = recount();
    const guard = b.indexOf('if (!shouldApplyRows(rows)) {');
    const write = b.indexOf('await updateGroupMeta(');
    expect(guard).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(guard);
  });

  it('на сбое ничего не пишет и говорит об этом в журнал', () => {
    const b = recount();
    const guard = b.indexOf('if (!shouldApplyRows(rows)) {');
    const branch = b.slice(guard, b.indexOf('\n  }\n', guard));
    expect(branch).toContain("log.warn('group_member_recount_skipped', { groupId });");
    expect(branch).toContain('return ');
    expect(branch).not.toContain('updateGroupMeta');
  });

  it('на успехе считает по общему правилу countMembers', () => {
    expect(recount()).toContain('const n = countMembers(rows);');
  });
});

describe('проверка не пустая', () => {
  it('исходник прочитан, а bodyOf находит тела', () => {
    expect(SRC.length).toBeGreaterThan(200000);
    expect(SRC).toContain('export async function recountGroupMembers(');
    expect(bodyOf('export async function removeGroupMember(')).toContain('DELETE FROM group_members');
  });

  it('третий исход у shouldApplyRows действительно отличим от пустоты', () => {
    expect(shouldApplyRows(null)).toBe(false);
    expect(shouldApplyRows([])).toBe(true);
  });

  it('countMembers считает не все строки подряд', () => {
    const rows = [{ role: 'owner' as const }, { role: 'member' as const }, { role: 'banned' as const }];
    expect(rows.length).toBe(3);
    expect(countMembers(rows)).toBe(2);
    expect(countMembers([])).toBe(0);
  });
});
