/**
 * Рэтчет v4.32.446: «конверт опроса никуда не ушёл» больше не выдаётся за успех.
 *
 * Что ломалось. Голос в опросе и завершение опроса рассылаются служебными
 * конвертами. Если сервиса отправки в этот момент нет (запуск, переключение
 * профиля), castAndSyncPollVote возвращал `{ ok: true }`, а closeAndSyncPoll —
 * вообще ничего. Пузырь опроса показывает ошибку только по `ok: false`, а
 * экраны поверх этого печатали «Опрос завершён». Итог: голос записан только в
 * свою БД (очереди повторной отправки у служебного конверта нет — он не уйдёт
 * уже никогда), у автора опрос закрыт, у всех остальных открыт, и все уверены,
 * что видят одно и то же.
 *
 * Проверяем текст исходника, а не поведение: тут важно, что ни одна ветка не
 * может вернуть «успех», не сказав, скольким адресатам конверт передан.
 */
import * as fs from 'fs';
import * as path from 'path';

const SYNC = path.join(__dirname, '..', 'pollVoteSync.ts');
const FANOUT = path.join(__dirname, '..', 'controlFanout.ts');
const GROUPS = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx');
const CHAT = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx');

const src = fs.readFileSync(SYNC, 'utf8');
// v4.32.447: правило переехало в общую воронку — рэтчет переехал за ним.
const fanoutSrc = fs.readFileSync(FANOUT, 'utf8');
const groupsSrc = fs.readFileSync(GROUPS, 'utf8');
const chatSrc = fs.readFileSync(CHAT, 'utf8');

