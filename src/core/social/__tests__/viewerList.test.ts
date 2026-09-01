/**
 * Непрочитанный список читался как «никто не смотрел» и «никто не прочитал»
 * (v4.32.590, группы добавлены в v4.32.591).
 *
 * `stories.viewed_by` и `group_messages.seen_by` — зашифрованные JSON-массивы.
 * Читались они двумя состояниями: не открывшийся ключом столбец приходил
 * пустой строкой, `JSON.parse('')` бросал, пустой `catch` глотал, и наверх
 * уходил пустой массив. Своя сторис показывала «0 просмотров», своё сообщение
 * в группе — «Никто ещё не прочитал»; а чужая сторис навсегда оставалась
 * «новой», потому что кружок гаснет записью в тот же столбец, а писать в
 * непрочитанный столбец запрещено с v4.32.544.
 */
import fs from 'fs';
import path from 'path';

import { mayCountViewers, parseViewerList, storyRingUnread, viewerCount } from '../viewerList';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const ROW = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'components', 'StoriesRow.tsx'), 'utf8');
const UI = (...seg: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', ...seg), 'utf8');
const GROUPS = () => UI('screens', 'GroupsScreen.tsx');
const SEEN_MODAL = () => UI('components', 'modals', 'groups', 'GroupSeenByModal.tsx');
const INFO_MODAL = () => UI('components', 'modals', 'groups', 'GroupMessageInfoModal.tsx');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('разбор списка посмотревших', () => {
  it('целый список разбирается', () => {
    const list = parseViewerList('["a","b"]');
    expect(list).toEqual({ viewers: ['a', 'b'], unknown: false });
  });

  it('отсутствующий столбец — это пустой список, а не неизвестный', () => {
    expect(parseViewerList(null)).toEqual({ viewers: [], unknown: false });
    expect(parseViewerList('')).toEqual({ viewers: [], unknown: false });
  });

  it('непрочитанный столбец — неизвестный список, а не пустой', () => {
    expect(parseViewerList('', true)).toEqual({ viewers: [], unknown: true });
    expect(parseViewerList('["a"]', true)).toEqual({ viewers: [], unknown: true });
  });

  it('испорченный JSON тоже даёт неизвестность, а не ноль', () => {
    expect(parseViewerList('{')).toEqual({ viewers: [], unknown: true });
  });

  it('не-массив и не-строки внутри отсеиваются', () => {
    expect(parseViewerList('{"a":1}')).toEqual({ viewers: [], unknown: false });
    expect(parseViewerList('["a",1,null,"b"]').viewers).toEqual(['a', 'b']);
  });
});

describe('число просмотров', () => {
  it('показывается только когда известно', () => {
    expect(mayCountViewers(parseViewerList('["a"]'))).toBe(true);
    expect(mayCountViewers(parseViewerList('["a"]', true))).toBe(false);
    expect(viewerCount(parseViewerList('["a","b"]'))).toBe(2);
    expect(viewerCount(parseViewerList('["a","b"]', true))).toBe(0);
  });

  it('ноль просмотров у прочитанного списка остаётся нулём', () => {
    expect(mayCountViewers(parseViewerList(null))).toBe(true);
    expect(viewerCount(parseViewerList(null))).toBe(0);
  });
});

describe('кружок «новая сторис»', () => {
  it('горит, пока меня нет в списке', () => {
    expect(storyRingUnread(parseViewerList('["b"]'), 'me')).toBe(true);
  });

  it('гаснет, когда я в списке', () => {
    expect(storyRingUnread(parseViewerList('["b","me"]'), 'me')).toBe(false);
  });

  it('не горит, когда список неизвестен: погасить его было бы нечем', () => {
    expect(storyRingUnread(parseViewerList('', true), 'me')).toBe(false);
    expect(storyRingUnread(parseViewerList('{'), 'me')).toBe(false);
  });
});

describe('слой чтения сторис', () => {
  it('список посмотревших читается состоянием, а не строкой', () => {
    const body = slice(LOCAL(), 'export async function listActiveStories(', '\n}');
    expect(body).toMatch(/const viewedCell = readAtRestCell\(r\.viewed_by, dek\)/);
    expect(body).toMatch(/viewedBy: cellTextOrNull\(viewedCell\)/);
    expect(body).toMatch(/viewedUnreadable: unreadableFromCellState\(viewedCell\.state\)/);
    expect(body).not.toMatch(/viewedBy: decryptAtRestNullable/);
  });
});

describe('экран сторис', () => {
  it('разбор больше не выписан руками ни разу', () => {
    const src = ROW();
    expect(src).not.toMatch(/JSON\.parse\(story\.viewedBy\)/);
    expect(src).not.toMatch(/JSON\.parse\(stories\[0\]\.viewedBy\)/);
    expect(src.match(/parseViewerList\(/g)?.length).toBe(2);
  });

  it('кружок и счётчик спрашивают правило, а не длину массива', () => {
    const src = ROW();
    expect(src).toMatch(/const hasUnread = storyRingUnread\(/);
    expect(src).not.toMatch(/const hasUnread = !viewers\.includes/);
    expect(src).toMatch(/mayCountViewers\(viewerList\)/);
  });
});

describe('модуль правила', () => {
  it('остаётся чистым: ни базы, ни ключей, ни отрисовки', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'viewerList.ts'), 'utf8');
    expect(src.match(/^import .*$/gm)).toBeNull();
  });
});

