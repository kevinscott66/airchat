/**
 * v4.32.441: журнал звонков говорит правду о направлении и исходе.
 *
 * Направление восстанавливалось в момент завершения — по состоянию звонка и
 * по наличию неразобранного предложения. К концу разговора состояние равно
 * 'connected' у обеих сторон, а предложение к тому времени уже стёрто, поэтому
 * КАЖДЫЙ принятый входящий звонок попадал в список как исходящий — со стрелкой
 * «вы позвонили».
 *
 * Исход выводился из того же направления: исходящий, который никто не взял,
 * значился «отклонён» (будто собеседник сбросил), а входящий, который человек
 * отклонил сам, — «пропущен».
 *
 * Время начала бралось как «конец минус длительность»: у несостоявшегося
 * звонка это ровно момент его окончания, а у состоявшегося — момент
 * соединения, без времени дозвона.
 *
 * Тест сторожит форму исправления: факты проставляются там, где звонок
 * появляется, а причина завершения передаётся оттуда, где он завершается.
 */
import fs from 'fs';
import path from 'path';

const SERVICE = path.join(__dirname, '..', 'callService.ts');
const SCREEN = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ProfileScreen.tsx');
const service = fs.readFileSync(SERVICE, 'utf8');
const screen = fs.readFileSync(SCREEN, 'utf8');

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

/**
 * Каждое присваивание строки текущего звонка целиком: от `currentCall = {`
 * до закрывающей его строки. Однострочные тоже.
 */
function callAssignments(src: string): string[] {
  const lines = src.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t.startsWith('currentCall = {')) continue;
    if (t.endsWith('};')) { out.push(t); continue; }
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === '};') { out.push(lines.slice(i, j + 1).join('\n')); break; }
    }
  }
  return out;
}

describe('журнал звонков не выдумывает направление и исход', () => {
  it('направление и время начала живут в самой строке звонка', () => {
    const type = bodyOf(service, 'export type CallInfo = {');
    const code = codeLines(type);
    expect(code.some((l) => l.trim() === "direction: 'outgoing' | 'incoming';")).toBe(true);
    expect(code.some((l) => l.trim() === 'startedAt: number;')).toBe(true);
  });

  it('каждое появление звонка проставляет оба факта', () => {
    const assignments = callAssignments(service);
    expect(assignments.length).toBeGreaterThanOrEqual(4);
    for (const a of assignments) {
      const carried = a.includes('...currentCall');
      if (carried) continue; // перенос из прежней строки — факты уже там
      expect(a).toContain('direction:');
      expect(a).toContain('startedAt:');
    }
  });

  it('приём входящего переносит направление, а не проставляет заново', () => {
    const accept = bodyOf(service, 'export async function acceptCall(');
    const connected = callAssignments(accept).filter((a) => a.includes("state: 'connected'"));
    expect(connected.length).toBe(1);
    expect(connected[0]).toContain('...currentCall');
    expect(connected[0]).not.toContain("direction: 'outgoing'");
  });

  it('запись в журнал ничего не выводит сама', () => {
    const body = bodyOf(service, 'function recordCallEnd(');
    const code = codeLines(body);
    expect(body).toContain('function recordCallEnd(info: CallInfo, endedAt: number, cause: CallEndCause): void {');
    expect(body).not.toContain('wasIncoming');
    expect(code.some((l) => l.trim() === 'direction: info.direction,')).toBe(true);
    expect(code.some((l) => l.trim() === 'startedAt: info.startedAt,')).toBe(true);
    // исход: состоявшийся разговор решает длительность, несостоявшийся — причина
    expect(body).toContain("cause === 'declined' ? 'declined' : 'missed'");
  });

  it('причина завершения обязательна в каждом месте завершения', () => {
    // v4.32.549: у _hangup появился третий параметр — источник завершения.
    // Причина завершения по-прежнему первая и обязательная.
    expect(service).toContain('async function _hangup(\n  cause: CallEndCause,\n  note?: string,');
    // ни одного завершения без указанной причины
    expect((service.match(/_hangup\(\)/g) ?? []).length).toBe(0);
    const calls = service.match(/_hangup\('(declined|unanswered)'/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(7);
    // Отказ собеседника приходит отдельным сигналом — и с v4.32.585 он
    // читается из подписанного конверта, а не из голой строки в поле sdp.
    expect(service).toContain(
      "await _hangup('declined', answerEnvelope.control === 'busy' ? 'Занято' : 'Отклонён', 'remote');"
    );
  });

  it('своя кнопка на звонящем входящем — это отказ, на своём исходящем — нет', () => {
    const body = bodyOf(service, 'export async function hangupCall(');
    const code = codeLines(body);
    const decide = code.findIndex((l) => l.includes("currentCall?.state === 'incoming' ? 'declined' : 'unanswered'"));
    const end = code.findIndex((l) => l.includes('await _hangup(cause);'));
    expect(decide).toBeGreaterThanOrEqual(0);
    // решение принимается до отправки сигнала и до сброса состояния
    expect(end).toBeGreaterThan(decide);
  });

  it('подпись в списке звонков берётся из исхода, а не из длительности', () => {
    expect(screen).toContain("const durationStr = entry.outcome === 'answered'");
    expect(screen).toContain("(isOut ? 'Нет ответа' : 'Пропущен')");
  });

  it('проверки ловят прежний вид кода (не вакуумны)', () => {
    const oldRecord = [
      'function recordCallEnd(info: CallInfo, connectedAt: number | null, endedAt: number, wasIncoming: boolean): void {',
      "  const outcome = connectedAt ? 'answered' : (wasIncoming ? 'missed' : 'declined');",
      '  const entry = {',
      "    direction: wasIncoming ? 'incoming' : 'outgoing',",
      '    startedAt: endedAt - (connectedAt ? endedAt - connectedAt : 0),',
      '  };',
      '}',
    ].join('\n');
    const body = bodyOf(oldRecord, 'function recordCallEnd(');
    expect(body).toContain('wasIncoming');
    expect(codeLines(body).some((l) => l.trim() === 'direction: info.direction,')).toBe(false);

    const oldAccept = "    currentCall = { state: 'connected', peerPubB64: fromPubB64, peerName: fromName, isVideo, connectedAt: Date.now() };";
    const parsed = callAssignments(oldAccept);
    expect(parsed.length).toBe(1);
    expect(parsed[0]).not.toContain('...currentCall');
    expect(parsed[0]).not.toContain('direction:');
  });
});
