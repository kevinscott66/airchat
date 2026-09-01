import * as fs from 'fs';
import * as path from 'path';

/**
 * Закрепление в личном чате: отправка собеседнику перестала быть немой
 * (v4.32.454).
 *
 * Закрепление живёт сразу в двух шапках — моей и его. Уходило оно как
 * `void sendDmPin(...)`: отказ отправки писался в лог и не доходил ни до кого.
 * Повторной отправки у служебного конверта нет, поэтому «не ушло» значит «не
 * уйдёт»: у меня в шапке висит закреплённое, у собеседника пусто, и оба
 * уверены, что видят одно и то же. Хуже всего «Открепить всё» — человек
 * убирает из шапки то, чего не хочет видеть, а у второго это остаётся.
 *
 * Заодно вычищена третья копия фразы «почему не ушло»: она была в общем
 * тексте, в текстах группы и в предупреждении таймера, и уже разошлась.
 *
 * Тест исходный, а не поведенческий: живой dmPinSync требует базы, ключей и
 * транспорта, а правило здесь — про форму ответа и про то, что его дочитали.
 */
const SOC = path.join(__dirname, '..');
const UI = path.join(SOC, '..', '..', 'ui');
const PIN = fs.readFileSync(path.join(SOC, 'dmPinSync.ts'), 'utf8');
const OUTCOME = fs.readFileSync(path.join(SOC, 'dmPinOutcome.ts'), 'utf8');
const FANOUT = fs.readFileSync(path.join(SOC, 'controlFanout.ts'), 'utf8');
const GROUP_OUTCOME = fs.readFileSync(path.join(SOC, 'groupControlOutcome.ts'), 'utf8');
const DISAPPEAR = fs.readFileSync(path.join(SOC, 'disappearSync.ts'), 'utf8');
const ANNOUNCE = fs.readFileSync(path.join(UI, 'dmPinAnnounce.ts'), 'utf8');
const RULE = fs.readFileSync(path.join(UI, 'announceOutcome.ts'), 'utf8');
const SCREEN = fs.readFileSync(path.join(UI, 'screens', 'ChatScreen.tsx'), 'utf8');

