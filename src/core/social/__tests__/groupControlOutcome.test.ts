/**
 * Рэтчет v4.32.449: рассылка управляющего конверта группы обязана называть исход.
 *
 * Что ломалось. fanoutGroupControl возвращал void, и все двадцать с лишним
 * вызовов писали `void fanoutGroupControl(...)`. Бан, кик, смена роли,
 * «удалить у всех», настройки группы, выход из группы — всё применялось
 * локально и показывалось как сделанное, а конверт мог не уйти вовсе: нет
 * сервиса отправки на старте или после смены профиля, нет связи. Повторной
 * отправки у служебного конверта нет: «не ушло» значит «не уйдёт».
 *
 * Расхождение при этом не косметическое. Забаненный продолжает писать всем,
 * кроме забанившего. Вышедший остаётся в чужих списках — а модалка обещает
 * дословно «Участники увидят, что вы вышли». Удалённое «у всех» сообщение
 * остаётся у всех. Узнать об этом человеку было неоткуда.
 */
import * as fs from 'fs';
import * as path from 'path';

const SOC = path.join(__dirname, '..');
const outcomeSrc = fs.readFileSync(path.join(SOC, 'groupControlOutcome.ts'), 'utf8');
const msgSrc = fs.readFileSync(path.join(SOC, 'groupMessaging.ts'), 'utf8');
const envSrc = fs.readFileSync(path.join(SOC, 'groupControlEnvelope.ts'), 'utf8');
const groupsSrc = fs.readFileSync(
  path.join(SOC, '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
  'utf8'
);
const appSrc = fs.readFileSync(path.join(SOC, '..', '..', 'App.tsx'), 'utf8');
// v4.32.451: announceCtl переехал из экрана групп в свой модуль — приглашение
// при создании группы зовёт его из другого файла, и вторая копия правила
// «молчать при успехе» была бы первым шагом к их расхождению.
const announceSrc = fs.readFileSync(
  path.join(SOC, '..', '..', 'ui', 'groupControlAnnounce.ts'),
  'utf8'
);
// v4.32.454: само правило показа — уже в третьем месте (группа, ссылка, личка),
// поэтому живёт отдельно, а обёртки только зовут его.
const ruleSrc = fs.readFileSync(path.join(SOC, '..', '..', 'ui', 'announceOutcome.ts'), 'utf8');

/** Тело функции: от строки объявления до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return '';
  return lines.slice(start, end + 1).join('\n');
}

/** Все операции управляющего конверта — по объявлению типа, а не по списку в тесте. */
function declaredOps(): string[] {
  const out: string[] = [];
  for (const line of envSrc.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('| { op: ') && !t.startsWith('op: ')) continue;
    const m = t.match(/op: '([a-z]+)'/);
    if (m) out.push(m[1]);
  }
  return out;
}

const fanoutBody = (): string => bodyOf(msgSrc, 'export async function fanoutGroupControl(');

describe('v4.32.449 — исход рассылки возвращается наверх', () => {
  it('операция вшита в итог, поэтому подписать чужим отказом нечем', () => {
    expect(outcomeSrc).toContain(
      "export type GroupControlOutcome = { op: GroupCtlOp['op'] } & FanoutResult;"
    );
    expect(msgSrc).toContain('): Promise<GroupControlOutcome> {');
    expect(msgSrc).not.toContain(`export async function fanoutGroupControl(
  groupId: string,
  senderPubB64: string,
  ctl: GroupCtlOp,
  actorName?: string
): Promise<void> {`);
  });

  it('своей копии отправки у группового конверта не осталось', () => {
    const b = fanoutBody();
    expect(b).not.toBe('');
    expect(b).not.toContain('getMessagingService');
    expect(b).not.toContain('svc.sendMessage(');
    expect(b).not.toContain('Promise.allSettled');
    expect(b).toContain('await fanoutControlEnvelope(`group_ctl_${ctl.op}`, payload, {');
  });

  it('правило адресатов сохранено: адресат операции получает конверт даже забаненным', () => {
    const b = fanoutBody();
    expect(b).toContain('const recipients = new Set(activeRecipients(members, senderPubB64));');
    expect(b).toContain(
      "if ('target' in ctl && ctl.target && ctl.target !== senderPubB64) recipients.add(ctl.target);"
    );
    // Добавление адресата — до отправки, иначе оно ни на что не влияет.
    expect(b.indexOf('recipients.add(ctl.target)')).toBeLessThan(b.indexOf('fanoutControlEnvelope('));
  });
});

describe('v4.32.449 — фраза есть у каждой операции', () => {
  it('в конверте объявлено не меньше десятка операций', () => {
    expect(declaredOps().length).toBeGreaterThanOrEqual(12);
  });

  it('каждая объявленная операция названа своими словами', () => {
    const missing = declaredOps().filter((op) => !outcomeSrc.includes(`  ${op}: '`));
    expect(missing).toEqual([]);
  });

  it('перечень операций закрыт типом — новая не соберётся без фразы', () => {
    expect(outcomeSrc).toContain("const DIVERGENCE: Record<GroupCtlOp['op'], string> = {");
  });

  it('текст говорит о расхождении, а не об ошибке отправки', () => {
    expect(outcomeSrc).toContain('остальные по-прежнему видят его сообщения');
    expect(outcomeSrc).toContain('в чужих списках он остался');
    expect(outcomeSrc).toContain('у остальных оно осталось');
    expect(outcomeSrc).toContain('для них вы остались в списке');
    // Причина в скобках, а не вместо сути. v4.32.451: причина вынесена в why()
    // и у фразы ровно один дом — её делит текст заявки на вступление.
    // v4.32.454: сама фраза переехала в controlFanout — у лички и у группы она
    // разная, но дом у пары один; здесь остался только выбор «группа».
    expect(outcomeSrc).toContain("return fanoutReasonText(reason, 'group');");
    expect(outcomeSrc.split("'некому отправить'").length - 1).toBe(0);
    expect(outcomeSrc).toContain('return `${DIVERGENCE[outcome.op]} (${why(outcome.reason)}).`;');
  });

  it('успех молчит', () => {
    expect(outcomeSrc).toContain('if (outcome.sent) return null;');
  });
});

