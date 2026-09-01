/**
 * Избранные сообщения и строки, которые не открылись ключом данных.
 *
 * listStarredMessages читал оба столбца text через decryptAtRestString, а тот
 * на неудаче отдаёт пустую строку. В списке избранного такая строка выглядела
 * ровно как сообщение без подписи: пустая карточка с датой и автором, без
 * единого намёка на то, что текст цел, но ключ его не открывает. Там же
 * строилась карта имён групп — тоже через decryptAtRestString, — и непрочитанное
 * имя ложилось в карту пустой строкой. Из-за этого запасной вариант
 * `groupNames.get(id) ?? id.slice(0, 8)` не срабатывал никогда: пустая строка
 * не null, и заголовок карточки оставался пустым вместо короткого id группы.
 *
 * Теперь оба текста читаются через readAtRestCell, признак unreadable едет
 * рядом со значением (см. unreadableText), в карту имён попадают только
 * прочитанные непустые имена, а все три места показа — модалка личных чатов,
 * модалка групп и врезка в профиле — печатают курсивом честную пометку.
 */

import fs from 'fs';
import path from 'path';
import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../unreadableText';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const LOCAL = (): string => read('core/storage/local.ts');
const CHAT_MODAL = (): string => read('ui/components/modals/chat/ChatStarredModal.tsx');
const GROUP_MODAL = (): string => read('ui/components/modals/groups/GroupStarredModal.tsx');
const PROFILE = (): string => read('ui/screens/ProfileScreen.tsx');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Та часть строки избранного, от которой зависит показ. */
type StarredLike = { text: string; unreadable?: boolean };

describe('признак непрочитанного у избранной строки', () => {
  it('строка с unreadable: true считается непрочитанной при пустом тексте', () => {
    const row: StarredLike = { text: '', unreadable: true };
    expect(isUnreadableMessage(row)).toBe(true);
  });

  it('пустой текст без признака остаётся обычным пустым текстом', () => {
    const off: StarredLike = { text: '', unreadable: false };
    const none: StarredLike = { text: '' };
    expect(isUnreadableMessage(off)).toBe(false);
    expect(isUnreadableMessage(none)).toBe(false);
  });

  it('отсутствие строки — не повод рисовать пометку', () => {
    expect(isUnreadableMessage(null)).toBe(false);
    expect(isUnreadableMessage(undefined)).toBe(false);
  });

  it('пометка не подменяет текст: она едет рядом, а не вместо', () => {
    const row: StarredLike = { text: '', unreadable: true };
    expect(isUnreadableMessage(row)).toBe(true);
    expect(row.text).toBe('');
    expect(row.text).not.toBe(UNREADABLE_MESSAGE_TEXT);
  });
});

describe('форма исходников: чтение избранного', () => {
  it('listStarredMessages не читает тексты через decryptAtRestString', () => {
    const body = slice(LOCAL(), 'export async function listStarredMessages', '\n}\n');
    expect(body).not.toContain('decryptAtRestString(r.text, dek)');
  });

  it('оба текста избранного читаются ячейкой и несут признак', () => {
    const body = slice(LOCAL(), 'export async function listStarredMessages', '\n}\n');
    expect(body.match(/readAtRestCell\(r\.text, dek\)/g)?.length).toBe(2);
    expect(body.match(/unreadable: unreadableFromCellState\(cell\.state\)/g)?.length).toBe(2);
    expect(body.match(/text: cellTextOrNull\(cell\) \?\? ''/g)?.length).toBe(2);
  });

  it('в карту имён групп попадают только прочитанные непустые имена', () => {
    const body = slice(LOCAL(), 'export async function listStarredMessages', '\n}\n');
    expect(body).not.toContain('decryptAtRestString(g.name, dek)');
    expect(body).toContain('const name = cellTextOrNull(readAtRestCell(g.name, dek));');
    expect(body).toContain('if (name) groupNames.set(g.id, name);');
  });

  it('запасной короткий id группы остался на месте', () => {
    const body = slice(LOCAL(), 'export async function listStarredMessages', '\n}\n');
    expect(body).toContain("groupNames.get(r.group_id) ?? r.group_id.slice(0, 8)");
  });
});

describe('форма исходников: показ избранного', () => {
  it('модалка личных чатов печатает пометку вместо пустого текста', () => {
    const src = CHAT_MODAL();
    expect(src).toContain("import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';");
    expect(src).toContain('const unreadable = isUnreadableMessage(msg);');
    expect(src).toContain('{unreadable ? UNREADABLE_MESSAGE_TEXT : msg.text}');
    expect(src).toContain("rowTextUnreadable: { fontStyle: 'italic' },");
  });

  it('тип StarredMessage несёт признак рядом с текстом', () => {
    const t = slice(CHAT_MODAL(), 'export interface StarredMessage {', '}');
    expect(t).toContain('unreadable?: boolean;');
  });

  it('модалка групп печатает пометку вместо пустого текста', () => {
    const src = GROUP_MODAL();
    expect(src).toContain("import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';");
    expect(src).toContain('const unreadable = isUnreadableMessage(grpMsg);');
    expect(src).toContain('{unreadable ? UNREADABLE_MESSAGE_TEXT : grpMsg.text}');
    expect(src).toContain("rowTextUnreadable: { fontStyle: 'italic' },");
  });

  it('врезка избранного в профиле печатает пометку', () => {
    const src = PROFILE();
    expect(src).toContain("import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../../core/storage/unreadableText';");
    expect(src).toContain('{isUnreadableMessage(entry.message) ? UNREADABLE_MESSAGE_TEXT : entry.message.text}');
  });

  it('ни одно место показа не подставляет пометку в сам текст строки', () => {
    for (const src of [CHAT_MODAL(), GROUP_MODAL(), PROFILE()]) {
      expect(src).not.toContain('text: UNREADABLE_MESSAGE_TEXT');
      expect(src).not.toContain('text = UNREADABLE_MESSAGE_TEXT');
    }
  });
});
