/**
 * v4.32.468 — рэтчет: список участников идёт по старшинству, а не по алфавиту.
 *
 * Дефект: `listGroupMembers` отдавал строки с `ORDER BY role ASC`. Это порядок
 * по первой букве названия роли — admin, banned, member, owner, restricted, —
 * а не по правам. Создатель группы стоял в списке ниже обычных участников, и в
 * группе на десяток человек владельца приходилось искать глазами; «только
 * чтение» уезжало в самый конец, ниже владельца.
 *
 * Тест держит три вещи: сам порядок (чистая функция), то, что таблица
 * старшинства ровно одна на код и на SQL, и что запрос ею пользуется.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  MEMBER_ROLE_ORDER,
  MEMBER_ROLE_ORDER_SQL,
  memberRoleRank,
  sortMembersByRole,
} from '../groupRolePolicy';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

const member = (role: string, joinedAt: number) => ({ role, joinedAt, peerPubB64: `${role}:${joinedAt}` });

describe('порядок ролей', () => {
  it('старшинство, а не алфавит', () => {
    expect([...MEMBER_ROLE_ORDER]).toEqual(['owner', 'admin', 'member', 'restricted', 'banned']);
    // Тот же список, отсортированный по алфавиту, — это старое поведение.
    expect([...MEMBER_ROLE_ORDER].sort()).not.toEqual([...MEMBER_ROLE_ORDER]);
  });

  it('владелец первый, забаненный последний', () => {
    expect(memberRoleRank('owner')).toBe(0);
    expect(memberRoleRank('banned')).toBe(MEMBER_ROLE_ORDER.length - 1);
  });

  it('владелец выше обычного участника — то, что и ломалось', () => {
    expect(memberRoleRank('owner')).toBeLessThan(memberRoleRank('member'));
  });

  it('неизвестная роль уходит в конец, но не теряется', () => {
    expect(memberRoleRank('джедай')).toBe(MEMBER_ROLE_ORDER.length);
    expect(memberRoleRank(undefined)).toBe(MEMBER_ROLE_ORDER.length);
    const out = sortMembersByRole([member('джедай', 1), member('owner', 2)]);
    expect(out.map((m) => m.role)).toEqual(['owner', 'джедай']);
  });
});

describe('sortMembersByRole', () => {
  it('внутри одной роли — по дате вступления, список не прыгает', () => {
    const out = sortMembersByRole([member('member', 30), member('member', 10), member('member', 20)]);
    expect(out.map((m) => m.joinedAt)).toEqual([10, 20, 30]);
  });

  it('раскладывает весь список по старшинству', () => {
    const mixed = ['restricted', 'member', 'banned', 'owner', 'admin'].map((r, i) => member(r, i));
    expect(sortMembersByRole(mixed).map((m) => m.role)).toEqual([...MEMBER_ROLE_ORDER]);
  });

  it('исходный массив не трогает — он приходит из состояния экрана', () => {
    const src = [member('member', 1), member('owner', 2)];
    const copy = [...src];
    sortMembersByRole(src);
    expect(src).toEqual(copy);
  });
});

describe('SQL и код — одна таблица старшинства', () => {
  it('CASE собран из того же списка', () => {
    MEMBER_ROLE_ORDER.forEach((role, i) => {
      expect(MEMBER_ROLE_ORDER_SQL).toContain(`WHEN '${role}' THEN ${i}`);
    });
    expect(MEMBER_ROLE_ORDER_SQL).toContain(`ELSE ${MEMBER_ROLE_ORDER.length} END`);
  });

  it('в CASE нет ничего, кроме литералов ролей', () => {
    expect(MEMBER_ROLE_ORDER_SQL.match(/'[^']*'/g)).toEqual(MEMBER_ROLE_ORDER.map((r) => `'${r}'`));
  });

  it('запрос участников сортирует этим выражением, а не по алфавиту', () => {
    const q = LOCAL.slice(LOCAL.indexOf('SELECT * FROM group_members WHERE group_id = ?'));
    const line = q.slice(0, q.indexOf('`,'));
    expect(line).toContain('ORDER BY ${MEMBER_ROLE_ORDER_SQL} ASC, joined_at ASC');
    expect(LOCAL).not.toContain('ORDER BY role ASC');
  });

  it('второй таблицы старшинства в хранилище не завелось', () => {
    expect(LOCAL).not.toContain("WHEN 'owner' THEN");
  });
});
