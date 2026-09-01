/**
 * v4.32.440: чем кончилась рассылка в группу — разбор случаев, а не флаг.
 *
 * `fanoutGroupMessage` возвращал boolean. `false` значил сразу «права не
 * позволяют» и «служба обмена не поднята», а планировщик отложенных сообщений
 * читал его как первое и УДАЛЯЛ строку расписания: исчезновение службы на долю
 * секунды стирало сообщение, назначенное на утро. `true` значил «мы
 * попробовали» — отправка каждому участнику обёрнута в свой try/catch, и
 * провал всех отправок давал тот же ответ, что и успех: строка удалялась,
 * локальная копия писалась, сообщение не получал никто.
 *
 * Тест сторожит форму исправления: тип с разбором случаев, подсчёт адресатов
 * там же, где ловится отказ, и то, что расписание снимается только по
 * «правам».
 */
import fs from 'fs';
import path from 'path';

const MESSAGING = path.join(__dirname, '..', 'groupMessaging.ts');
const SCHEDULER = path.join(__dirname, '..', 'scheduledMessages.ts');
const OUTCOME = path.join(__dirname, '..', 'groupSendOutcome.ts');
const messaging = fs.readFileSync(MESSAGING, 'utf8');
const scheduler = fs.readFileSync(SCHEDULER, 'utf8');
// v4.32.450: разбор исхода переехал сюда из планировщика — он понадобился и
// экранам. Сторожим правило по новому месту, не ослабляя ни одной проверки.
const outcome = fs.readFileSync(OUTCOME, 'utf8');

/** Тело объявления: от строки-заголовка до первой закрывающей скобки в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  expect(start).toBeGreaterThanOrEqual(0);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`no terminator for ${head}`);
}

/** Строки кода без комментариев — чтобы пояснения не подменяли собой проверку. */
function codeLines(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

describe('итог групповой рассылки различает отказы', () => {
  it('тип разделяет «нет службы» и «нет прав»', () => {
    expect(messaging).toContain('export type GroupFanoutResult =');
    expect(messaging).toContain("{ ok: false; reason: 'no_service' }");
    expect(messaging).toContain("{ ok: false; reason: 'denied'; code: SendDenyCode }");
    expect(messaging).toContain('{ ok: true; members: number; sent: number; failed: number }');
  });

  it('рассылка больше не отвечает флагом', () => {
    const body = bodyOf(messaging, 'export async function fanoutGroupMessage(');
    const code = codeLines(body);
    expect(body).toContain('): Promise<GroupFanoutResult> {');
    expect(code.some((l) => l.trim() === 'return true;')).toBe(false);
    expect(code.some((l) => l.trim() === 'return false;')).toBe(false);
    // отказы возвращаются каждый со своей причиной
    expect(code.some((l) => l.includes("return { ok: false, reason: 'no_service' };"))).toBe(true);
    expect(code.some((l) => l.includes("return { ok: false, reason: 'denied', code: verdict.code };"))).toBe(true);
  });

  it('адресаты считаются там же, где ловится отказ', () => {
    const body = bodyOf(messaging, 'export async function fanoutGroupMessage(');
    const code = codeLines(body);
    const send = code.findIndex((l) => l.includes('await svc.sendMessage(m.peerPubB64, envelope);'));
    const okCount = code.findIndex((l) => l.trim() === 'sent += 1;');
    const catchLine = code.findIndex((l) => l.trim().startsWith('} catch (e) {') && code.indexOf(l) > send);
    const failCount = code.findIndex((l) => l.trim() === 'failed += 1;');
    expect(send).toBeGreaterThanOrEqual(0);
    expect(okCount).toBe(send + 1); // сразу после успешной отправки, до любого await
    expect(failCount).toBeGreaterThan(catchLine);
    expect(code.some((l) => l.includes('return { ok: true, members: targets.length, sent, failed };'))).toBe(true);
  });

  it('расписание снимается только по отзыву прав', () => {
    const body = bodyOf(scheduler, 'async function flushDueOnce(');
    const code = codeLines(body);
    const denied = code.findIndex((l) => l.includes("problem?.kind === 'denied'"));
    const noRecipient = code.findIndex((l) => l.trim() === 'if (problem) {');
    const insert = code.findIndex((l) => l.includes('await insertGroupMessage({'));
    expect(denied).toBeGreaterThanOrEqual(0);
    expect(noRecipient).toBeGreaterThan(denied);
    // обе ветки — до записи локальной копии и до удаления строки как «отправленной»
    expect(insert).toBeGreaterThan(noRecipient);
    // «никто не получил» не удаляет строку сразу, а откладывает до следующего тика
    const window = code.slice(noRecipient, noRecipient + 20).join('\n');
    expect(window).toContain('ABANDON_AFTER_MS');
    expect(window).toContain('continue;');
  });

  it('«никто не получил» описано одним правилом на весь код', () => {
    // Правило живёт в одном месте: планировщик и двенадцать мест отправки в UI
    // спрашивают его, а не повторяют условие каждый по-своему.
    expect(outcome).toContain(
      "if (res.members > 0 && res.sent === 0) return { kind: 'undelivered', reason: 'all_failed' };"
    );
    expect(scheduler).not.toContain('fanout.sent === 0');
    expect(scheduler).toContain('const problem = groupSendProblem(fanout);');
    // Отказ по правам и отказ по связи разведены: решения по ним обратные.
    expect(outcome).toContain("| { kind: 'denied'; code: SendDenyCode }");
    expect(outcome).toContain("| { kind: 'undelivered'; reason: 'no_service' | 'all_failed' };");
  });

  it('срок отказа от попыток записан одним правилом', () => {
    expect((scheduler.match(/15 \* 60_000/g) ?? []).length).toBe(1);
    expect(scheduler).toContain('const ABANDON_AFTER_MS = 15 * 60_000;');
    expect((scheduler.match(/ABANDON_AFTER_MS/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('проверки ловят прежний вид кода (не вакуумны)', () => {
    const oldFanout = [
      'export async function fanoutGroupMessage(',
      '  groupId: string',
      '): Promise<boolean> {',
      '  const svc = getMessagingService();',
      '  if (!svc) {',
      '    return false;',
      '  }',
      '  await Promise.allSettled(sends);',
      '  return true;',
      '}',
    ].join('\n');
    const code = codeLines(bodyOf(oldFanout, 'export async function fanoutGroupMessage('));
    expect(code.some((l) => l.trim() === 'return true;')).toBe(true);
    expect(oldFanout).not.toContain('Promise<GroupFanoutResult>');

    const oldScheduler = [
      'async function flushDueOnce(): Promise<void> {',
      '  const delivered = await fanoutGroupMessage(a, b, c, d, e);',
      '  if (!delivered) {',
      '    await deleteScheduledMessage(msg.id);',
      '    continue;',
      '  }',
      '  await insertGroupMessage({});',
      '}',
    ].join('\n');
    const sched = codeLines(bodyOf(oldScheduler, 'async function flushDueOnce('));
    expect(sched.some((l) => l.includes("fanout.reason === 'denied'"))).toBe(false);
    expect(sched.some((l) => l.includes('fanout.sent === 0'))).toBe(false);
  });
});
