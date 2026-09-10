/**
 * v4.32.709: снятое недоставленным отложенное сообщение больше не исчезает молча.
 *
 * `flushDueOnce` в трёх местах удаляет строку расписания, ничего не отправив:
 * права в группе отозвали, пока сообщение ждало своего часа; рассылка группе
 * не удалась дольше ABANDON_AFTER_MS; личная отправка бросала исключение
 * дольше того же срока. Во всех трёх вместе со строкой пропадает сам текст —
 * своей копии у отложенного сообщения нет нигде. Личную пишет sendMessage
 * (upsertChatMessage), но до записи дело не доходит: sendMessageWork
 * начинается с requireOnlineWrite, а тот при CACHE_ONLY_MODE бросает раньше
 * всего. Групповую пишет сам этот проход (insertGroupMessage), но только
 * после удачной рассылки.
 *
 * До сих пор об этом говорилось одной строкой в лог. Для человека сообщение
 * пропадало из «Запланированных» ровно так же, как если бы ушло.
 *
 * `scheduledMessages.ts` здесь не импортируется: он тянет `uuid`, а тот
 * приезжает как ESM, который jest в этом проекте не преобразует. Форма его
 * исходника читается с диска — тем же приёмом, что в scheduledOwnerDelete662.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const FLUSH = () => read('core', 'social', 'scheduledMessages.ts');
const HANDLER = () => read('core', 'errorHandler.ts');
const MESSAGING = () => read('core', 'social', 'messaging.ts');
const POLICY = () => read('core', 'sync', 'cachePolicy.ts');

/** Только код: пояснения не должны подменять собой проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

const LOST_TEXT =
  'Отложенное сообщение не отправлено: связи не было слишком долго. Наберите его заново.';
const DENIED_TEXT =
  'Отложенное сообщение в группу не отправлено: писать в ней больше нельзя.';

describe('потерянное отложенное сообщение названо вслух', () => {
  it('единственный вызов ErrorHandler собран в одном месте и показывается человеку', () => {
    const flush = codeOnly(FLUSH());
    expect(flush).toContain("import { ErrorHandler, ErrorSeverity } from '../errorHandler';");
    expect(flush).toContain('function reportScheduledLost(code: string, message: string): void {');
    expect(countOf(flush, 'ErrorHandler.getInstance().handle({')).toBe(1);
    expect(flush).toContain('severity: ErrorSeverity.ERROR,');
    expect(flush).toContain('retryable: false,');
  });

  it('все три снятия недоставленной строки зовут отчёт', () => {
    const flush = codeOnly(FLUSH());
    expect(flush.match(/\breportScheduledLost\(/g)?.length).toBe(4); // объявление + три вызова
    expect(flush).toContain("'SCHEDULED_DENIED',");
    expect(countOf(flush, "'SCHEDULED_NOT_SENT',")).toBe(2);
    expect(countOf(flush, LOST_TEXT)).toBe(2);
    expect(countOf(flush, DENIED_TEXT)).toBe(1);
  });

  it('отчёт стоит после самого удаления, а не вместо него', () => {
    const flush = FLUSH();
    const denyDel = flush.indexOf("log.warn('scheduled_group_message_denied'");
    const denyRep = flush.indexOf("'SCHEDULED_DENIED',");
    expect(denyDel).toBeGreaterThan(0);
    expect(denyRep).toBeGreaterThan(denyDel);

    const grpDel = flush.indexOf("log.warn('scheduled_group_message_abandoned'");
    const grpRep = flush.indexOf('reportScheduledLost(', grpDel);
    expect(grpDel).toBeGreaterThan(0);
    expect(grpRep).toBeGreaterThan(grpDel);

    const dmDel = flush.indexOf("log.warn('scheduled_message_abandoned'");
    const dmRep = flush.indexOf('reportScheduledLost(', dmDel);
    const dmCatchEnd = flush.indexOf('} catch { /* ignore */ }', dmDel);
    expect(dmDel).toBeGreaterThan(0);
    expect(dmRep).toBeGreaterThan(dmDel);
    // Внутри try: не прошло само удаление — строка жива, и рапортовать не о чем.
    expect(dmRep).toBeLessThan(dmCatchEnd);
  });

  it('в отчёт не попадают ни текст сообщения, ни ключ собеседника, ни номер группы', () => {
    const flush = codeOnly(FLUSH());
    const start = flush.indexOf('function reportScheduledLost');
    const body = flush.slice(start, flush.indexOf('\n}', start));
    expect(body).not.toContain('msg.text');
    expect(body).not.toContain('contactPubB64');
    expect(body).not.toContain('groupId');
    expect(body).not.toContain('context:');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('число удалений строки расписания не изменилось', () => {
    const flush = FLUSH();
    expect(countOf(flush, 'deleteScheduledMessage(msg.id, pid)')).toBe(5);
    expect(codeOnly(flush)).not.toContain('deleteScheduledMessage(msg.id)');
  });

  it('срок отказа и обе ветки удержания на месте', () => {
    const flush = codeOnly(FLUSH());
    expect(flush).toContain('const ABANDON_AFTER_MS = 15 * 60_000;');
    expect(flush).toContain("log.info('scheduled_group_message_retry', {");
    expect(flush).toContain("log.info('scheduled_message_deferred_rate_limit', { id: msg.id.slice(0, 8) });");
    expect(flush).toContain("log.info('scheduled_message_blocked_drop', { id: msg.id.slice(0, 8) });");
  });

  it('удачная отправка по-прежнему пишет свою копию и не рапортует о потере', () => {
    const flush = FLUSH();
    const sent = flush.indexOf("log.info('scheduled_group_message_sent'");
    const insert = flush.indexOf('await insertGroupMessage({');
    expect(insert).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(insert);
    expect(flush).toContain("log.info('scheduled_message_sent', {");
    // Между записью своей копии и отметкой об отправке отчёта о потере нет.
    expect(flush.slice(insert, sent)).not.toContain('reportScheduledLost(');
  });

  it('сторож смены профиля и удержание непрочитанной строки не тронуты', () => {
    const flush = codeOnly(FLUSH());
    expect(flush).toContain("log.info('scheduled_flush_profile_switched_abort', { pid });");
    expect(flush).toContain("const verdict = decideScheduledSend(msg);");
    expect(flush).toContain("if (verdict.kind === 'hold') {");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ErrorHandler показывает окно только на ERROR и FATAL и гасит повтор по коду', () => {
    const h = HANDLER();
    expect(h).toContain(
      'if (error.severity === ErrorSeverity.ERROR || error.severity === ErrorSeverity.FATAL) {'
    );
    expect(h).toContain('await this.showUserAlert(error);');
    expect(h).toContain('private shouldCoalesceAlert(code: string, now: number): boolean {');
  });

  it('личная копия пишется позже, чем бросает запрет на запись без сети', () => {
    const m = MESSAGING();
    const gate = m.indexOf('await requireOnlineWrite(await localPathTo(contactPubB64));');
    const save = m.indexOf('await measureAsync(\'dm_db_upsert_pending\', () => saveRow(pending));');
    expect(gate).toBeGreaterThan(0);
    expect(save).toBeGreaterThan(gate);
    expect(POLICY()).toContain('export const CACHE_ONLY_MODE = true;');
    expect(POLICY()).toContain('throw new Error(NO_WRITE_PATH_TEXT);');
  });

  it('соседний немой отказ уже был назван вслух — образец v4.32.336', () => {
    const m = MESSAGING();
    expect(m).toContain("code: 'NO_SESSION_DM',");
    expect(m).toContain('severity: ErrorSeverity.ERROR,');
  });
});