/** Тело функции: от строки объявления до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return '';
  return lines.slice(start, end + 1).join('\n');
}

/** Строки без комментариев — чтобы запреты не срабатывали на пояснениях. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

const funnelBody = (): string => bodyOf(fanoutSrc, 'export async function fanoutControlEnvelope(');
const voteBody = (): string => bodyOf(src, 'export async function castAndSyncPollVote(');
const closeBody = (): string => bodyOf(src, 'export async function closeAndSyncPoll(');

describe('v4.32.446 — итог доставки конверта опроса обязан быть назван', () => {
  it('FanoutResult — размеченное объединение, у каждой ветки своё обязательное поле', () => {
    expect(fanoutSrc).toContain('export type FanoutResult =');
    expect(fanoutSrc).toContain('| { sent: true; recipients: number }');
    expect(fanoutSrc).toContain('| { sent: false; reason: FanoutUndelivered };');
    // Необязательных полей быть не должно: «recipients?» снова позволил бы
    // вернуть успех, ничего никому не отправив.
    expect(fanoutSrc).not.toContain('recipients?:');
    expect(fanoutSrc).not.toContain('reason?: FanoutUndelivered');
  });

  it('три причины «не ушло» перечислены и различимы', () => {
    expect(fanoutSrc).toContain(
      "export type FanoutUndelivered = 'no_service' | 'no_peer' | 'all_failed';"
    );
    // Опросы больше не держат своей копии перечня — только псевдоним.
    expect(src).toContain('export type PollUndelivered = FanoutUndelivered;');
    expect(src).toContain('export type PollDelivery = FanoutResult;');
  });

  it('отправка живёт в одной воронке — и голос, и завершение ходят через неё', () => {
    const code = codeLines(src).join('\n');
    // Своей отправки у опросов не осталось вовсе: пока веток было две, каждая
    // сама решала, что считать успехом, и обе решили одинаково неверно.
    expect(code).not.toContain('getMessagingService');
    expect(code).not.toContain('sendMessage(');
    expect(code).not.toContain('Promise.allSettled');
    expect(code.split('fanoutControlEnvelope(').length - 1).toBe(2); // голос и завершение
    const fanoutCode = codeLines(fanoutSrc).join('\n');
    expect(fanoutCode.split('getMessagingService()').length - 1).toBe(1);
    expect(fanoutCode.split('svc.sendMessage(').length - 1).toBe(1);
    expect(funnelBody()).toContain('const svc = getMessagingService();');
    expect(funnelBody()).toContain('await svc.sendMessage(pub, payload);');
  });
});

describe('v4.32.446 — воронка не может назвать успехом непереданный конверт', () => {
  it('нет сервиса — это отказ, и он назван до всякой отправки', () => {
    const b = funnelBody();
    expect(b).toContain("return { sent: false, reason: 'no_service' };");
    const noSvc = b.indexOf("reason: 'no_service'");
    const send = b.indexOf('svc.sendMessage(');
    expect(noSvc).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(noSvc).toBeLessThan(send);
  });

  it('«некому» — только для лички: группа без других участников законна', () => {
    const b = funnelBody();
    expect(b).toContain("if (target.kind === 'dm' && recipients.length === 0) {");
    expect(b).toContain("return { sent: false, reason: 'no_peer' };");
    // Запрет на голый recipients.length === 0: он объявил бы отказом группу,
    // в которой кроме меня никого.
    const lines = codeLines(b);
    const bare = lines.filter(
      (l) => l.includes('recipients.length === 0') && !l.includes("target.kind === 'dm'")
    );
    expect(bare).toEqual([]);
  });

  it('если все отправки бросили — это отказ, а не успех с нулём адресатов', () => {
    const b = funnelBody();
    expect(b).toContain('if (accepted === 0 && recipients.length > 0) {');
    expect(b).toContain("return { sent: false, reason: 'all_failed' };");
    const fail = b.indexOf("reason: 'all_failed'");
    const ok = b.indexOf('return { sent: true, recipients: accepted };');
    expect(fail).toBeGreaterThan(-1);
    expect(ok).toBeGreaterThan(-1);
    expect(fail).toBeLessThan(ok);
  });

  it('успех считает принятые конверты, а не список получателей', () => {
    const b = funnelBody();
    expect(b).toContain('accepted += 1;');
    expect(b).toContain('return { sent: true, recipients: accepted };');
    expect(b).not.toContain('return { sent: true, recipients: recipients.length };');
  });
});

describe('v4.32.446 — оба вызывающих проговаривают отказ', () => {
  it('голос: непереданный конверт возвращается как ok: false с причиной', () => {
    const b = voteBody();
    expect(b).toContain('const delivery = await fanoutControlEnvelope(');
    expect(b).toContain('if (!delivery.sent) {');
    expect(b).toContain(
      "return { ok: false, reason: undeliveredText('Голос записан у вас', delivery.reason) };"
    );
    // Единственный успех — и он ниже проверки отказа.
    const okCount = b.split('return { ok: true };').length - 1;
    expect(okCount).toBe(1);
    expect(b.indexOf('if (!delivery.sent)')).toBeLessThan(b.indexOf('return { ok: true };'));
  });

  it('завершение: возвращает итог, а не void', () => {
    expect(src).toContain('}): Promise<PollCloseResult> {');
    const b = closeBody();
    expect(b).toContain('const delivery = await fanoutControlEnvelope(');
    expect(b).toContain(
      "return { ok: false, reason: undeliveredText('Опрос завершён у вас', delivery.reason) };"
    );
    expect(b).toContain('return { ok: true };');
    // Немых выходов не осталось: каждый return называет исход.
    const mute = codeLines(b).filter((l) => l.trim() === 'return;');
    expect(mute).toEqual([]);
  });

  it('текст отказа не врёт: у себя записано, а разослать не вышло', () => {
    expect(fanoutSrc).toContain("const tail = reason === 'no_peer' ? 'но разослать не вышло' : 'но остальные об этом не узнали';");
    expect(fanoutSrc).toContain("return `${head}, ${tail}: ${fanoutReasonText(reason, 'dm')}.`;");
    // Голова фразы называет то, что уже произошло: без неё «не разослано»
    // читается как «ничего не случилось», и человек жмёт ещё раз.
    expect(fanoutSrc).toContain('export function undeliveredText(head: string, reason: FanoutUndelivered): string {');
  });
});

describe('v4.32.446 — экраны больше не печатают «Опрос завершён» безусловно', () => {
  it('групповой экран смотрит на итог рассылки', () => {
    expect(groupsSrc).toContain(
      "if (res.ok) showSuccess('Опрос завершён'); else showError(res.reason);"
    );
    expect(groupsSrc).not.toContain(".then(() => showSuccess('Опрос завершён'))");
  });

  it('экран переписки смотрит на итог рассылки', () => {
    expect(chatSrc).toContain(
      "if (res.ok) showSuccess('Опрос завершён'); else showError(res.reason);"
    );
    expect(chatSrc).not.toContain(".then(() => showSuccess('Опрос завершён'))");
  });
});

describe('v4.32.446 — код до правки этот рэтчет не проходит', () => {
  const BEFORE = [
    'const svc = getMessagingService();',
    'if (!svc) {',
    "  log.warn('poll_vote_no_service');",
    '  return { ok: true };',
    '}',
    '',
    'if (groupId) {',
    '  const recipients = recipientsOf(members, myPubB64);',
    '  await Promise.allSettled(',
    '    recipients.map(async (pub) => {',
    '      try {',
    '        await svc.sendMessage(pub, payload);',
    '      } catch (e) {',
    "        log.warn('poll_vote_send_failed', { to: pub.slice(0, 12) });",
    '      }',
    '    })',
    '  );',
    '  return { ok: true };',
    '}',
  ].join('\n');

  it('старая ветка возвращала успех, ничего не отправив', () => {
    // Два разных исхода — «разослано» и «сервиса нет» — одним значением.
    expect(BEFORE.split('return { ok: true };').length - 1).toBe(2);
    expect(BEFORE).not.toContain('sent: false');
    expect(BEFORE).not.toContain('delivery.sent');
  });

  it('в старом виде отправка была размазана по веткам', () => {
    expect(BEFORE).not.toContain('fanoutControlEnvelope(');
  });
});
