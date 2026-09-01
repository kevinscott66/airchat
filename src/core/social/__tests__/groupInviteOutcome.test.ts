import * as fs from 'fs';
import * as path from 'path';

/**
 * Приглашение в группу и заявка на вступление больше не пропадают молча
 * (v4.32.451).
 *
 * Три отправки в groupMessaging.ts возвращали `void` и гасили любую беду в
 * лог: sendGroupInvite, sendGroupControlTo, sendGroupJoinRequest. Экраны
 * поверх них говорили обратное:
 *
 *  • «Участник принят» — а снимок группы одобренному мог не уйти, и группы у
 *    него так и не появлялось: та самая дыра, которую чинили в v4.32.231;
 *  • «Запрос отклонён» — а заявитель ответа не получал и продолжал ждать;
 *  • «Группа создана» — а выбранные контакты о группе не узнавали, и их
 *    сообщения отбрасывались как «неизвестная группа»;
 *  • «Запрос на вступление отправлен администратору» — при том, что у
 *    администратора в списке заявок не появлялось ни строчки, а повторить
 *    заявку заявителю неоткуда: группы у него нет.
 *
 * Повторной отправки у служебного конверта нет: «не ушло» значит «не уйдёт».
 *
 * Тест исходный, а не поведенческий: живой groupMessaging требует транспорта,
 * базы и ключей, а правило здесь — про то, что ответ отправки дочитан.
 */