/** Тело функции: от строки объявления до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return '';
  return lines.slice(start, end + 1).join('\n');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('v4.32.454 — отправка закрепления в личке называет свой исход', () => {
  it('sendDmPin отдаёт исход, а не void, и идёт через общую воронку', () => {
    const body = bodyOf(PIN, 'async function sendDmPin(');
    expect(body).not.toBe('');
    expect(body).toContain('): Promise<DmPinOutcome> {');
    expect(body).toContain("kind: 'dm',");
    expect(body).toContain('const res = await fanoutControlEnvelope(');
    // Своего мнения о том, что считать отправленным, у лички больше нет.
    expect(PIN).not.toContain("import { getMessagingService }");
    expect(PIN).not.toContain('dm_pin_no_service');
  });

  it('операция вшита в исход: отказ открепления не выдать за отказ закрепления', () => {
    expect(OUTCOME).toContain("export type DmPinOp = 'pin' | 'unpin' | 'clear';");
    expect(OUTCOME).toContain('export type DmPinOutcome = { op: DmPinOp } & FanoutResult;');
    expect(OUTCOME).toContain('const DIVERGENCE: Record<DmPinOp, string> = {');
    const send = bodyOf(PIN, 'async function sendDmPin(');
    expect(send).toContain('? { op, sent: true, recipients: res.recipients }');
    expect(send).toContain(': { op, sent: false, reason: res.reason };');
  });

  it('фразы называют расхождение, а не ошибку отправки', () => {
    expect(OUTCOME).toContain('у собеседника в шапке чата ничего не появилось');
    expect(OUTCOME).toContain('у собеседника оно осталось в шапке');
    expect(OUTCOME).toContain('у собеседника они остались в шапке');
    expect(OUTCOME).toContain('if (outcome.sent) return null;');
    expect(OUTCOME).toContain("`${DIVERGENCE[outcome.op]} (${fanoutReasonText(outcome.reason, 'dm')}).`");
  });

  it('вызывающий не может выбросить исход', () => {
    expect(PIN).toContain('export type DmPinSyncResult = {');
    expect(PIN).toContain('sync: Promise<DmPinOutcome>;');
    expect(PIN).not.toContain('void sendDmPin(');
    const toggle = bodyOf(PIN, 'export async function toggleDmPinAndSync(');
    expect(toggle).toContain('): Promise<DmPinSyncResult> {');
    expect(toggle).toContain("const sync = sendDmPin(on ? 'pin' : 'unpin', peerPubB64,");
    expect(toggle).toContain('return { entries, sync };');
    const clear = bodyOf(PIN, 'export async function clearDmPinnedAndSync(');
    expect(clear).toContain('): Promise<DmPinSyncResult> {');
    expect(clear).toContain("const sync = sendDmPin('clear', peerPubB64,");
    expect(clear).toContain('return { entries: [], sync };');
  });

  it('все три места закрепления в чате объявляют исход', () => {
    expect(count(SCREEN, 'announceDmPin(res.sync);')).toBe(3);
    expect(count(SCREEN, "import { announceDmPin } from '../dmPinAnnounce';")).toBe(1);
    // Список для баннера берётся из ответа, а не выдумывается на месте.
    expect(SCREEN).toContain('setPinnedMsgList(res.entries);');
    expect(SCREEN).not.toContain('await clearDmPinnedAndSync(peerB64);\n                    setPinnedMsgList([]);');
  });

  it('правило показа одно на все виды конвертов', () => {
    expect(ANNOUNCE).toContain('announceLater(sending, dmPinProblem);');
    expect(RULE).toContain('export function announceNow<T>(outcome: T, problem: (o: T) => string | null): void {');
    expect(RULE).toContain('export function announceLater<T>(sending: Promise<T>, problem: (o: T) => string | null): void {');
    expect(count(RULE, 'showError(')).toBe(1);
    expect(count(ANNOUNCE, 'showError(')).toBe(0);
  });
});

describe('v4.32.454 — «почему не ушло» живёт в одном месте', () => {
  it('пара фраз объявлена рядом с самой причиной', () => {
    expect(FANOUT).toContain("const NO_PEER: Record<FanoutTarget['kind'], string> = {");
    expect(FANOUT).toContain("dm: 'собеседник не определён',");
    expect(FANOUT).toContain("group: 'некому отправить',");
    expect(FANOUT).toContain(
      "export function fanoutReasonText(reason: FanoutUndelivered, kind: FanoutTarget['kind']): string {"
    );
    expect(count(FANOUT, "'нет связи'")).toBe(1);
  });

  it('прежние три копии зовут общий дом', () => {
    expect(GROUP_OUTCOME).toContain("return fanoutReasonText(reason, 'group');");
    expect(GROUP_OUTCOME).not.toContain("'некому отправить'");
    expect(DISAPPEAR).toContain("const why = fanoutReasonText(reason, 'dm');");
    expect(DISAPPEAR).not.toContain("'собеседник не определён'");
    expect(bodyOf(FANOUT, 'export function undeliveredText(')).toContain(
      "return `${head}, ${tail}: ${fanoutReasonText(reason, 'dm')}.`;"
    );
    expect(OUTCOME).not.toContain("'нет связи'");
  });
});

describe('проверка не пустая: прежняя редакция не проходит', () => {
  const BEFORE = [
    'async function sendDmPin(peerPubB64: string, env: DmPinEnvelope): Promise<void> {',
    '  const svc = getMessagingService();',
    '  if (!svc) {',
    "    log.warn('dm_pin_no_service');",
    '    return;',
    '  }',
    '  try {',
    '    await svc.sendMessage(peerPubB64, encodeDmPinEnvelope(env));',
    '  } catch (e) {',
    "    log.warn('dm_pin_send_failed', {});",
    '  }',
    '}',
    '',
    'export async function toggleDmPinAndSync(params: {',
    '  on: boolean;',
    '}): Promise<DmPinnedEntry[]> {',
    '  const entries = await applyLocalDmPin({ peerPubB64, ownerProfileId: pid, msgId, on });',
    '  void sendDmPin(peerPubB64, { msgId, on, ts: Date.now() });',
    '  return entries;',
    '}',
  ].join('\n');

  it('немая редакция валит оба правила разом', () => {
    expect(bodyOf(BEFORE, 'async function sendDmPin(')).toContain('Promise<void>');
    expect(BEFORE).toContain('void sendDmPin(');
    expect(BEFORE).not.toContain('return { entries, sync };');
    expect(bodyOf(BEFORE, 'export async function toggleDmPinAndSync(')).not.toContain(
      'DmPinSyncResult'
    );
  });
});
