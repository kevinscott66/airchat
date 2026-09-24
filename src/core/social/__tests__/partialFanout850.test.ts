/**
 * Доставка «не всем» больше не выдаётся за доставку всем (v4.32.850).
 *
 * Дефект. Обе воронки рассылки считали успехом «принял хоть кто-то».
 * `fanoutControlEnvelope` возвращала `{ sent: true, recipients: 1 }` при
 * девятнадцати адресатах, а `groupSendProblem` объявляла бедой только круглый
 * ноль принявших. Знаменатель — скольким предназначалось — до вызывающего не
 * доезжал вовсе: он оставался в журнале (`of: recipients.size`) и там же
 * умирал.
 *
 * Цена. Повтора ни у служебного конверта, ни у группового сообщения нет:
 * «не приняли» здесь значит «не узнают никогда». Администратор исключает
 * человека, читает «Участник удалён» — и у восемнадцати участников из
 * девятнадцати исключённый остаётся в списке: пишет, читает и проходит
 * проверку на подмену отправителя. То же с баном, сменой роли, удалением
 * сообщения «у всех» и со сбросом пригласительной ссылки — последняя у
 * неузнавшего администратора продолжает выдавать пропуска в группу.
 *
 * Правка. Успех воронки несёт пару чисел, а не одно; тексты расхождения
 * получили вторую половину — «не у всех, приняли N из M». Для группового
 * сообщения заведён третий вид беды, 'partial', намеренно отдельный от
 * 'undelivered': по недоставке повтор помогает, а по частичной доставке —
 * вредит, задваивая сообщение у тех, кто его уже принял.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { groupControlProblem, inviteTokenSpreadProblem, joinRequestProblem } from '../groupControlOutcome';
import { groupSendProblem, groupSendProblemShort, groupSendProblemText } from '../groupSendOutcome';

// controlFanout тянет службу отправки, а та — `uuid`, приходящий как ESM и не
// проходящий трансформацию jest. Здесь проверяются слова и числа, не отправка.
jest.mock('../messaging', () => ({ getMessagingService: () => null }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const SRC = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Только код: комментарий про повтор не должен сам удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: неохваченный адресат не узнает никогда', () => {
  it('у служебного конверта нет повторной отправки — это сказано в самом модуле', () => {
    // Если бы конверт досылался, «приняли 1 из 19» было бы задержкой, а не
    // расхождением, и говорить о нём человеку было бы нечего.
    const fanout = codeOnly(read('core/social/controlFanout.ts'));
    expect(fanout).not.toContain('setTimeout');
    expect(fanout).not.toMatch(/retry|repeat/i);
  });

  it('число принявших и число адресатов расходятся — воронка считает их порознь', () => {
    const fanout = read('core/social/controlFanout.ts');
    // `accepted` растёт по ответу каждой отправки, `recipients` — это список,
    // составленный ДО них. Совпасть они обязаны не всегда.
    expect(fanout).toContain('accepted += 1;');
    expect(fanout).toContain('return { sent: true, recipients: accepted, of: recipients.length };');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы отвечают по-прежнему', () => {
  it('полная доставка управляющего конверта по-прежнему молчит', () => {
    expect(groupControlProblem({ op: 'kick', sent: true, recipients: 19, of: 19 })).toBeNull();
    expect(groupControlProblem({ op: 'ban', sent: true, recipients: 0, of: 0 })).toBeNull();
  });

  it('полный отказ по-прежнему назван прежними словами', () => {
    expect(groupControlProblem({ op: 'kick', sent: false, reason: 'all_failed' })).toBe(
      'Участник удалён только у вас — в чужих списках он остался (нет связи).'
    );
  });

  it('прежние беды группового сообщения не переехали в новый вид', () => {
    expect(groupSendProblem({ ok: false, reason: 'no_service' })).toEqual({
      kind: 'undelivered', reason: 'no_service',
    });
    expect(groupSendProblem({ ok: true, members: 2, sent: 0, failed: 2 })).toEqual({
      kind: 'undelivered', reason: 'all_failed',
    });
    // Пустая группа: рассылать было некому, и это не беда.
    expect(groupSendProblem({ ok: true, members: 0, sent: 0, failed: 0 })).toBeNull();
    expect(groupSendProblem({ ok: true, members: 5, sent: 5, failed: 0 })).toBeNull();
  });
});

describe('управляющий конверт: принял не каждый', () => {
  it('кик, дошедший до одного из девятнадцати, назван расхождением', () => {
    expect(groupControlProblem({ op: 'kick', sent: true, recipients: 1, of: 19 })).toBe(
      'Участник удалён не у всех — в части чужих списков он остался (приняли 1 из 19).'
    );
  });

  it('числа названы обоими, а не долей', () => {
    // «5%» человеку не с чем сопоставить; «1 из 19» он сверяет со списком
    // участников на соседнем экране.
    const text = groupControlProblem({ op: 'ban', sent: true, recipients: 3, of: 8 }) ?? '';
    expect(text).toContain('приняли 3 из 8');
    expect(text).not.toContain('%');
  });

  it('фраза есть у каждой операции — новый вид конверта не соберётся немым', () => {
    const ops = ['ban', 'unban', 'kick', 'add', 'role', 'del', 'edit', 'pin', 'meta', 'leave', 'join', 'invite', 'joinres'] as const;
    for (const op of ops) {
      const text = groupControlProblem({ op, sent: true, recipients: 1, of: 4 });
      expect(typeof text).toBe('string');
      expect((text ?? '').length).toBeGreaterThan(20);
    }
  });

  it('вызов без знаменателя молчит, а не пугает «из NaN»', () => {
    // Старые вызовы и моки, не знающие про `of`, дают NaN. Ложная тревога с
    // непечатаемым числом хуже молчания: исправить по ней нечего.
    const stale = { op: 'meta', sent: true, recipients: 3 } as unknown as Parameters<typeof groupControlProblem>[0];
    expect(groupControlProblem(stale)).toBeNull();
  });
});

describe('сброс пригласительной ссылки: хватает одного неузнавшего', () => {
  it('частичная рассылка названа, и названа тем, чем она грозит', () => {
    const text = inviteTokenSpreadProblem({ op: 'meta', sent: true, recipients: 1, of: 3 }) ?? '';
    expect(text).toContain('приняли 1 из 3');
    expect(text).toContain('«Пригласительная ссылка»');
  });

  it('полная рассылка молчит', () => {
    expect(inviteTokenSpreadProblem({ op: 'meta', sent: true, recipients: 3, of: 3 })).toBeNull();
  });
});

describe('заявка на вступление: частичной доставки нет намеренно', () => {
  it('принявший один администратор — это принятая заявка', () => {
    // Решение принимает один; звать заявителя переотправлять то, что уже
    // лежит у администратора, — значит плодить дубли заявок.
    expect(joinRequestProblem({ sent: true, recipients: 1, of: 4 })).toBeNull();
  });

  it('но полный отказ по-прежнему назван', () => {
    expect(joinRequestProblem({ sent: false, reason: 'no_peer' })).toBe(
      'Запрос отправить некому: в ссылке нет администратора группы.'
    );
  });
});

describe('групповое сообщение: приняли не все', () => {
  it('один принявший из девятнадцати — беда вида partial', () => {
    expect(groupSendProblem({ ok: true, members: 19, sent: 1, failed: 18 })).toEqual({
      kind: 'partial', sent: 1, members: 19,
    });
  });

  it('текст называет числа и говорит, что повтора не будет', () => {
    const text = groupSendProblemText({ kind: 'partial', sent: 1, members: 19 });
    expect(text).toContain('приняли 1 из 19');
    expect(text).toContain('не увидят');
  });

  it('в тексте нет ни одного согласуемого с числом слова', () => {
    // «1 участник принял» и «2 участника приняли» пришлось бы склонять; здесь
    // фраза верна при любом числе, включая 1, 2 и 11.
    for (const n of [1, 2, 5, 11, 21]) {
      const text = groupSendProblemText({ kind: 'partial', sent: n, members: 40 });
      expect(text).toContain(`приняли ${n} из 40`);
    }
  });

  it('короткая причина годится для перечисления чатов', () => {
    expect(groupSendProblemShort({ kind: 'partial', sent: 2, members: 7 })).toBe('приняли 2 из 7');
  });
});

describe('планировщик не досылает то, что уже частично дошло', () => {
  const src = read('core/social/scheduledMessages.ts');

  it('у частичной доставки своя ветка — до общей, которая повторяет', () => {
    const partial = src.indexOf("if (problem?.kind === 'partial') {");
    const retry = src.indexOf("if (problem && problem.kind !== 'partial') {");
    expect(partial).toBeGreaterThan(0);
    expect(retry).toBeGreaterThan(partial);
  });

  it('общая ветка повтора частичную доставку больше не ловит', () => {
    // Прежнее `if (problem) { … continue; }` дослало бы сообщение всем, включая
    // тех, кто его уже принял.
    expect(src).not.toContain('        if (problem) {\n');
  });

  it('частичная ветка не обрывает проход: своя копия ниже обязана лечь', () => {
    const from = src.indexOf("if (problem?.kind === 'partial') {");
    const to = src.indexOf("if (problem && problem.kind !== 'partial') {", from);
    expect(src.slice(from, to)).not.toContain('continue;');
  });

  it('человеку об этом говорят один раз, а не каждый тик', () => {
    const from = src.indexOf("if (problem?.kind === 'partial') {");
    const to = src.indexOf("if (problem && problem.kind !== 'partial') {", from);
    expect(src.slice(from, to)).toContain("reportScheduledLost('SCHEDULED_PARTIAL'");
  });
});

describe('пересылка: «дошло не всем» — не «не отправлено»', () => {
  const src = read('ui/components/modals/chat/ChatForwardModal.tsx');

  it('у частичной доставки свой перечень', () => {
    expect(src).toContain('const partial: string[] = [];');
    expect(src).toContain('Дошло не всем:');
  });

  it('такой чат засчитан отправленным — иначе человек перешлёт второй раз', () => {
    const from = src.indexOf("if (problem?.kind === 'partial') {");
    expect(from).toBeGreaterThan(0);
    const block = src.slice(from, src.indexOf('} else if (problem)', from));
    expect(block).toContain('sent += 1;');
  });
});
