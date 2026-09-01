/**
 * Список вложений сообщения, который ключ этого устройства не открывает
 * (v4.32.597).
 *
 * `media_cids` лежит зашифрованным, а читался через `decryptAtRestNullable` —
 * тот при неудаче отдаёт пустую строку, а не `null`. Дальше везде стоит
 * `if (item.mediaCids)`, и пустая строка через него не проходит: сетка снимков
 * просто не рисуется. Сообщение выглядит написанным без вложений — притом что
 * вложения есть, лежат рядом и правильным ключом ещё откроются.
 *
 * У сообщения без текста от этого не остаётся ничего: пустой пузырь. Ровно
 * тот же вид, что у сообщения с непрочитанным текстом до v4.32.559, — только
 * там пометка уже есть, а здесь её не было.
 *
 * Столбец читался одинаково в восьми местах: лента чата, лента группы, четыре
 * поиска и «Избранное» дважды. Здесь закреплено, что чтение стало общим и
 * трёхсостоянийным, а оба экрана показывают пометку.
 */
import fs from 'fs';
import path from 'path';

import { UNREADABLE_MEDIA_TEXT } from '../../storage/unreadableText';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const MARKERS = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'unreadableText.ts'), 'utf8');
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
    expect(UNREADABLE_MEDIA_TEXT).toBe('Вложение не удалось прочитать');
    expect(MARKERS()).toContain('export const UNREADABLE_MEDIA_TEXT');
  });
});

describe('чтение столбца с вложениями', () => {
  it('читается состоянием во всех местах сразу', () => {
    const src = LOCAL();
    expect(src.split('...readMediaCell(r.media_cids, dek)').length - 1).toBe(8);
  });

  it('прежнего чтения через пустую строку не осталось', () => {
    expect(LOCAL()).not.toContain('decryptAtRestNullable(r.media_cids');
  });

  it('общее чтение отдаёт и значение, и состояние', () => {
    const body = slice(LOCAL(), 'function readMediaCell(', '\n}\n');
    expect(body).toContain('readAtRestCell(stored, dek)');
    expect(body).toContain('mediaCids: cellTextOrNull(cell)');
    expect(body).toContain('mediaUnreadable: unreadableFromCellState(cell.state)');
  });

  it('обе строки сообщения несут признак', () => {
    const chat = slice(LOCAL(), 'export type ChatMessageRow = {', 'export type ConversationRow = {');
    const group = slice(LOCAL(), 'export type GroupMessageRow = {', 'function readNameCell(');
    expect(chat).toMatch(/^ {2}mediaUnreadable\?: boolean;$/m);
    expect(group).toMatch(/^ {2}mediaUnreadable\?: boolean;$/m);
  });
});

describe('пузырь в личной переписке', () => {
  it('непрочитанные вложения подписаны, а не пропущены', () => {
    const src = CHAT();
    expect(src).toContain('{item.mediaUnreadable ? (');
    expect(src).toContain('{UNREADABLE_MEDIA_TEXT}');
  });

  it('ветка стоит ПЕРЕД обычной отрисовкой вложений', () => {
    const src = CHAT();
    expect(src.indexOf('{item.mediaUnreadable ? (')).toBeLessThan(src.indexOf('<MediaStrip'));
  });

  it('пометка берётся из общего списка, а не пишется строкой', () => {
    const src = CHAT();
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_MEDIA_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
    expect(src).not.toContain("'Вложение не удалось прочитать'");
  });
});

describe('пузырь в группе', () => {
  it('непрочитанные вложения подписаны, а не пропущены', () => {
    const src = GROUPS();
    expect(src).toContain('{item.mediaUnreadable ? (');
    expect(src).toContain('{UNREADABLE_MEDIA_TEXT}');
  });

  it('ветка стоит ПЕРЕД сеткой снимков', () => {
    const src = GROUPS();
    expect(src.indexOf('{item.mediaUnreadable ? (')).toBeLessThan(src.indexOf('<GroupPhotoGrid'));
  });

  it('пометка берётся из общего списка, а не пишется строкой', () => {
    const src = GROUPS();
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_MEDIA_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
    expect(src).not.toContain("'Вложение не удалось прочитать'");
  });
});
