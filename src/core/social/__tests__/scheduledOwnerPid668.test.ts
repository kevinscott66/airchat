/**
 * v4.32.668: расписание не угадывает номер профиля.
 *
 * Во всех четырёх местах `scheduledMessages.ts` стояло
 * `profileManager.getActiveProfile()?.id ?? 1` — «активного профиля нет,
 * считаем, что первый». Дороже всего это обходилось сторожу смены профиля
 * внутри `flushDueOnce`: он сравнивает `?? 1` слева с `?? 1` справа, поэтому у
 * самого обычного человека (единственный профиль, номер 1) выход из учётной
 * записи посреди прохода читался как «профиль тот же». `stopScheduler()` гасит
 * только таймер, начатый проход он не прерывает — и тот продолжал слать
 * письма и стирать строки уже разбираемым сервисом, ровно то, ради чего
 * сторож и заведён (v4.32.188). Планирование при отсутствии профиля клало
 * строку в расписание первого.
 *
 * `scheduledMessages.ts` здесь не импортируется: он тянет `uuid`, а тот
 * приезжает как ESM, который jest в этом проекте не преобразует. Форма его
 * исходника читается с диска — тем же приёмом, что в scheduledOwnerDelete662.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const FLUSH = () => read('core', 'social', 'scheduledMessages.ts');
const PM = () => read('core', 'identity', 'profileManager.ts');

/** Только код: строки-комментарии убраны, чтобы пояснения не подменяли собой проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('расписание не угадывает номер профиля', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: getActiveProfile отдаёт null на старте, выходе и стирании', () => {
    const pm = PM();
    expect(pm).toContain('getActiveProfile(): Profile | null {');
    expect(pm).toContain('if (!this.mnemonicCache || !this.state) {');
    expect(pm).toContain("log.warn('profile_manager_not_ready', {");
    // Сторож смены профиля жив и сравнивает номера — иначе проверять нечего.
    const flush = FLUSH();
    expect(flush).toContain("log.info('scheduled_flush_profile_switched_abort', { pid });");
    // Останов таймера начатый проход не прерывает — потому сторож и стоит в цикле.
    expect(flush).toContain('export function stopScheduler(): void {');
    expect(flush).toContain('clearInterval(pollTimer);');
  });

  it('номер профиля берётся одним правилом, и оно допускает «профиля нет»', () => {
    const flush = FLUSH();
    expect(flush).toContain('function activePid(): number | null {');
    expect(flush).toContain('return profileManager.getActiveProfile()?.id ?? null;');
    // Ни одного молчаливого «значит, первый» в коде не осталось.
    expect(codeOnly(flush)).not.toContain('getActiveProfile()?.id ?? 1');
  });

  it('планирование без активного профиля отказывает, а не пишет первому', () => {
    const flush = FLUSH();
    expect(countOf(flush, "if (pid === null) throw new Error('scheduled_profile_unset');")).toBe(2);
    // Обе записи в расписание идут под тем же pid, что проверен выше. Считать
    // все `ownerProfileId: pid,` в файле нельзя: третье такое поле — это
    // повторная вставка уже отправленного группового письма внутри
    // flushDueOnce, к планированию оно отношения не имеет.
    let from = 0;
    const blocks: string[] = [];
    for (;;) {
      const i = flush.indexOf('await insertScheduledMessage({', from);
      if (i < 0) break;
      const end = flush.indexOf('});', i);
      expect(end).toBeGreaterThan(i);
      blocks.push(flush.slice(i, end));
      from = end;
    }
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b).toContain('ownerProfileId: pid,');
  });

  it('проход без активного профиля ничего не рассылает', () => {
    const flush = FLUSH();
    const head = flush.indexOf('async function flushDueOnce(): Promise<void> {');
    expect(head).toBeGreaterThan(0);
    const body = flush.slice(head, flush.indexOf('\n}\n', head));
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('const pid = activePid();\n  if (pid === null) return;');
    // Отказ стоит ДО выборки строк и до любой отправки.
    const bail = body.indexOf('if (pid === null) return;');
    const due = body.indexOf('const due = await listDueScheduledMessages(pid);');
    expect(due).toBeGreaterThan(bail);
    // Сторож в цикле спрашивает то же правило: «профиля нет» больше не равно pid.
    const guard = body.indexOf('if (activePid() !== pid) {');
    expect(guard).toBeGreaterThan(due);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: правило зовут ровно из четырёх мест', () => {
    const flush = codeOnly(FLUSH());
    // Одно объявление плюс четыре вызова.
    expect(countOf(flush, 'activePid()')).toBe(5);
    expect(countOf(flush, 'const pid = activePid();')).toBe(3);
    expect(countOf(flush, 'if (activePid() !== pid) {')).toBe(1);
  });
});
