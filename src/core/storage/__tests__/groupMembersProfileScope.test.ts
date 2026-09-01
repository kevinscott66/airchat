/**
 * v4.32.466 — рэтчет: состав группы принадлежит профилю.
 *
 * Дефект. У `group_members` не было колонки профиля: первичный ключ
 * (group_id, peer_pub_b64), одна строка на всё приложение. Профили одной
 * установки — разные люди с разными ключами, и общая таблица участников
 * означала три вещи сразу.
 *
 *  1. Выход из группы в одном аккаунте стирал состав у второго:
 *     `DELETE FROM group_members WHERE group_id = ?` — без профиля.
 *  2. Бан, кик и смена роли, пришедшие в один профиль, немедленно
 *     действовали и во втором: та же строка.
 *  3. Экран участников показывал соседский состав — то есть выдавал, с кем
 *     сосед состоит в группе, вместе с его именами участников.
 *
 * Тест держит и схему (колонка, первичный ключ, миграция), и то, что ни один
 * запрос к составу не остался без профиля.
 */
import * as fs from 'fs';
import * as path from 'path';

const CORE = path.join(__dirname, '..', '..');
const LOCAL = fs.readFileSync(path.join(CORE, 'storage', 'local.ts'), 'utf8');
const GM = fs.readFileSync(path.join(CORE, 'social', 'groupMessaging.ts'), 'utf8');

const count = (h: string, n: string): number => h.split(n).length - 1;

/** Тело функции: от строки объявления до первой `}` в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const i = src.indexOf(head);
  if (i < 0) return '';
  const end = src.indexOf('\n}', i);
  return end < 0 ? src.slice(i) : src.slice(i, end + 2);
}

/**
 * Строки кода, где к таблице состава идёт запрос, вместе с их окружением.
 *
 * Не регулярным выражением по кавычкам: в этом файле кавычки и обратные
 * апострофы стоят и в русских пояснениях, и выражение сшивало бы половину
 * файла в одну «строку запроса». Здесь — построчно, комментарии отброшены, а
 * к каждой найденной строке приложены две соседние: запрос бывает
 * многострочным, и профиль может стоять строкой ниже.
 */
function memberSql(src: string): string[] {
  const lines = src.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    if (!line.includes('group_members')) return;
    if (!/\b(SELECT|UPDATE|DELETE FROM|INSERT INTO|INSERT OR IGNORE INTO)\b/.test(line)) return;
    out.push(lines.slice(Math.max(0, i - 2), i + 3).join('\n'));
  });
  return out;
}

describe('схема: у состава есть свой профиль', () => {
  it('колонка и трёхчастный первичный ключ объявлены', () => {
    const ddl = LOCAL.slice(
      LOCAL.indexOf('CREATE TABLE IF NOT EXISTS group_members ('),
      LOCAL.indexOf('CREATE TABLE IF NOT EXISTS group_messages (')
    );
    expect(ddl).toContain('owner_profile_id INTEGER NOT NULL DEFAULT 1');
    expect(ddl).toContain('PRIMARY KEY (group_id, peer_pub_b64, owner_profile_id)');
    expect(ddl).not.toContain('PRIMARY KEY (group_id, peer_pub_b64)\n');
  });

  it('индекс тоже профильный — иначе выборка своего состава читает чужие строки', () => {
    expect(LOCAL).toContain('idx_grp_members ON group_members (group_id, owner_profile_id)');
  });
});

describe('переезд существующих баз', () => {
  const mig = bodyOf(LOCAL, 'async function ensureGroupMembersProfileScoped(');

  it('миграция есть и вызвана при открытии базы', () => {
    expect(mig).not.toBe('');
    expect(LOCAL).toContain('await ensureGroupMembersProfileScoped(database);');
  });

  it('профиль старым строкам берётся у группы, а осиротевшим — первый', () => {
    expect(mig).toContain('COALESCE((SELECT g.owner_profile_id FROM groups g WHERE g.id = m.group_id), 1)');
  });

  it('повторный запуск ничего не делает, а обрыв не теряет данные', () => {
    // Те же четыре состояния на диске, что у ensurePollVotesMultipleChoice.
    expect(mig).toContain("if (pkCols.includes('owner_profile_id')) return;");
    expect(mig).toContain("ALTER TABLE group_members_v2 RENAME TO group_members;");
    expect(mig).toContain('BEGIN IMMEDIATE;');
    expect(mig).toContain('ROLLBACK;');
    // DROP только внутри транзакции, вместе с копированием.
    const tx = mig.slice(mig.indexOf('BEGIN IMMEDIATE;'), mig.indexOf('COMMIT;'));
    expect(tx).toContain('INSERT OR IGNORE INTO group_members_v2');
    expect(tx.indexOf('INSERT OR IGNORE INTO group_members_v2')).toBeLessThan(
      tx.indexOf('DROP TABLE group_members;')
    );
  });
});

