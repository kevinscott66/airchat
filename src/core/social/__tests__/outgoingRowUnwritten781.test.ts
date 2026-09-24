/**
 * Своя исходящая строка: «сохранено» больше не говорится наугад (v4.32.781).
 *
 * Дефект. Экран переписки очищает поле ввода, ответ и черновик ДО отправки, а
 * назад возвращает их только на ответе `'refused'` (v4.32.726). На `'stored'`
 * он не возвращает ничего — и правильно делает: там строка уже в переписке, с
 * пометкой «не отправлено» и кнопкой «Повторить», и вернуть текст в поле
 * значило бы написать его дважды.
 *
 * Держалось это обещание на записи, которая его проверить не давала.
 * `upsertChatMessage` гасила свой отказ внутри — занятую базу, неподнявшуюся
 * блокировку, переполненный диск — и отвечала `void`. Отправка звала её через
 * `saveRow`, тоже `void`, и говорила `'stored'` безусловно. Очереди повторной
 * отправки у личных сообщений нет (`outboxEnqueue` в бою никем не зовётся), так
 * что строка беседы — единственный якорь повтора. Не легла — набранного нет
 * нигде: поле пустое, строки нет, повторить нечего.
 *
 * То же и в «Избранном», только острее: заметка себе сети не касается вовсе,
 * строка в базе и есть вся заметка. `saveToSelfChat` возвращал её номер
 * независимо от того, легла ли она, а номер снаружи читается как успех.
 *
 * Правка: различающая форма `upsertChatMessageChecked` (пара к давно
 * существующим `saveChatMessageChecked`, `deleteChatMessageChecked`,
 * `updateChatMessageStatusChecked`, `updateChatMessageTextChecked`), а в
 * отправке — отказ там, где строки не стало.
 *
 * Проверяется исходник: служба переписки в jest не поднимается, а вся суть
 * правки — в том, какая ветка что делает с набранным.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Только код: пояснение не должно подменять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const MESSAGING = codeOnly(readFileSync(join(__dirname, '..', 'messaging.ts'), 'utf8'));
const LOCAL = codeOnly(
  readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8')
);

/** Кусок исходника от одной опоры до другой; обе обязаны найтись. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Тело `sendMessageWork` целиком, до следующего метода службы. */
const work = (): string =>
  between(MESSAGING, '  private async sendMessageWork(', '  private async deliverControlEnvelope(');

/** Тело `saveToSelfChat` до следующего метода. */
const selfChat = (): string =>
  between(MESSAGING, '  private async saveToSelfChat(', '  async sendMessageResult(');

describe('у перезаписи строки появилась различающая форма', () => {
  it('исход назван словом, и «не вышло» среди слов есть', () => {
    expect(LOCAL).toContain("export type ChatUpsertWrite = 'written' | 'failed';");
    expect(LOCAL).toContain(
      'export async function upsertChatMessageChecked(row: ChatMessageRow): Promise<ChatUpsertWrite>'
    );
  });

  it('гасящая форма осталась обёрткой над различающей, а не второй копией', () => {
    const wrapper = between(
      LOCAL,
      'export async function upsertChatMessage(row: ChatMessageRow): Promise<void> {',
      '\n}\n'
    );
    expect(wrapper).toContain('await upsertChatMessageChecked(row);');
    // Второй копии запроса тут нет: разошлись бы при первой же правке SQL.
    expect(wrapper).not.toContain('INSERT INTO chat_messages');
  });

  it('ловушка отвечает отказом, а не глотает его молча', () => {
    const body = between(
      LOCAL,
      'export async function upsertChatMessageChecked(',
      'export async function upsertChatMessage(row: ChatMessageRow)'
    );
    expect(body).toContain("return 'written';");
    expect(body).toContain("return 'failed';");
    expect(body).toContain("log.warn('chat_message_upsert_failed'");
  });
});