describe('v4.32.449 — ни один вызов больше не выбрасывает итог', () => {
  it('в экране групп не осталось void-вызовов рассылки', () => {
    expect(groupsSrc).not.toContain('void fanoutGroupControl(');
  });

  it('каждый вызов рассылки либо через announceCtl, либо разобран вручную', () => {
    const calls = groupsSrc
      .split('\n')
      .filter((l) => l.includes('fanoutGroupControl(') && !l.includes('import'));
    // v4.32.531: было 21. Пять из них были пятью копиями одного и того же
    // переключателя настроек группы (четыре пункта меню и команда /readonly);
    // теперь рассылка у них общая, и копий стало на три строки меньше. Порог
    // опущен из-за склейки дубликатов, а не из-за потерянного вызова: правило
    // ниже — «ни одного вызова мимо announceCtl» — не ослаблено.
    expect(calls.length).toBeGreaterThanOrEqual(18);
    const loose = calls.filter(
      (l) => !l.includes('announceCtl(fanoutGroupControl(') && !l.includes('await fanoutGroupControl(')
    );
    expect(loose).toEqual([]);
  });

  it('announceCtl молчит при успехе и называет расхождение при отказе', () => {
    // v4.32.453: само правило переехало в announceCtlNow — закрепление отдаёт
    // уже готовый исход, и вторая копия «молчать при успехе» была бы лишней.
    // v4.32.454: «молчать при успехе» переехало в announceOutcome — одно на все
    // виды конвертов; здесь остались типизированные обёртки над ним.
    const now = bodyOf(announceSrc, 'export function announceCtlNow(');
    expect(now).not.toBe('');
    expect(now).toContain('announceNow(outcome, groupControlProblem);');
    expect(bodyOf(announceSrc, 'export function announceCtl(')).toContain(
      'announceLater(sending, groupControlProblem);'
    );
    const rule = bodyOf(ruleSrc, 'export function announceNow<T>(');
    expect(rule).toContain('const text = problem(outcome);');
    expect(rule).toContain('if (text) showError(text);');
  });

  it('у announceCtl один дом: экран его импортирует, а не объявляет', () => {
    expect(groupsSrc).not.toContain('function announceCtl(');
    expect(groupsSrc).toContain('import { announceCtl');
    expect(groupsSrc).toContain("} from '../groupControlAnnounce';");
  });

  it('выход из группы: обещание модалки отзывается, а группа всё равно удаляется', () => {
    expect(groupsSrc).toContain('Участники увидят, что вы вышли');
    // Смотрим ровно тот блок, где решается выход: `if (problem) showError`
    // встречается в файле не единожды, и по всему файлу порядок ничего не значит.
    const block = groupsSrc.slice(groupsSrc.indexOf('let problem: string | null = null;'));
    expect(block).toContain('problem = groupControlProblem(');
    const del = block.indexOf('await deleteGroup(g.id, pid);');
    const say = block.indexOf('if (problem) showError(problem);');
    expect(del).toBeGreaterThan(-1);
    expect(say).toBeGreaterThan(del);
  });

  it('вступление по ссылке: «Вы добавлены в группу» не выдаётся, если о нас не узнали', () => {
    expect(appSrc).toContain('const intro = await fanoutGroupControl(');
    expect(appSrc).toContain(
      "Alert.alert('AirChat', groupControlProblem(intro) ?? `Вы добавлены в группу \"${safeName}\"`);"
    );
    expect(appSrc).not.toContain('void fanoutGroupControl(');
  });
});

describe('v4.32.449 — код до правки этот рэтчет не проходит', () => {
  const BEFORE = [
    'const svc = getMessagingService();',
    'if (!svc) {',
    "  log.warn('group_ctl_no_service');",
    '  return;',
    '}',
    'await Promise.allSettled(',
    '  [...recipients].map(async (pub) => {',
    '    try {',
    '      await svc.sendMessage(pub, payload);',
    '    } catch (e) {',
    "      log.warn('group_ctl_send_failed', { member: pub.slice(0, 12) });",
    '    }',
    '  })',
    ');',
  ].join('\n');
  const BEFORE_CALL = "void fanoutGroupControl(group.id, myPubB64, { op: 'ban', target: t }, name);";

  it('старая рассылка молчала о себе', () => {
    expect(BEFORE).toContain('getMessagingService()');
    expect(BEFORE).toContain('  return;');
    expect(BEFORE).not.toContain('GroupControlOutcome');
    expect(BEFORE).not.toContain('fanoutControlEnvelope(');
  });

  it('старый вызов выбрасывал итог по одному void за раз', () => {
    expect(BEFORE_CALL).toContain('void fanoutGroupControl(');
    expect(BEFORE_CALL).not.toContain('announceCtl(');
  });
});