const DIR = path.join(__dirname, '..');
const UI = path.join(__dirname, '..', '..', '..', 'ui');
const SOURCE = fs.readFileSync(path.join(DIR, 'groupMessaging.ts'), 'utf8');
const OUTCOME = fs.readFileSync(path.join(DIR, 'groupControlOutcome.ts'), 'utf8');
const SCREEN = fs.readFileSync(path.join(UI, 'screens', 'GroupsScreen.tsx'), 'utf8');
const CREATE = fs.readFileSync(
  path.join(UI, 'components', 'modals', 'groups', 'GroupCreateModal.tsx'),
  'utf8'
);
const ANNOUNCE = fs.readFileSync(path.join(UI, 'groupControlAnnounce.ts'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8');

/** Тело функции: от её объявления до строки, закрывающей объявление. */
function bodyOf(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.includes(`export async function ${name}(`));
  if (start < 0) return '';
  let end = start;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

/** Строки тела без комментариев — правило проверяется по коду, а не по прозе. */
function codeLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

/** Сколько раз строка встречается. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('отправки называют исход, а не молчат', () => {
  it('заявка на вступление отдаёт итог рассылки', () => {
    const body = bodyOf(SOURCE, 'sendGroupJoinRequest');
    expect(body).toContain('): Promise<FanoutResult> {');
    expect(body).toContain("{ kind: 'dm', peerPubB64: adminPubB64 }");
    expect(body).toContain('return res;');
    // Своя копия «есть ли сервис отправки» ушла в воронку.
    expect(body).not.toContain('getMessagingService');
    expect(body).not.toContain('svc.sendMessage');
  });

  it('адресный управляющий конверт отдаёт итог вместе с операцией', () => {
    const body = bodyOf(SOURCE, 'sendGroupControlTo');
    expect(body).toContain('): Promise<GroupControlOutcome> {');
    expect(body).toContain('fanoutControlEnvelope(');
    expect(body).toContain("{ op: ctl.op, sent: true, recipients: res.recipients }");
    expect(body).toContain("{ op: ctl.op, sent: false, reason: res.reason }");
    expect(body).not.toContain('Promise.allSettled');
    expect(body).not.toContain('getMessagingService');
  });

  it('приглашение отдаёт итог вместе с операцией', () => {
    const body = bodyOf(SOURCE, 'sendGroupInvite');
    expect(body).toContain('): Promise<GroupControlOutcome> {');
    expect(body).toContain("fanoutControlEnvelope('group_invite', payload, { kind: 'group', recipients })");
    expect(body).toContain("{ op: 'invite', sent: true, recipients: res.recipients }");
    expect(body).toContain("{ op: 'invite', sent: false, reason: res.reason }");
    expect(body).not.toContain('Promise.allSettled');
    expect(body).not.toContain('getMessagingService');
  });

  it('успех логируется только когда он есть', () => {
    const invite = bodyOf(SOURCE, 'sendGroupInvite');
    const direct = bodyOf(SOURCE, 'sendGroupControlTo');
    expect(invite).toContain("if (res.sent) log.info('group_invite_sent'");
    expect(direct).toContain("if (res.sent) log.info('group_ctl_direct_sent'");
  });
});

describe('ни один вызов не выбрасывает ответ', () => {
  const FILES: [string, string][] = [
    ['groupMessaging.ts', SOURCE],
    ['GroupsScreen.tsx', SCREEN],
    ['GroupCreateModal.tsx', CREATE],
    ['App.tsx', APP],
  ];

  it.each(FILES)('%s: нет `void sendGroupInvite` и `void sendGroupJoinRequest`', (_name, src) => {
    expect(src).not.toContain('void sendGroupInvite(');
    expect(src).not.toContain('void sendGroupJoinRequest(');
  });

  it('одобрение заявки дочитывает ответ перед «принят»', () => {
    const code = codeLines(SCREEN);
    const send = code.findIndex((l) => l.includes('await sendGroupInvite('));
    const read = code.findIndex((l) => l === 'if (invite) showError(invite);');
    const say = code.findIndex((l) => l.includes("} принят`);"));
    expect(send).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(send);
    expect(say).toBeGreaterThan(read);
    // «принят» — только в ветке else: иначе обе надписи показались бы разом.
    expect(code[say]).toContain('else showSuccess(');
  });

  it('отказ по заявке дочитывает ответ перед «отклонён»', () => {
    const code = codeLines(SCREEN);
    const send = code.findIndex((l) => l.includes('await sendGroupControlTo('));
    const say = code.findIndex((l) => l.includes("} отклонён`);"));
    expect(send).toBeGreaterThanOrEqual(0);
    expect(say).toBeGreaterThan(send);
    expect(code[say]).toContain('else showSuccess(');
    expect(SCREEN).toContain('if (answer) showError(answer);');
  });

  it('создание группы объявляет исход приглашения', () => {
    expect(CREATE).toContain('announceCtl(sendGroupInvite(');
    expect(CREATE).toContain("import { announceCtl } from '../../../groupControlAnnounce';");
  });

  it('вход по ссылке не обещает отправленную заявку', () => {
    expect(APP).toContain('const asked = await sendGroupJoinRequest(');
    expect(APP).toContain("joinRequestProblem(asked) ?? 'Запрос на вступление отправлен администратору'");
    expect(APP).not.toContain("Alert.alert('AirChat', 'Запрос на вступление отправлен администратору')");
  });
});

describe('правило показа живёт в одном месте', () => {
  it('announceCtl объявлен ровно один раз и вне экрана', () => {
    expect(ANNOUNCE).toContain('export function announceCtl(sending: Promise<GroupControlOutcome>): void {');
    expect(SCREEN).not.toContain('function announceCtl(');
    expect(SCREEN).toContain('import { announceCtl');
    expect(SCREEN).toContain("} from '../groupControlAnnounce';");
    expect(count(ANNOUNCE, 'function announceCtl(')).toBe(1);
  });

  it('причина «почему не ушло» одна на весь модуль текстов', () => {
    expect(OUTCOME).toContain('function why(reason: FanoutUndelivered): string {');
    // groupControlProblem больше не держит своей копии фразы — зовёт why().
    expect(OUTCOME).toContain('return `${DIVERGENCE[outcome.op]} (${why(outcome.reason)}).`;');
    expect(count(OUTCOME, "'некому отправить'")).toBe(0);
    expect(OUTCOME).toContain("return fanoutReasonText(reason, 'group');");
  });

  it('заявка на вступление названа своими словами', () => {
    expect(OUTCOME).toContain('export function joinRequestProblem(res: FanoutResult): string | null {');
    expect(OUTCOME).toContain('в ссылке нет администратора группы');
    expect(OUTCOME).toContain('Откройте ссылку ещё раз, когда появится связь');
  });

  it('приглашение и ответ на заявку называют последствие, а не факт отправки', () => {
    expect(OUTCOME).toContain('invite: \'Приглашение не ушло — группа у приглашённых не появится');
    expect(OUTCOME).toContain('joinres: \'Ответ на заявку не ушёл — заявитель решения не увидит');
  });
});

describe('проверка не пустая: прежняя редакция не проходит', () => {
  const BEFORE = [
    'export async function sendGroupInvite(',
    '  groupId: string,',
    '  recipients: string[]',
    '): Promise<void> {',
    '  const svc = getMessagingService();',
    '  if (!svc || !recipients.length) return;',
    '  await Promise.allSettled(',
    '    recipients.map(async (pub) => {',
    '      try {',
    '        await svc.sendMessage(pub, payload);',
    '      } catch (e) {',
    "        log.warn('group_invite_send_failed', { to: pub.slice(0, 12) });",
    '      }',
    '    })',
    '  );',
    "  log.info('group_invite_sent', { gid: groupId.slice(0, 8), to: recipients.length });",
    '}',
  ].join('\n');

  it('void-редакция приглашения провалила бы все три правила', () => {
    const body = bodyOf(BEFORE, 'sendGroupInvite');
    expect(body).toContain('): Promise<void> {');
    expect(body).toContain('Promise.allSettled');
    expect(body).toContain('getMessagingService');
    expect(body).not.toContain("{ op: 'invite', sent: false, reason: res.reason }");
  });
});