describe('запросов к чужому составу не осталось', () => {
  it('каждый SQL про состав называет профиль', () => {
    const suspicious = memberSql(LOCAL).filter(
      (q) => !q.includes('owner_profile_id') && !q.includes('group_members_v2')
    );
    expect(suspicious).toEqual([]);
  });

  it('удаление группы уносит только свой состав', () => {
    expect(LOCAL).toContain("'DELETE FROM group_members WHERE group_id = ? AND owner_profile_id = ?'");
    expect(LOCAL).not.toContain("'DELETE FROM group_members WHERE group_id = ?'");
  });

  it('стирание профиля идёт по колонке, а не через JOIN с группами', () => {
    // Осиротевший состав (группы уже нет, строки остались) при JOIN не
    // удалялся вовсе и оставался лежать после «удалить профиль».
    expect(LOCAL).not.toContain('DELETE FROM group_members WHERE group_id IN (SELECT id FROM groups');
    const wipe = bodyOf(LOCAL, 'export async function deleteProfileDataFromLocalDb(');
    expect(wipe).toContain("'group_members',");
  });

  it('копия профиля собирает свой состав по своей колонке', () => {
    expect(LOCAL).toContain('FROM group_members WHERE owner_profile_id = ?');
    expect(LOCAL).not.toContain('FROM group_members m JOIN groups g ON g.id = m.group_id');
  });

  it('восстановление из копии пишет состав в тот профиль, куда восстанавливают', () => {
    expect(LOCAL).toContain(
      'INSERT OR IGNORE INTO group_members (group_id, peer_pub_b64, role, display_name, joined_at, owner_profile_id)'
    );
  });
});

describe('подписи не позволяют забыть профиль', () => {
  it('чтение, удаление и смена роли требуют его обязательным параметром', () => {
    expect(LOCAL).toContain('export async function listGroupMembers(\n  groupId: string,\n  ownerProfileId: number\n)');
    expect(LOCAL).toContain(
      'export async function removeGroupMember(\n  groupId: string,\n  peerPubB64: string,\n  ownerProfileId: number\n)'
    );
    expect(LOCAL).toContain(
      'export async function updateGroupMemberRole(\n  groupId: string,\n  peerPubB64: string,\n  role: MemberRole,\n  ownerProfileId: number\n)'
    );
  });

  it('строка состава несёт профиль в самом типе', () => {
    const t = LOCAL.slice(LOCAL.indexOf('export type GroupMemberRow = {'));
    expect(t.slice(0, t.indexOf('};'))).toContain('ownerProfileId: number;');
  });

  it('перезапись строки конфликтует по трём колонкам, а не по двум', () => {
    expect(LOCAL).toContain('ON CONFLICT(group_id, peer_pub_b64, owner_profile_id) DO UPDATE SET');
  });
});

describe('групповые пути спрашивают состав у своего профиля', () => {
  it('рассылка управляющего конверта получает профиль параметром', () => {
    // Не через getMessagingService: своей копии отправки здесь нет с v4.32.449,
    // и заводить её ради номера профиля незачем.
    expect(GM).toContain('export async function fanoutGroupControl(');
    const f = bodyOf(GM, 'export async function fanoutGroupControl(');
    expect(f).toContain('ownerProfileId: number,');
    expect(f).toContain('await listGroupMembers(groupId, ownerProfileId)');
    expect(f).not.toContain('getMessagingService');
  });

  it('рассылка сообщения спрашивает у службы, которая его и отправит', () => {
    const f = bodyOf(GM, 'export async function fanoutGroupMessage(');
    expect(f).toContain('await listGroupMembers(groupId, (await svc.groupRecipient()).pid)');
  });

  it('ни одного вызова состава без второго аргумента', () => {
    expect(count(GM, 'listGroupMembers(')).toBeGreaterThan(4);
    expect(GM).not.toMatch(/listGroupMembers\([^,)]*\)/);
  });
});

describe('проверка не пустая', () => {
  it('исходники прочитаны, а bodyOf находит тела', () => {
    expect(LOCAL.length).toBeGreaterThan(10000);
    expect(bodyOf(LOCAL, 'export async function listGroupMembers(')).toContain('FROM group_members WHERE group_id = ?');
    expect(bodyOf(LOCAL, 'нет такой функции')).toBe('');
  });

  it('memberSql действительно вытаскивает запросы', () => {
    const qs = memberSql(LOCAL);
    expect(qs.length).toBeGreaterThan(4);
    expect(qs.some((q) => q.includes('DELETE FROM group_members'))).toBe(true);
  });
});
