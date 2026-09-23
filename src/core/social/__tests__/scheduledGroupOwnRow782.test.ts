/**
 * Отложенное в группу: своя копия больше не теряется молча (v4.32.782).
 *
 * Дефект. Проход по расписанию сперва рассылает сообщение всей группе, потом
 * пишет СВОЮ копию — ту самую, ради которой строка своей копии и заведена в
 * v4.32.269, — и только затем снимает строку расписания. Снимает под
 * комментарием «только после подтверждённой отправки: … у группового —
 * записанная строка беседы».
 *
 * Подтверждения не было. `insertGroupMessage` отвечает `boolean`, и ответ
 * выбрасывался; `touchGroupConversation` глотает свой отказ внутри себя и
 * отвечает `void`. Занятой на долю секунды базы хватало, чтобы получилось
 * ровно то, что чинили в v4.32.269: группа сообщение получила и уже отвечает,
 * у автора его нет ни в истории группы, ни в превью списка, а строка
 * расписания снята — текста не осталось нигде.
 *
 * Правка. Своя копия пишется `insertGroupMessageWithTouch` — одной транзакцией
 * со своим следом (иначе была бы середина: строка есть, превью позавчерашнее)
 * и с исходом `GroupMessageWrite`. Не легла — строка расписания остаётся, и
 * следующий тик повторяет проход целиком; повтор рассылки безвреден, потому
 * что `msgId` тот же и приёмник отвечает `'duplicate'`. Дольше ABANDON_AFTER_MS
 * держать нельзя — снимаем, но словами, которые не врут: сообщение группа
 * получила, набирать заново не нужно.
 *
 * Проверяется исходник: `scheduledMessages.ts` тянет `uuid`, а тот приезжает
 * ESM, который jest в этом проекте не преобразует, — тем же приёмом, что в
 * `scheduledLostReport709` и `scheduledOwnerDelete662`.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснение не должно подменять собой проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const FLUSH = codeOnly(read('core', 'social', 'scheduledMessages.ts'));
const LOCAL = codeOnly(read('core', 'storage', 'local.ts'));

/** Кусок исходника от одной опоры до другой; обе обязаны найтись. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Ветвь групповой отправки: от записи своей копии до личной ветки. */
const ownCopy = (): string =>
  between(
    FLUSH,
    'const own = await insertGroupMessageWithTouch(',
    "log.info('scheduled_group_message_sent'"
  );

describe('своя копия пишется с исходом, а не наугад', () => {
  it('гасящая запись из прохода ушла вместе со своим отдельным следом', () => {
    expect(FLUSH).not.toContain('await insertGroupMessage({');
    expect(FLUSH).not.toContain('await touchGroupConversation(');
    // И из списка ввозимых тоже: иначе следующая правка позовёт её по привычке.
    const imports = between(FLUSH, "} from '../storage/local';", "from './groupMessaging'");
    expect(FLUSH.slice(0, FLUSH.indexOf("} from '../storage/local';"))).not.toContain(
      '  insertGroupMessage,'
    );
    expect(imports).not.toContain('touchGroupConversation');
  });

  it('запись и след — одной транзакцией, ответ читается', () => {
    expect(FLUSH).toContain('const own = await insertGroupMessageWithTouch(');
    expect(FLUSH).toContain("if (own === 'failed') {");
  });

  it('своё сообщение не поднимает себе ни непрочитанное, ни упоминание', () => {
    const block = ownCopy();
    expect(block).toContain('incrementUnread: false,');
    expect(block).toContain('incrementMention: false,');
    expect(block).toContain('preview: msg.text.slice(0, 120),');
  });
});

