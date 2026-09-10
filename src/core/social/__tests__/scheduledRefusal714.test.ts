/**
 * v4.32.714: отложенное личное сообщение, отправку которого отклонили,
 * больше не исчезает молча.
 *
 * `sendMessage` отдаёт `string | null`. Диспетчер расписания ответ выбрасывал
 * и удалял строку всегда, оправдываясь комментарием «either real cid or
 * outbox-enqueued null return» — тем же ложным доводом, который в v4.32.713
 * убрали из служебного конверта. Очереди отправки, куда сообщение могло бы
 * «лечь и уйти позже», не существует: outboxEnqueue из продакшена никто не
 * зовёт.
 *
 * Из шести путей, на которых sendMessage возвращает null, для расписания
 * опасны два: нет общего ключа (NO_SESSION_DM) и негодный peerDid. Оба
 * возвращают null ДО того, как заведены messageId и черновая строка, то есть
 * текста не остаётся нигде — а диспетчер писал scheduled_message_sent и
 * стирал единственную копию. Блокировка и часовой лимит отсечены проверками
 * выше по циклу, «нет маршрута в сеть» оставляет строку со статусом failed.
 *
 * Тест — по исходнику: `scheduledMessages.ts` тянет `uuid`, который приезжает
 * как ESM и jest в этом проекте его не преобразует (та же причина, что в
 * scheduledLostReport709 и scheduledOwnerDelete662).
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const FLUSH = () => read('core', 'social', 'scheduledMessages.ts');
const MESSAGING = () => read('core', 'social', 'messaging.ts');
const LOCAL = () => read('core', 'storage', 'local.ts');

/** Только код: пояснения не должны подменять собой проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

const REFUSED_TEXT =
  'Отложенное сообщение не ушло: отправить его не удалось. Проверьте переписку — если сообщения там нет, наберите его заново.';

describe('отказ отправки отложенного личного сообщения виден человеку', () => {
  it('ответ sendMessage читается, а не выбрасывается', () => {
    const flush = codeOnly(FLUSH());
    expect(flush).toContain('const cid = await svc.sendMessage(msg.contactPubB64, msg.text, mediaUris);');
    expect(flush).toContain('if (!cid) {');
    // Голого вызова с потерянным ответом в файле не осталось ни одного.
    expect(flush.split('\n').filter((l) => /^\s*await svc\.sendMessage\(/.test(l))).toHaveLength(0);
  });

  it('на отказе строка снимается, отчёт уходит человеку, виток прерывается', () => {
    const flush = codeOnly(FLUSH());
    const refuse = flush.indexOf('if (!cid) {');
    const del = flush.indexOf('await deleteScheduledMessage(msg.id, pid);', refuse);
    const warn = flush.indexOf("log.warn('scheduled_message_refused', {", refuse);
    const report = flush.indexOf("reportScheduledLost(", refuse);
    const cont = flush.indexOf('continue;', refuse);
    const sent = flush.indexOf("log.info('scheduled_message_sent', {", refuse);
    expect(refuse).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(refuse);
    expect(warn).toBeGreaterThan(del);
    expect(report).toBeGreaterThan(warn);
    expect(cont).toBeGreaterThan(report);
    // Успешная запись в лог — только после ветки отказа, и до неё отказ не доходит.
    expect(sent).toBeGreaterThan(cont);
    expect(flush).toContain("'SCHEDULED_REFUSED',");
    expect(countOf(flush, REFUSED_TEXT)).toBe(1);
  });

  it('ложный довод об очереди отправки убран из исходника', () => {
    const flush = FLUSH();
    expect(flush).not.toContain('Always delete on success');
    expect(flush).not.toContain('outbox-enqueued null return');
  });

  it('удаление строки расписания везде идёт с владельцем профиля', () => {
    const flush = codeOnly(FLUSH());
    expect(countOf(flush, 'deleteScheduledMessage(msg.id, pid)')).toBe(6);
    expect(flush).not.toContain('deleteScheduledMessage(msg.id)');
  });

  it('отчёт об отказе не тащит в себе текст сообщения и адресата', () => {
    const flush = codeOnly(FLUSH());
    const refuse = flush.indexOf('if (!cid) {');
    const cont = flush.indexOf('continue;', refuse);
    const branch = flush.slice(refuse, cont);
    expect(branch).not.toContain('msg.text');
    expect(branch).toContain('msg.contactPubB64.slice(0, 8)');
  });

  it('проверки, отсекающие остальные отказы, стоят выше отправки', () => {
    const flush = codeOnly(FLUSH());
    const blocked = flush.indexOf('rateLimiter.isBlocked(msg.contactPubB64)');
    const limit = flush.indexOf('rateLimiter.messageLimitReached(msg.contactPubB64)');
    const send = flush.indexOf('const cid = await svc.sendMessage(');
    expect(blocked).toBeGreaterThan(0);
    expect(limit).toBeGreaterThan(blocked);
    expect(send).toBeGreaterThan(limit);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: null у sendMessage — окончательный отказ', () => {
  const SIG = `  async sendMessage(
    contactPubB64: string,
    text: string,
    mediaUris?: string[],
    replyToId?: string,
    replyToPreview?: string
  ): Promise<string | null> {`;

  const body = () => {
    const m = MESSAGING();
    const at = m.indexOf(SIG);
    expect(at).toBeGreaterThan(0);
    return m.slice(at);
  };

  it('нет общего ключа и негодный peerDid возвращают null ДО заведения строки', () => {
    const b = body();
    const noSession = b.indexOf("code: 'NO_SESSION_DM',");
    const noPeer = b.indexOf('if (!peerDid) return null;');
    const idLine = b.indexOf('const messageId = uuidv4();');
    expect(noSession).toBeGreaterThan(0);
    expect(noPeer).toBeGreaterThan(noSession);
    expect(idLine).toBeGreaterThan(noPeer);
  });

  it('отсутствие маршрута, наоборот, оставляет в переписке строку failed', () => {
    const b = body();
    const idLine = b.indexOf('const messageId = uuidv4();');
    const route = b.indexOf("log.info('dm_send_no_online_route', { peerDid, messageId });");
    const failed = b.indexOf("await saveRow({ ...pending, status: 'failed' });", route);
    expect(route).toBeGreaterThan(idLine);
    expect(failed).toBeGreaterThan(route);
  });

  it('часовые лимиты и блокировка — тоже null, а не исключение', () => {
    const b = body();
    expect(b).toContain('if (!rateLimiter.canSendControl(contactPubB64)) {');
    expect(b).toContain('if (!rateLimiter.canSendMessage(contactPubB64)) {');
  });

  it('очереди повторной отправки у сообщения нет: outboxEnqueue никто не зовёт', () => {
    expect(LOCAL()).toContain('export async function outboxEnqueue(');
    expect(codeOnly(MESSAGING())).not.toContain('outboxEnqueue(');
    expect(codeOnly(FLUSH())).not.toContain('outboxEnqueue(');
  });
});
