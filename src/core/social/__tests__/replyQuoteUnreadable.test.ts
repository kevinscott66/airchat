/**
 * Цитата в ответе, которую ключ этого устройства не открывает (v4.32.598).
 *
 * `reply_to_preview` лежит зашифрованным, а читался через
 * `decryptAtRestNullable` — тот при неудаче отдаёт пустую строку. Оба экрана
 * рисовали блок цитаты по `replyToId && replyPreview`, и пустая строка через
 * это условие не проходила: рамки не было вовсе. Ответ выглядел отдельной
 * репликой — а разговор из ответов, потерявших свои вопросы, читается
 * наоборот: согласие принимают за возражение.
 *
 * Здесь закреплены оба правила: себе — сказать прямо, наружу — не сказать
 * ничего (то же разделение, что у имени в v4.32.589), и общее трёхсостоянийное
 * чтение столбца во всех восьми местах.
 */
import fs from 'fs';
import path from 'path';

import { outwardQuote, quoteView } from '../replyQuote';
import { UNREADABLE_QUOTE_TEXT } from '../../storage/unreadableText';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const QUOTE = () => fs.readFileSync(path.join(__dirname, '..', 'replyQuote.ts'), 'utf8');
const CHAT = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');
const GROUPS = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');

/** Кусок файла между двумя опорами — чтобы утверждение не ловило соседей. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('что показать в цитате', () => {
  it('свежий текст оригинала важнее слепка', () => {
    expect(quoteView('исправленный вопрос', 'старый слепок', false)).toEqual({
      text: 'исправленный вопрос',
      unreadable: false,
    });
  });

  it('оригинала в окне нет — берут слепок', () => {
    expect(quoteView(null, 'старый слепок', false)).toEqual({ text: 'старый слепок', unreadable: false });
  });

  it('оригинал под рукой — состояние ключа ни при чём', () => {
    expect(quoteView('вопрос', '', true)).toEqual({ text: 'вопрос', unreadable: false });
  });

  it('показывать нечего и слепок не открылся — пометка', () => {
    expect(quoteView(null, '', true)).toEqual({ text: null, unreadable: true });
  });

  it('пустая строка от неудачной расшифровки не выдаётся за цитату', () => {
    expect(quoteView(undefined, '', true).text).toBeNull();
  });

  it('ответа просто нет — и пометки нет', () => {
    expect(quoteView(null, null, false)).toEqual({ text: null, unreadable: false });
  });

  it('пробелы за текст не считаются', () => {
    expect(quoteView('   ', '  \n ', true)).toEqual({ text: null, unreadable: true });
  });
});

describe('что унести в сеть', () => {
  it('непрочитанный слепок наружу не идёт', () => {
    expect(outwardQuote('', true)).toBeUndefined();
  });

  it('пустая рамка у собеседника не появляется', () => {
    expect(outwardQuote('', false)).toBeUndefined();
    expect(outwardQuote(null, false)).toBeUndefined();
  });

  it('обычный слепок уходит как есть', () => {
    expect(outwardQuote('вопрос', false)).toBe('вопрос');
  });

  it('пометка наружу не просачивается', () => {
    expect(outwardQuote(UNREADABLE_QUOTE_TEXT, true)).toBeUndefined();
  });
});

describe('правило живёт отдельно от экранов', () => {
  it('модуль ничего не тянет за собой', () => {
    expect(QUOTE()).not.toMatch(/^import /m);
  });
});

describe('чтение столбца с цитатой', () => {
  it('читается состоянием во всех местах сразу', () => {
    expect(LOCAL().split('...readReplyCell(').length - 1).toBe(8);
  });

  it('прежнего чтения через пустую строку не осталось', () => {
    expect(LOCAL()).not.toContain('decryptAtRestNullable(r.reply_to_preview');
  });

  it('общее чтение отдаёт и значение, и состояние', () => {
    const body = slice(LOCAL(), 'function readReplyCell(', '\n}\n');
    expect(body).toContain('readAtRestCell(stored, dek)');
    expect(body).toContain('replyToPreview: cellTextOrNull(cell)');
    expect(body).toContain('replyToPreviewUnreadable: unreadableFromCellState(cell.state)');
  });

  it('обе строки сообщения несут признак', () => {
    const chat = slice(LOCAL(), 'export type ChatMessageRow = {', 'export type ConversationRow = {');
    const group = slice(LOCAL(), 'export type GroupMessageRow = {', 'function readNameCell(');
    expect(chat).toMatch(/^ {2}replyToPreviewUnreadable\?: boolean;$/m);
    expect(group).toMatch(/^ {2}replyToPreviewUnreadable\?: boolean;$/m);
  });
});

describe('цитата в личной переписке', () => {
  it('решение о цитате принимает общее правило', () => {
    const src = CHAT();
    expect(src).toContain('quoteView(replyOrigin?.text, item.replyToPreview, item.replyToPreviewUnreadable)');
  });

  it('рамка рисуется и когда показывать нечего', () => {
    expect(CHAT()).toContain('{item.replyToId && (replyPreview !== null || replyQuote.unreadable) ? (');
  });

  it('вместо пустой рамки — пометка', () => {
    const src = CHAT();
    expect(src).toContain('{replyPreview === null ? UNREADABLE_QUOTE_TEXT');
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_QUOTE_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
    expect(src).not.toContain("'Цитату не удалось прочитать'");
  });

  it('повторная отправка не уносит пустую цитату собеседнику', () => {
    const src = CHAT();
    expect(src.split('outwardQuote(row.replyToPreview, row.replyToPreviewUnreadable)').length - 1).toBe(2);
    expect(src).not.toContain('row.replyToPreview ?? undefined');
  });
});

describe('цитата в группе', () => {
  it('решение о цитате принимает то же правило', () => {
    expect(GROUPS()).toContain('const replyQuote = quoteView(');
  });

  it('рамка рисуется и когда показывать нечего', () => {
    expect(GROUPS()).toContain('{item.replyToId && (replyPreview !== null || replyQuote.unreadable) ? (');
  });

  it('вместо пустой рамки — пометка', () => {
    const src = GROUPS();
    expect(src).toContain('{replyPreview === null ? UNREADABLE_QUOTE_TEXT');
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_QUOTE_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
    expect(src).not.toContain("'Цитату не удалось прочитать'");
  });
});
