/**
 * Реакции сообщения, которые ключ этого устройства не открывает (v4.32.600).
 *
 * `reactions` лежит зашифрованным, а читался через `decryptAtRestNullable` —
 * тот при неудаче отдаёт пустую строку. Из неё `parseReactionMap` делает
 * пустую карту, и плашки не рисуются вовсе: сообщение выглядит так, будто на
 * него никто не реагировал. Писать в такой столбец запрещено с v4.32.544
 * (иначе прежние реакции были бы стёрты необратимо), поэтому нажатие на
 * эмодзи получает отказ — и до v4.32.599 этот отказ ещё и назывался
 * «Сообщение не найдено». Теперь он назван правильно, но приходил бы всё
 * равно из ниоткуда: на экране не было ни следа того, что реакции есть.
 *
 * Здесь закреплено общее трёхсостоянийное чтение столбца во всех восьми
 * местах и пометка на обоих экранах.
 */
import fs from 'fs';
import path from 'path';

import { UNREADABLE_REACTIONS_TEXT } from '../../storage/unreadableText';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const MARKERS = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'unreadableText.ts'), 'utf8');
const BAR = () =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'chat-components', 'ReactionBar.tsx'),
    'utf8'
  );
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

describe('пометка', () => {
  it('живёт в общем списке пометок и названа так же, как соседние', () => {
    expect(UNREADABLE_REACTIONS_TEXT).toBe('Реакции не удалось прочитать');
    expect(MARKERS()).toContain('export const UNREADABLE_REACTIONS_TEXT');
  });
});

describe('чтение столбца с реакциями', () => {
  it('читается состоянием во всех местах сразу', () => {
    expect(LOCAL().split('...readReactionsCell(').length - 1).toBe(8);
  });

  it('прежнего чтения через пустую строку не осталось', () => {
    expect(LOCAL()).not.toContain('decryptAtRestNullable(r.reactions');
  });

  it('общее чтение отдаёт и значение, и состояние', () => {
    const body = slice(LOCAL(), 'function readReactionsCell(', '\n}\n');
    expect(body).toContain('readAtRestCell(stored, dek)');
    expect(body).toContain('reactions: cellTextOrNull(cell)');
    expect(body).toContain('reactionsUnreadable: unreadableFromCellState(cell.state)');
  });

  it('обе строки сообщения несут признак', () => {
    const chat = slice(LOCAL(), 'export type ChatMessageRow = {', 'export type ConversationRow = {');
    const group = slice(LOCAL(), 'export type GroupMessageRow = {', 'function readNameCell(');
    expect(chat).toMatch(/^ {2}reactionsUnreadable\?: boolean;$/m);
    expect(group).toMatch(/^ {2}reactionsUnreadable\?: boolean;$/m);
  });

  it('запрет записи в непрочитанный столбец не тронут', () => {
    const body = slice(LOCAL(), 'export async function toggleReaction(', '\n}\n');
    expect(body).toContain("return { ok: false, reason: 'unreadable' };");
    expect(body.indexOf("reason: 'unreadable'")).toBeLessThan(body.indexOf('SET reactions = ?'));
  });
});

describe('плашка в личной переписке', () => {
  it('пустая карта при непрочитанном столбце не значит «плашек нет»', () => {
    const src = BAR();
    expect(src).toContain('if (!entries.length) {');
    expect(src).toContain('if (!unreadable) return null;');
    expect(src).toContain('{UNREADABLE_REACTIONS_TEXT}');
  });

  it('пометка берётся из общего списка, а не пишется строкой', () => {
    const src = BAR();
    expect(src).toMatch(
      /^import \{[^}]*\bUNREADABLE_REACTIONS_TEXT\b[^}]*\} from '\.\.\/\.\.\/\.\.\/core\/storage\/unreadableText';$/m
    );
    expect(src).not.toContain("'Реакции не удалось прочитать'");
  });

  it('экран показывает плашку и когда карта пуста', () => {
    const src = CHAT();
    expect(src).toContain('{item.reactions || item.reactionsUnreadable ? (');
    expect(src).toContain('unreadable={item.reactionsUnreadable}');
  });

  it('признак входит в сравнение при перерисовке строки', () => {
    expect(CHAT()).toContain('prev.item.reactionsUnreadable === next.item.reactionsUnreadable &&');
  });
});

describe('плашка в группе', () => {
  it('ряд реакций рисуется и когда карта пуста', () => {
    expect(GROUPS()).toContain('{reactEntries.length > 0 || item.reactionsUnreadable ? (');
  });

  it('вместо пустоты — пометка', () => {
    const src = GROUPS();
    expect(src).toContain('{UNREADABLE_REACTIONS_TEXT}');
    expect(src).toMatch(
      /^import \{[^}]*\bUNREADABLE_REACTIONS_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m
    );
    expect(src).not.toContain("'Реакции не удалось прочитать'");
  });
});