describe('не легла — строка расписания остаётся, и текст с ней', () => {
  it('до срока строка не снимается, а отказ назван в журнале', () => {
    const block = ownCopy();
    const held = block.indexOf("log.warn('scheduled_group_own_row_failed', {");
    expect(held).toBeGreaterThan(0);
    // Всё, что снимает строку, лежит в ветке «слишком долго» — выше этого места.
    const after = block.slice(held);
    expect(after).not.toContain('deleteScheduledMessage(');
  });

  it('дольше ABANDON_AFTER_MS не держим: снимаем и говорим вслух', () => {
    const block = ownCopy();
    const stale = block.indexOf('const staleMs = Date.now() - msg.sendAt;');
    const gate = block.indexOf('if (staleMs > ABANDON_AFTER_MS) {', stale);
    const del = block.indexOf('await deleteScheduledMessage(msg.id, pid);', gate);
    const rep = block.indexOf('reportScheduledLost(', del);
    expect(stale).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(stale);
    expect(del).toBeGreaterThan(gate);
    // Отчёт после удаления, а не вместо него — правило v4.32.709.
    expect(rep).toBeGreaterThan(del);
    expect(block).toContain("log.warn('scheduled_group_own_row_abandoned', {");
  });

  it('слова отчёта не врут: заново набирать не предлагается', () => {
    const block = ownCopy();
    expect(block).toContain("'SCHEDULED_SENT_NOT_SAVED',");
    expect(block).toContain(
      'Отложенное сообщение ушло в группу, но в вашей переписке не сохранилось. Откройте группу — оно там есть.'
    );
    // Текст «наберите его заново» здесь был бы неправдой: группа его получила.
    expect(block).not.toContain('Наберите его заново');
  });

  it('отказ записи не доходит до отметки «отправлено»', () => {
    const block = ownCopy();
    expect(block).toContain('continue;');
    const sent = FLUSH.indexOf("log.info('scheduled_group_message_sent'");
    const fail = FLUSH.indexOf("if (own === 'failed') {");
    expect(sent).toBeGreaterThan(fail);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удачная запись ведёт себя как прежде', () => {
  it('повтор конверта («уже лежит») отказом не считается', () => {
    // `'duplicate'` — это строка, записанная прошлым тиком, чьё удаление не
    // прошло. Она есть, и снимать расписание нужно: сторожем стоит только
    // `'failed'`.
    expect(FLUSH).toContain("if (own === 'failed') {");
    expect(FLUSH).not.toContain("if (own !== 'inserted') {");
  });

  it('после удачной записи строка расписания снимается как и раньше', () => {
    const sent = FLUSH.indexOf("log.info('scheduled_group_message_sent'");
    const del = FLUSH.indexOf('await deleteScheduledMessage(msg.id, pid);', sent);
    expect(sent).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(sent);
  });

  it('прежние исходы групповой отправки не тронуты', () => {
    expect(FLUSH).toContain("log.warn('scheduled_group_message_denied', {");
    expect(FLUSH).toContain("log.warn('scheduled_group_message_abandoned', {");
    expect(FLUSH).toContain("log.info('scheduled_group_message_retry', {");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('неделимая запись со следом существует и отвечает тремя исходами', () => {
    expect(LOCAL).toContain("export type GroupMessageWrite = 'inserted' | 'duplicate' | 'failed';");
    expect(LOCAL).toContain(
      'export async function insertGroupMessageWithTouch(msg: GroupMessageRow, touch: GroupTouch): Promise<GroupMessageWrite>'
    );
  });

  it('след кладётся только на настоящей записи, и обе половины откатываются вместе', () => {
    const body = between(
      LOCAL,
      'export async function insertGroupMessageWithTouch(',
      '\nexport async function'
    );
    expect(body).toContain('if (inserted) await runGroupTouch(d, touch, enc);');
    expect(body).toContain('await txn.rollback();');
    expect(body).toContain("return 'failed';");
  });

  it('гасящая форма никуда не делась — её зовут экраны, где отказ виден сразу', () => {
    expect(LOCAL).toContain('export async function insertGroupMessage(msg: GroupMessageRow): Promise<boolean>');
  });
});