describe('отправка собеседнику: без строки не отправляем вовсе', () => {
  it('saveRow отвечает исходом, а не void', () => {
    const w = work();
    expect(w).toContain(
      "const saveRow = async (row: ChatMessageRow): Promise<'written' | 'skipped' | 'failed'> => {"
    );
    // «Писать было не нужно» и «не записалось» — разные слова: служебный
    // конверт и живая геолокация строки тут и не заводят.
    expect(w).toContain("if (control || callerOwnsRow) return 'skipped';");
    expect(w).toContain('return await upsertChatMessageChecked(row);');
  });

  it('незаписанная строка «отправляется» кончает отказом, до всякой сети', () => {
    const w = work();
    const guard = w.indexOf(
      "if ((await measureAsync('dm_db_upsert_pending', () => saveRow(pending))) === 'failed') {"
    );
    expect(guard).toBeGreaterThan(0);
    const refuse = w.indexOf("return { outcome: 'refused', cid: null };", guard);
    expect(refuse).toBeGreaterThan(guard);
    expect(w).toContain("log.warn('dm_pending_row_failed'");
    // Отказ раньше первого выхода в сеть: иначе собеседник прочтёт то, чего у
    // отправителя нет.
    const publish = w.indexOf("measureAsync('dm_ipfs_publish'");
    expect(publish).toBeGreaterThan(refuse);
  });

  it('отказ пометки «не отправлено» назван в журнале, но текст не отбирает', () => {
    const w = work();
    const mark = w.indexOf(
      "if ((await markDelivered({ cid: null, status: 'failed', transport: null })) === 'failed') {"
    );
    expect(mark).toBeGreaterThan(0);
    expect(w).toContain("log.warn('dm_failed_mark_row_failed'");
    // Здесь строка `sending` уже легла выше — текст на месте, и возвращать его
    // в поле ввода значило бы написать дважды. Ответ остаётся прежним.
    const verdict = w.indexOf(
      "return { outcome: control || callerOwnsRow ? 'refused' : 'stored', cid: null };",
      mark
    );
    expect(verdict).toBeGreaterThan(mark);
  });
});

describe('«Избранное»: заметка себе не пропадает молча', () => {
  it('строка пишется различающей формой', () => {
    expect(selfChat()).toContain('const wrote = await upsertChatMessageChecked({');
  });

  it('не легла — номер не возвращается, и снаружи это отказ', () => {
    const b = selfChat();
    const wrote = b.indexOf('const wrote = await upsertChatMessageChecked({');
    const guard = b.indexOf("if (wrote === 'failed') {", wrote);
    expect(guard).toBeGreaterThan(wrote);
    expect(b).toContain("log.warn('self_chat_row_failed'");
    expect(b.indexOf('return null;', guard)).toBeGreaterThan(guard);
    // След в списке бесед ставится только после записи: иначе превью показывало
    // бы заметку, которой в переписке нет.
    expect(b.indexOf('void touchConversation(', guard)).toBeGreaterThan(guard);
  });

  it('пустой ответ отправка называет отказом — экран вернёт набранное', () => {
    expect(MESSAGING).toContain(
      "return { outcome: selfCid ? 'sent' : 'refused', cid: selfCid };"
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('гасящая форма никуда не делась — её зовут там, где показать отказ негде', () => {
    expect(LOCAL).toContain('export async function upsertChatMessage(row: ChatMessageRow)');
    expect(MESSAGING).toContain('  upsertChatMessage,');
  });

  it('удачная отправка по-прежнему успех, а не отказ', () => {
    const w = work();
    expect(w).toContain("return { outcome: 'sent', cid: fallbackRef };");
    expect(w).toContain("return { outcome: 'sent', cid };");
  });

  it('три исхода отправки остались теми же тремя', () => {
    expect(MESSAGING).toContain("export type DmSendOutcome = 'sent' | 'stored' | 'refused';");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('в отправке не осталось гасящей перезаписи', () => {
    const w = work();
    expect(w).not.toContain('await upsertChatMessage(');
    expect(selfChat()).not.toContain('await upsertChatMessage(');
  });

  it('обещание «сохранено» опирается на проверенную запись, а не на веру', () => {
    const w = work();
    // Между записью строки-заготовки и словом `stored` не должно быть ни одного
    // пути, на котором строки нет: оба места, где она пишется, проверены.
    // v4.32.833: исход отправки пишет не saveRow, а markDelivered — но обеих
    // записей по-прежнему четыре, и каждая отвечает исходом.
    expect(w.match(/markDelivered\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(w).not.toContain('await saveRow(pending);');
    expect(w).not.toContain(
      "await markDelivered({ cid: null, status: 'failed', transport: null });"
    );
  });
});
