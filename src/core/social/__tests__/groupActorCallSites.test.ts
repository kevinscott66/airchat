/**
 * Ратчет: подготовка данных о роли в группе живёт в одном месте (v4.32.429).
 *
 * До этой версии связка «группа наша? кто отправитель? какая у него роль?»
 * была переписана от руки пять раз. Копии разошлись однажды сами — правку
 * v4.32.273 («не только бан, но и read-only») внесли в pollVoteSync, а в
 * остальные пришлось догонять отдельно. Расхождение таких копий не ломает ни
 * сборку, ни тесты: оно видно только по расходящимся счётчикам на двух
 * телефонах, и именно поэтому его ловит тест, а не человек на ревью.
 *
 * Проверяются обе стороны: запрещённая форма НЕ встречается за пределами дома
 * и при этом действительно распознаётся на исторических строках — иначе
 * зелёный тест не значил бы ничего.
 */
import fs from 'fs';
import path from 'path';

const SOCIAL = path.join(__dirname, '..');
const HOME = 'groupActor.ts';

/** Приведение строки из БД к роли: `(x?.role as SendRole | undefined) ?? null`. */
const ROLE_CAST = /\?\.role as SendRole \| undefined\) \?\? null/;
/** Ручная проверка «группа есть у нас»: `.some((g) => g.id === …)`. */
const KNOWN_GROUP = /\.some\(\(g\) => g\.id === /;
/**
 * v4.32.511: список активных групп в социальном слое вообще не спрашивают.
 *
 * `listGroups` отдаёт только `archived = 0`, а на приёме конвертов задавался
 * вопрос «наша ли это группа». Ответ «нет» получала не только чужая группа, но
 * и собственная, убранная в архив, — и её сообщения, реакции, голоса и заявки
 * пропадали молча, а приглашение в неё применялось как в незнакомую, переписывая
 * состав и роли. Правильный вопрос — `getGroup(id, pid)`; он же дешевле.
 *
 * Правило намеренно шире дефекта: любой `listGroups` здесь — это «выбрать из
 * списка вместо запроса по ключу», то есть та же ошибка в новом месте. Списку
 * место на экране, а не в приёме конвертов.
 */
const ARCHIVE_BLIND = /\blistGroups\(/;
/**
 * v4.32.512: колонка `groups.is_admin` — не источник прав.
 *
 * Пишет её один createGroup, в момент появления группы, и до этой версии
 * дальше её не менял никто: повышение правит `group_members`, а флаг остаётся
 * прежним навсегда. Приём конвертов спрашивал именно флаг — и назначенный
 * администратор молча выбрасывал заявки на вступление, не пересказывал
 * вступивших остальным и не принимал сброс ссылки, имея при этом и подпись, и
 * системную строку о назначении. Понижённый — зеркально: кнопки на своём
 * экране остались, последствий у остальных ноль.
 *
 * Разрешено ровно одно чтение: скормить флаг `ownGroupRole` как ЗАПАСНОЙ
 * ответ, когда своей строки в списке участников ещё нет. Отдельно разрешена
 * строка `storedAdmin = …`: она держит прежнее значение, чтобы сравнить его с
 * новым перед записью, — то есть тоже не решает прав.
 */
const ADMIN_FLAG = /\.isAdmin\b/;
const ADMIN_FLAG_OK = /ownGroupRole\(|storedAdmin = /;

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Строки без комментариев: правило про код, а не про рассказ о коде. */
function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
}

const FILES = collect(SOCIAL).map((full) => ({
  key: path.relative(SOCIAL, full),
  lines: codeLines(fs.readFileSync(full, 'utf8')),
}));

describe('роль в группе читается в одном месте', () => {
  it('приведение к SendRole не встречается вне groupActor.ts', () => {
    const offenders = FILES.filter((f) => f.key !== HOME)
      .filter((f) => f.lines.some((l) => ROLE_CAST.test(l)))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('ручная проверка «знаем ли группу» не встречается вне groupActor.ts', () => {
    const offenders = FILES.filter((f) => f.key !== HOME)
      .filter((f) => f.lines.some((l) => KNOWN_GROUP.test(l)))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('список активных групп в социальном слое не спрашивают (v4.32.511)', () => {
    const offenders = FILES.filter((f) => f.lines.some((l) => ARCHIVE_BLIND.test(l))).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('запрет на список групп ловит исторические строки и не трогает законные', () => {
    const historic = [
      '  const groups = await listGroups(pid);',
      '    const group = (await listGroups(pid)).find((g) => g.id === groupId);',
      '    avatarCid = (await listGroups(pid)).find((g) => g.id === groupId)?.avatarCid ?? undefined;',
    ];
    for (const line of historic) expect(ARCHIVE_BLIND.test(line)).toBe(true);

    const legit = [
      '  const group = await getGroup(env.groupId, pid);',
      '  const group = await getGroup(groupId, ownerProfileId);',
      '  const rows = await listArchivedGroups(pid);',
    ];
    for (const line of legit) expect(ARCHIVE_BLIND.test(line)).toBe(false);
  });

  it('флаг is_admin в социальном слое читают только для ownGroupRole (v4.32.512)', () => {
    const offenders = FILES.filter((f) =>
      f.lines.some((l) => ADMIN_FLAG.test(l) && !ADMIN_FLAG_OK.test(l))
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('запрет на флаг ловит исторические строки и не трогает законные', () => {
    const historic = [
      '    if (!grp?.isAdmin) return true;',
      '      iAmAdmin: !!group.isAdmin,',
      '    if (env.inviteToken != null && group.isAdmin && env.inviteToken !== group.inviteToken) {',
      '    if (group.isAdmin) {',
      '  const amAdmin = group.isAdmin;',
    ];
    for (const line of historic) expect(ADMIN_FLAG.test(line) && !ADMIN_FLAG_OK.test(line)).toBe(true);

    const legit = [
      '  const iAmAdmin = isAdminRole(ownGroupRole(members, rcpt.myPub, storedAdmin));',
      '    if (!isAdminRole(ownGroupRole(grpMembers, rcpt.myPub, !!grp.isAdmin))) return true;',
      '  const storedAdmin = !!group.isAdmin;',
      '      if (nextAdmin !== storedAdmin) await updateGroupMeta(env.groupId, pid, { isAdmin: nextAdmin });',
    ];
    for (const line of legit) expect(ADMIN_FLAG.test(line) && !ADMIN_FLAG_OK.test(line)).toBe(false);
  });

  it('дом ровно один и он содержит обе формы', () => {
    const home = FILES.filter((f) => f.key === HOME);
    expect(home).toHaveLength(1);
    expect(home[0].lines.some((l) => ROLE_CAST.test(l))).toBe(true);
    expect(home[0].lines.some((l) => KNOWN_GROUP.test(l))).toBe(false);
  });
});

describe('запрещённые формы действительно распознаются', () => {
  it('исторические строки ловятся', () => {
    const historic = [
      "    const verdict = canInteractInGroup((me?.role as SendRole | undefined) ?? null);",
      "    const verdict = canInteractInGroup((member?.role as SendRole | undefined) ?? null);",
      "      role: (me?.role as SendRole | undefined) ?? null,",
    ];
    for (const line of historic) expect(ROLE_CAST.test(line)).toBe(true);

    const historicGroups = [
      "    if (!groups.some((g) => g.id === env.groupId)) {",
      "    if (!groups.some((g) => g.id === groupId)) {",
    ];
    for (const line of historicGroups) expect(KNOWN_GROUP.test(line)).toBe(true);
  });

  it('законные строки не ловятся', () => {
    const legit = [
      '    const verdict = canInteractInGroup(actor.role);',
      '    const verdict = canInteractInGroup(roleOf(members, actorKey));',
      "  return (row?.role as SendRole | undefined) ?? 'member';",
      '    const actor = await lookupGroupActor(env.groupId, senderPubB64, pid);',
      "    const idx = list.some((g) => g.name === 'x');",
    ];
    for (const line of legit) {
      expect(ROLE_CAST.test(line) || KNOWN_GROUP.test(line)).toBe(false);
    }
  });
});

describe('вызывающие подключены к дому', () => {
  it('lookupGroupActor зовут все, кому нужна связка «группа + роль»', () => {
    const users = FILES.filter((f) => f.key !== HOME)
      .filter((f) => f.lines.some((l) => l.includes('lookupGroupActor(')))
      .map((f) => f.key)
      .sort();
    expect(users).toEqual(['groupMessaging.ts', 'pollVoteSync.ts', 'reactionSync.ts']);

    // Четыре приёмника конвертов (реакция, голос, завершение опроса,
    // отметка о прочтении в группе) и одна отправляющая сторона (проверка
    // права на отправку в группу).
    const total = FILES.filter((f) => f.key !== HOME)
      .flatMap((f) => f.lines)
      .filter((l) => l.includes('await lookupGroupActor(')).length;
    expect(total).toBe(5);
  });

  it('roleOf зовут там, где список участников уже прочитан', () => {
    const total = FILES.filter((f) => f.key !== HOME)
      .flatMap((f) => f.lines)
      .filter((l) => l.includes('roleOf(')).length;
    expect(total).toBe(4);
  });

  it('своего множества ролей администрации в социальном слое не осталось', () => {
    const offenders = FILES.filter((f) => f.key !== 'groupSendPolicy.ts' && f.key !== 'groupPinPolicy.ts')
      .filter((f) => f.lines.some((l) => /new Set\(\['owner', ?'admin'\]\)/.test(l)))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });
});
