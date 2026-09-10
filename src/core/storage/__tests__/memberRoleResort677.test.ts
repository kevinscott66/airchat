/**
 * Круг 4.32.677 — пересортировка состава отменяла порядок по старшинству.
 *
 * В v4.32.468 из запроса убрали `ORDER BY role ASC`: алфавит по названию роли
 * (admin, banned, member, owner, restricted) ставил создателя группы ниже
 * рядовых участников, а забаненного — вторым. Вместо этого запрос стал
 * сортировать выражением MEMBER_ROLE_ORDER_SQL.
 *
 * В v4.32.382 в ту же функцию добавили пересортировку уже загруженного списка
 * — по делу: joined_at на чтении подрезается clampJoinedAt, и SQL сортировал
 * по сырой колонке. Но роли в этой пересортировке сравнивались через
 * `a.role.localeCompare(b.role)`, то есть ровно тем алфавитом, который убрали
 * из запроса. Сортировка идёт последней и отменяет работу запроса целиком.
 *
 * Рэтчет v4.32.468 (memberRoleOrder.test.ts) смотрел только на текст SQL и
 * этого не видел. Здесь закреплено, что старшинство в обоих местах берётся из
 * одной таблицы — memberRoleRank.
 */
import fs from 'fs';
import path from 'path';

import { MEMBER_ROLE_ORDER, memberRoleRank } from '../../social/groupRolePolicy';

const RAW = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

/** Исходник без строк-комментариев: в них старая форма упомянута нарочно. */
const SRC = RAW.split('\n')
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .join('\n');

/** Тело функции: от объявления до первой `}` в нулевой колонке. */
function bodyOf(head: string): string {
  const i = SRC.indexOf(head);
  expect(i).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf('\n}', i);
  expect(end).toBeGreaterThan(i);
  const b = SRC.slice(i, end + 2);
  expect(b.length).toBeGreaterThan(500);
  return b;
}

const READ_MEMBERS = () => bodyOf('async function readGroupMembers(');

describe('повод для правки жив', () => {
  it('алфавит и старшинство — это разные порядки', () => {
    // Ровно то, что ломалось: по алфавиту владелец ниже рядового участника,
    // а забаненный — выше него.
    expect('owner'.localeCompare('member')).toBeGreaterThan(0);
    expect(memberRoleRank('owner')).toBeLessThan(memberRoleRank('member'));
    expect('banned'.localeCompare('member')).toBeLessThan(0);
    expect(memberRoleRank('banned')).toBeGreaterThan(memberRoleRank('member'));
  });

  it('пересортировка на месте по-прежнему нужна — даты подрезаются на чтении', () => {
    const b = READ_MEMBERS();
    expect(b).toContain('clampJoinedAt(r.joined_at, now)');
    expect(b).toContain('.sort(');
  });

  it('и она по-прежнему идёт ПОСЛЕ запроса, то есть последнее слово за ней', () => {
    const b = READ_MEMBERS();
    const sql = b.indexOf('ORDER BY ${MEMBER_ROLE_ORDER_SQL}');
    const js = b.indexOf('.sort(');
    expect(sql).toBeGreaterThan(0);
    expect(js).toBeGreaterThan(sql);
  });
});

describe('старшинство берётся из одной таблицы', () => {
  it('local.ts ввозит memberRoleRank значением', () => {
    expect(SRC).toContain(
      "import { MEMBER_ROLE_ORDER_SQL, memberRoleRank } from '../social/groupRolePolicy';"
    );
  });

  it('пересортировка сравнивает роли рангом, а не строкой', () => {
    const b = READ_MEMBERS();
    expect(b).toContain('memberRoleRank(a.role) - memberRoleRank(b.role)');
  });

  it('алфавитного сравнения ролей в хранилище не осталось', () => {
    expect(SRC).not.toContain('a.role.localeCompare(b.role)');
    expect(SRC).not.toContain('role.localeCompare');
  });

  it('внутри одной роли список по-прежнему не прыгает', () => {
    const b = READ_MEMBERS();
    expect(b).toContain('a.joinedAt - b.joinedAt');
    expect(b).toContain('a.peerPubB64.localeCompare(b.peerPubB64)');
  });
});

describe('сам порядок', () => {
  type M = { role: string; joinedAt: number; peerPubB64: string };
  const m = (role: string, joinedAt = 0): M => ({ role, joinedAt, peerPubB64: `${role}:${joinedAt}` });

  /** Правило из readGroupMembers, слово в слово. */
  const byRank = (a: M, b: M): number =>
    memberRoleRank(a.role) - memberRoleRank(b.role) ||
    a.joinedAt - b.joinedAt ||
    a.peerPubB64.localeCompare(b.peerPubB64);

  /** Старое правило — оно же положительный контроль. */
  const byAlpha = (a: M, b: M): number =>
    a.role === b.role ? a.joinedAt - b.joinedAt || a.peerPubB64.localeCompare(b.peerPubB64) : a.role.localeCompare(b.role);

  const mixed = (): M[] => ['member', 'banned', 'owner', 'restricted', 'admin'].map((r, i) => m(r, i));

  it('владелец первый, забаненный последний', () => {
    expect([...mixed()].sort(byRank).map((x) => x.role)).toEqual([...MEMBER_ROLE_ORDER]);
  });

  it('старое правило ставило владельца четвёртым — так это и выглядело', () => {
    expect([...mixed()].sort(byAlpha).map((x) => x.role)).toEqual([
      'admin',
      'banned',
      'member',
      'owner',
      'restricted',
    ]);
  });

  it('внутри одной роли — по дате вступления, потом по ключу', () => {
    const same = [m('member', 30), m('member', 10), m('member', 20)];
    expect([...same].sort(byRank).map((x) => x.joinedAt)).toEqual([10, 20, 30]);
    const tie = [m('member', 5), { role: 'member', joinedAt: 5, peerPubB64: 'AAA' }];
    expect([...tie].sort(byRank)[0].peerPubB64).toBe('AAA');
  });

  it('неизвестная роль уходит в самый конец, но не теряется', () => {
    // Правило memberRoleRank: неизвестная роль получает ранг за забаненными,
    // то есть вперёд них не лезет.
    const out = [m('джедай', 1), m('owner', 2), m('banned', 3)].sort(byRank);
    expect(out.map((x) => x.role)).toEqual(['owner', 'banned', 'джедай']);
  });
});

describe('проверка не пустая', () => {
  it('исходник прочитан и комментарии сняты', () => {
    expect(RAW.length).toBeGreaterThan(100_000);
    expect(SRC.length).toBeGreaterThan(50_000);
    expect(SRC.length).toBeLessThan(RAW.length);
  });

  it('таблица старшинства не выродилась', () => {
    expect([...MEMBER_ROLE_ORDER]).toEqual(['owner', 'admin', 'member', 'restricted', 'banned']);
  });
});
