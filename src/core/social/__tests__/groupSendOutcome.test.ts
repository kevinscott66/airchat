/**
 * Рэтчет v4.32.450: групповое сообщение, которое никуда не ушло, больше не
 * выглядит отправленным.
 *
 * Что ломалось. fanoutGroupMessage с v4.32.440 возвращает разбор случаев:
 * «прав нет» (повторять бессмысленно), «службы обмена нет», «разослано —
 * столько из стольких». Пользовался этим ровно один вызывающий — планировщик
 * отложенных. Все двенадцать мест отправки в UI писали
 * `void fanoutGroupMessage(...)`.
 *
 * Своя строка при этом уже лежит в переписке: экраны пишут её ДО рассылки,
 * иначе своё сообщение не появилось бы на своём экране. Поэтому отказ ничем не
 * отличался от отправки — навсегда. Забаненный или переведённый в «только
 * чтение» видел свои сообщения в группе и не понимал, почему никто не
 * отвечает; та же картина при обрыве связи.
 */
import * as fs from 'fs';
import * as path from 'path';

const SOC = path.join(__dirname, '..');
const UI = path.join(SOC, '..', '..', 'ui');
const outcomeSrc = fs.readFileSync(path.join(SOC, 'groupSendOutcome.ts'), 'utf8');
const policySrc = fs.readFileSync(path.join(SOC, 'groupSendPolicy.ts'), 'utf8');
const announceSrc = fs.readFileSync(path.join(UI, 'groupSendAnnounce.ts'), 'utf8');
const CALLERS = [
  path.join(UI, 'screens', 'GroupsScreen.tsx'),
  path.join(UI, 'screens', 'FeedScreen.tsx'),
  path.join(UI, 'components', 'modals', 'chat', 'ChatForwardModal.tsx'),
];

/** Тело функции: от строки объявления до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return '';
  return lines.slice(start, end + 1).join('\n');
}

describe('v4.32.450 — беда рассылки названа в одном месте', () => {
  it('два случая разведены, потому что решения по ним обратные', () => {
    expect(outcomeSrc).toContain('export type GroupSendProblem =');
    expect(outcomeSrc).toContain("| { kind: 'denied'; code: SendDenyCode }");
    expect(outcomeSrc).toContain("| { kind: 'undelivered'; reason: 'no_service' | 'all_failed' };");
  });

  it('успех с нулём принявших бедой считается, пустая группа — нет', () => {
    const b = bodyOf(outcomeSrc, 'export function groupSendProblem(');
    expect(b).not.toBe('');
    expect(b).toContain("if (res.members > 0 && res.sent === 0) return { kind: 'undelivered', reason: 'all_failed' };");
    expect(b).toContain('return null;');
  });

  it('текст отказа по правам берётся из политики, а не переписан заново', () => {
    expect(policySrc).toContain('export function sendDenyText(code: SendDenyCode): string {');
    expect(policySrc).toContain('return DENY[code];');
    expect(outcomeSrc).toContain('sendDenyText(problem.code)');
    // Своей таблицы причин у разбора исхода нет.
    expect(outcomeSrc).not.toContain('not_member:');
    expect(outcomeSrc).not.toContain('admin_only_posting:');
  });

  it('обе фразы кончаются «осталось только у вас»', () => {
    const b = bodyOf(outcomeSrc, 'export function groupSendProblemText(');
    expect(b).toContain('Сообщение осталось только у вас.');
    expect(b).toContain('Сообщение не ушло никому из участников: нет связи. Оно осталось только у вас.');
  });
});

describe('v4.32.450 — ни один вызов не выбрасывает исход', () => {
  it('void-вызовов рассылки не осталось нигде', () => {
    for (const f of CALLERS) {
      expect(fs.readFileSync(f, 'utf8')).not.toContain('void fanoutGroupMessage(');
    }
  });

  it('каждый вызов либо через announceGroupSend, либо разобран вручную', () => {
    let total = 0;
    for (const f of CALLERS) {
      const all = fs.readFileSync(f, 'utf8').split('\n');
      const loose: string[] = [];
      all.forEach((l, i) => {
        if (!l.includes('fanoutGroupMessage(') || l.trim().startsWith('*')) return;
        if (l.includes('import') || l.includes('const { fanoutGroupMessage')) return;
        total += 1;
        const covered =
          l.includes('announceGroupSend(fanoutGroupMessage(') ||
          l.includes('await fanoutGroupMessage(') ||
          // Перенос: announceGroupSend( на строке выше — вызов с цитатой длинный.
          (all[i - 1] ?? '').trim().endsWith('announceGroupSend(');
        if (!covered) loose.push(l);
      });
      expect(loose).toEqual([]);
    }
    expect(total).toBeGreaterThanOrEqual(12);
  });

  it('воронка показа одна на все экраны и молчит при успехе', () => {
    const b = bodyOf(announceSrc, 'export function announceGroupSend(');
    expect(b).not.toBe('');
    expect(b).toContain('const problem = groupSendProblem(res);');
    expect(b).toContain('if (problem) showError(groupSendProblemText(problem));');
    // Своей проверки исхода у воронки нет — она спрашивает правило.
    expect(b).not.toContain('sent === 0');
    expect(b).not.toContain("reason === 'denied'");
  });

  it('пересылка не считает переслáнным чат, куда не ушло', () => {
    const fwd = fs.readFileSync(CALLERS[2], 'utf8');
    expect(fwd).toContain('const problem = groupSendProblem(');
    expect(fwd).toContain('if (problem) denied.push(`«${group.name}» — ${groupSendProblemShort(problem)}`);');
    expect(fwd).toContain('else sent += 1;');
    // Счётчик «Переслано в N чатов» стоит после разбора, а не до него.
    expect(fwd.indexOf('else sent += 1;')).toBeLessThan(fwd.indexOf('if (sent > 0) showSuccess('));
  });

  it('короткая причина — для перечислений, целая фраза туда не лезет', () => {
    const b = bodyOf(outcomeSrc, 'export function groupSendProblemShort(');
    expect(b).toContain("sendDenyText(problem.code).toLowerCase() : 'нет связи';");
  });
});

describe('v4.32.450 — код до правки этот рэтчет не проходит', () => {
  const BEFORE = [
    'await insertGroupMessage(row);',
    'void fanoutGroupMessage(group.id, docText, myDisplayName, myPubB64, row.id);',
    'sent += 1;',
  ].join('\n');

  it('старый вызов писал строку и выбрасывал исход', () => {
    expect(BEFORE).toContain('void fanoutGroupMessage(');
    expect(BEFORE).not.toContain('announceGroupSend(');
    expect(BEFORE).not.toContain('groupSendProblem(');
  });

  it('старый счётчик пересылки считал отказ отправкой', () => {
    expect(BEFORE.indexOf('sent += 1;')).toBeGreaterThan(BEFORE.indexOf('void fanoutGroupMessage('));
    expect(BEFORE).not.toContain('else sent += 1;');
  });
});
