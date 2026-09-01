import * as fs from 'fs';
import * as path from 'path';

/**
 * Закрепление в группе: отказ называет причину, а рассылка — свой исход
 * (v4.32.453).
 *
 * Два дефекта в одной функции.
 *
 * 1. togglePinAndSync отдавала `PinnedEntry[] | null`, и null означал три
 *    разных вещи: не загружены ключи профиля, не нашлась строка группы, не
 *    хватило прав. Экран на любую из них говорил «Нет прав … только
 *    администраторы» — в двух случаях из трёх неправда, и совет «попросите
 *    администратора» бесполезен, потому что дело не в администраторе.
 *
 * 2. Рассылка закрепления уходила через `void fanoutGroupControl(...)`.
 *    Повторной отправки у служебного конверта нет: не ушло — не уйдёт.
 *    «Объявление для группы» остаётся висеть в шапке у одного человека, и
 *    узнать об этом ему неоткуда.
 *
 * Тест исходный, а не поведенческий: живой groupPinSync требует базы, ключей
 * и транспорта, а правило здесь — про форму ответа и про то, что его дочитали.
 */
const SOC = path.join(__dirname, '..');
const PIN = fs.readFileSync(path.join(SOC, 'groupPinSync.ts'), 'utf8');
const SCREEN = fs.readFileSync(
  path.join(SOC, '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
  'utf8'
);
const ANNOUNCE = fs.readFileSync(
  path.join(SOC, '..', '..', 'ui', 'groupControlAnnounce.ts'),
  'utf8'
);
const OUTCOME = fs.readFileSync(path.join(SOC, 'groupControlOutcome.ts'), 'utf8');

/** Тело функции: от строки объявления до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return '';
  return lines.slice(start, end + 1).join('\n');
}

/** Сколько раз строка встречается. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('отказ закрепления назван причиной, а не одним null', () => {
  it('причин три, и каждая — свой вариант', () => {
    expect(PIN).toContain("export type GroupPinRefusal = 'no_identity' | 'no_group' | 'denied';");
    const body = bodyOf(PIN, 'export async function togglePinAndSync(');
    expect(body).toContain("return { ok: false, reason: 'no_identity' };");
    expect(body).toContain("return { ok: false, reason: 'no_group' };");
    expect(body).toContain("return { ok: false, reason: 'denied' };");
    // Голого null в ответе больше нет — иначе три причины снова слились бы.
    expect(body).not.toContain('return null;');
  });

  it('фраза есть у каждой причины и перечень закрыт типом', () => {
    expect(PIN).toContain('const REFUSAL: Record<GroupPinRefusal, string> = {');
    expect(PIN).toContain('export function groupPinRefusalText(reason: GroupPinRefusal): string {');
    expect(PIN).toContain('Профиль ещё загружается');
    expect(PIN).toContain('Группа не найдена');
    expect(PIN).toContain('могут только администраторы');
  });

  it('экран берёт текст из таблицы, а не пишет «нет прав» на всё подряд', () => {
    expect(count(SCREEN, 'groupPinRefusalText(res.reason)')).toBe(3);
    expect(SCREEN).not.toContain("Alert.alert('Нет прав', 'Закреплять сообщения");
    expect(SCREEN).not.toContain("Alert.alert('Нет прав', 'Откреплять сообщения");
  });
});

describe('исход рассылки закрепления дочитан', () => {
  it('успех несёт и список, и обещание рассылки', () => {
    expect(PIN).toContain('| { ok: true; entries: PinnedEntry[]; sync: Promise<GroupControlOutcome> }');
    const body = bodyOf(PIN, 'export async function togglePinAndSync(');
    expect(body).toContain('return { ok: true, entries, sync };');
    // Обещание больше не выбрасывается внутри модуля.
    expect(body).not.toContain('void fanoutGroupControl(');
  });

  it('все три места закрепления объявляют исход', () => {
    expect(count(SCREEN, 'announceCtl(res.sync);')).toBe(3);
    expect(count(SCREEN, 'await togglePinAndSync(')).toBe(3);
  });

  it('объявление исхода — одно правило на промис и на готовый ответ', () => {
    expect(ANNOUNCE).toContain('export function announceCtlNow(outcome: GroupControlOutcome): void {');
    expect(ANNOUNCE).toContain('announceLater(sending, groupControlProblem);');
    // Проверка показа живёт в одном месте: своей копии у обёрток нет.
    expect(count(ANNOUNCE, 'const problem = groupControlProblem(outcome);')).toBe(0);
  });

  it('фраза расхождения называет, что именно видит собеседник', () => {
    expect(OUTCOME).toContain('у остальных в шапке чата прежнее');
  });
});

describe('проверка не пустая: прежняя редакция не проходит', () => {
  const BEFORE = [
    'export async function togglePinAndSync(params: {',
    '  groupId: string;',
    '}): Promise<PinnedEntry[] | null> {',
    '  const myPub = pair ? Buffer.from(pair.publicKey).toString(\'base64\') : \'\';',
    '  if (!myPub) return null;',
    '  const group = await getGroup(groupId, pid);',
    '  if (!group) return null;',
    '  if (!canPinInGroup({ role, adminOnlyPinning: group.adminOnlyPinning, type: group.type })) {',
    '    return null;',
    '  }',
    '  const entries = await applyLocalPin({ groupId, ownerProfileId: pid, msgId, on });',
    "  void fanoutGroupControl(groupId, myPub, { op: 'pin', msgId, on }, params.actorName ?? undefined);",
    '  return entries;',
    '}',
  ].join('\n');

  it('null-редакция валит оба правила разом', () => {
    const body = bodyOf(BEFORE, 'export async function togglePinAndSync(');
    expect(body).toContain('return null;');
    expect(body).toContain('void fanoutGroupControl(');
    expect(body).not.toContain("return { ok: false, reason: 'no_identity' };");
    expect(body).not.toContain('return { ok: true, entries, sync };');
  });
});