describe('слой чтения групп', () => {
  it('список прочитавших читается состоянием, а не строкой', () => {
    const body = slice(LOCAL(), 'export async function listGroupMessages(', 'export async function listAllGroupMessages(');
    expect(body).toMatch(/const seenCell = readAtRestCell\(r\.seen_by, dek\)/);
    expect(body).toMatch(/const seenList = parseViewerList\(cellTextOrNull\(seenCell\), unreadableFromCellState\(seenCell\.state\)\)/);
    expect(body).toMatch(/seenUnreadable: !seenList\.unknown \? undefined : true/);
    // Прежний разбор руками: пустая строка непрочитанного столбца превращалась
    // в `null`, неотличимый от «никто не прочитал».
    expect(body).not.toMatch(/decryptAtRestNullable\(r\.seen_by, dek\)/);
    expect(body).not.toMatch(/JSON\.parse\(raw\) as string\[\]/);
  });

  it('пустой список остаётся пустым, а не становится неизвестным', () => {
    const body = slice(LOCAL(), 'export async function listGroupMessages(', 'export async function listAllGroupMessages(');
    expect(body).toMatch(/seenBy: seenList\.viewers\.length > 0 \? seenList\.viewers : null/);
  });

  it('строка знает про непрочитанный столбец', () => {
    expect(LOCAL()).toMatch(/^ {2}seenUnreadable\?: boolean;$/m);
  });
});

describe('разбор списка ключей в одном месте', () => {
  it('оба пути записи спрашивают тот же модуль', () => {
    const src = LOCAL();
    const seen = slice(src, 'export async function markGroupMessageSeen(', '\nexport ');
    expect(seen).toMatch(/const current = parseViewerList\(cellTextOrNull\(seenCell\)\)\.viewers/);
    expect(seen).not.toMatch(/JSON\.parse\(storedSeenBy\)/);
    const viewed = slice(src, 'export async function markStoryViewed(', '\n}');
    expect(viewed).toMatch(/const viewers = parseViewerList\(cellTextOrNull\(viewedCell\)\)\.viewers/);
    expect(viewed).not.toMatch(/JSON\.parse\(plain\)/);
  });

  it('копий разбора в хранилище больше не осталось', () => {
    expect(LOCAL().match(/parseViewerList\(/g)?.length).toBe(3);
  });

  it('запись по-прежнему отказывается трогать непрочитанный столбец', () => {
    const src = LOCAL();
    expect(slice(src, 'export async function markGroupMessageSeen(', '\nexport ')).toMatch(/if \(!mayOverwrite\(seenCell\)\)/);
    expect(slice(src, 'export async function markStoryViewed(', '\n}')).toMatch(/if \(!mayOverwrite\(viewedCell\)\)/);
  });
});

describe('квитанции о прочтении в интерфейсе', () => {
  it('вместо выдуманного нуля стоит вопрос', () => {
    const src = GROUPS();
    expect(src).toMatch(/item\.seenUnreadable && \(isMe \|\| group\.type === 'channel'\)/);
    expect(src).toMatch(/name="eye-off-outline"/);
  });

  it('список прочитавших не утверждает, что не прочитал никто', () => {
    const src = SEEN_MODAL();
    expect(src).toMatch(/msg\.seenUnreadable \? \(/);
    expect(src).toMatch(/\{UNREADABLE_VIEWERS_TEXT\}/);
    // Прежняя запись объявляла ноль читателей и при неизвестном списке.
    expect(src).not.toMatch(/^\s*\{\(msg\.seenBy\?\.length \?\? 0\) === 0 \? \($/m);
  });

  it('сведения о сообщении не показывают ноль просмотров вместо незнания', () => {
    const src = INFO_MODAL();
    expect(src).toMatch(/msg\.seenUnreadable \? \(/);
    expect(src).toMatch(/\{UNREADABLE_VIEWERS_TEXT\}/);
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_VIEWERS_TEXT\b[^}]*\} from '\.\.\/\.\.\/\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
  });
});
