/**
 * Имя автора, не открывшееся ключом, было пустым местом (v4.32.589).
 *
 * `decryptAtRestNullable` при неудаче отдаёт пустую строку, а не `null`.
 * Поэтому шесть мест ленты, написанных через `?? 'Контакт'`, подстановку не
 * делали ни разу: заголовок закреплённой записи, имя автора комментария и
 * подпись меню становились пустыми. Три исходящих текста — «поделиться»,
 * пересылка в чат, цитата в репосте — начинались с двоеточия. А выгрузка
 * наверх уносила пустое имя новой ревизией и затирала целое имя на здоровых
 * устройствах.
 */
import fs from 'fs';
import path from 'path';

import {
  feedCommentIsHeldFromSync,
  feedCommentIsUnreadable,
  feedPostIsHeldFromSync,
  feedPostIsUnreadable,
} from '../feedPostGuard';
import { UNREADABLE_NAME_TEXT } from '../../storage/unreadableText';
import { mayReuseName, nameIsUnreadable, outwardName, shownName } from '../unreadableName';

const STORAGE = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'feedStorage.ts'), 'utf8');
const SCREEN = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'), 'utf8');
const SYNC = () => fs.readFileSync(path.join(__dirname, '..', '..', 'sync', 'liveAccountSync.ts'), 'utf8');
const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const GROUPS = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
const STATS = () => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'groups', 'GroupStatsModal.tsx'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('имя на экране', () => {
  it('непрочитанное имя не притворяется безымянным автором', () => {
    expect(shownName('', true, 'Контакт')).toBe(UNREADABLE_NAME_TEXT);
    expect(shownName(null, true, 'Контакт')).toBe(UNREADABLE_NAME_TEXT);
  });

  it('пустая строка без пометки — это по-прежнему безымянный автор', () => {
    expect(shownName('', false, 'Контакт')).toBe('Контакт');
    expect(shownName('', undefined, 'Контакт')).toBe('Контакт');
    expect(shownName(null, undefined, 'Контакт')).toBe('Контакт');
  });

  it('целое имя показывается как есть', () => {
    expect(shownName('Аня', undefined, 'Контакт')).toBe('Аня');
    expect(shownName('Аня', false, 'Контакт')).toBe('Аня');
  });

  it('имя из одних невидимых символов остаётся безымянным', () => {
    expect(shownName('​​', undefined, 'Контакт')).toBe('Контакт');
  });
});

describe('имя в исходящем тексте', () => {
  it('пометка наружу не уходит никогда', () => {
    expect(outwardName('', true, 'AirChat')).toBe('AirChat');
    expect(outwardName(null, true, 'Публикация')).toBe('Публикация');
    expect(outwardName('', true, 'AirChat')).not.toBe(UNREADABLE_NAME_TEXT);
  });

  it('целое имя наружу уходит как есть', () => {
    expect(outwardName('Аня', undefined, 'AirChat')).toBe('Аня');
  });

  it('признак пригодности имени отвечает тому же правилу', () => {
    expect(mayReuseName(true)).toBe(false);
    expect(mayReuseName(false)).toBe(true);
    expect(mayReuseName(undefined)).toBe(true);
    expect(nameIsUnreadable({ nameUnreadable: true })).toBe(true);
    expect(nameIsUnreadable({})).toBe(false);
    expect(nameIsUnreadable(null)).toBe(false);
  });
});

describe('придержание при выгрузке шире, чем пометка на показе', () => {
  it('нечитаемое имя не прячет читаемый текст записи', () => {
    expect(feedPostIsUnreadable({ nameUnreadable: true })).toBe(false);
    expect(feedCommentIsUnreadable({ nameUnreadable: true })).toBe(false);
  });

  it('но наверх такая строка не уезжает', () => {
    expect(feedPostIsHeldFromSync({ nameUnreadable: true })).toBe(true);
    expect(feedPostIsHeldFromSync({ repostNameUnreadable: true })).toBe(true);
    expect(feedCommentIsHeldFromSync({ nameUnreadable: true })).toBe(true);
  });

  it('нечитаемое содержимое придерживается по-прежнему', () => {
    expect(feedPostIsHeldFromSync({ textUnreadable: true })).toBe(true);
    expect(feedPostIsHeldFromSync({ mediaUnreadable: true })).toBe(true);
    expect(feedPostIsHeldFromSync({ documentsUnreadable: true })).toBe(true);
    expect(feedCommentIsHeldFromSync({ textUnreadable: true })).toBe(true);
  });

  it('целая строка уезжает', () => {
    expect(feedPostIsHeldFromSync({})).toBe(false);
    expect(feedPostIsHeldFromSync(null)).toBe(false);
    expect(feedCommentIsHeldFromSync({})).toBe(false);
    expect(feedCommentIsHeldFromSync(undefined)).toBe(false);
  });

  it('синхронизация придерживает именно этим правилом', () => {
    const src = SYNC();
    expect(src).toMatch(/feedPostIsHeldFromSync/);
    expect(src).toMatch(/feedCommentIsHeldFromSync/);
    expect(src).not.toMatch(/hold: feedPostIsUnreadable/);
    expect(src).not.toMatch(/hold: feedCommentIsUnreadable/);
  });
});

describe('слой чтения ленты', () => {
  it('имя автора записи читается состоянием, а не строкой', () => {
    const body = slice(STORAGE(), 'function toPost(', '\nexport class FeedStorage');
    expect(body).toMatch(/const nameCell = readAtRestCell\(r\.author_name, dek\)/);
    expect(body).toMatch(/const repostNameCell = readAtRestCell\(r\.repost_author_name/);
    expect(body).toMatch(/nameUnreadable: unreadableFromCellState\(nameCell\.state\)/);
    expect(body).toMatch(/repostNameUnreadable: unreadableFromCellState\(repostNameCell\.state\)/);
    expect(body).not.toMatch(/authorName: decryptAtRestNullable/);
    expect(body).not.toMatch(/repostAuthorName: decryptAtRestNullable/);
  });

  it('имя автора комментария — и на показе, и в выгрузке', () => {
    const src = STORAGE();
    expect(src).not.toMatch(/authorName: decryptAtRestNullable/);
    expect(src.match(/nameUnreadable: unreadableFromCellState\(nameCell\.state\)/g)?.length).toBe(4);
  });

  it('имя просмотревшего тоже', () => {
    const body = slice(STORAGE(), 'async getViewers(', '\n  /**');
    expect(body).toMatch(/const nameCell = readAtRestCell\(r\.viewer_name, dek\)/);
    expect(body).not.toMatch(/viewerName: decryptAtRestNullable/);
  });
});

describe('экран ленты', () => {
  it('ни одно имя автора больше не подставляется через ??', () => {
    const src = SCREEN();
    expect(src).not.toMatch(/authorName \?\?/);
    expect(src).not.toMatch(/authorName \|\| t\(/);
    expect(src).not.toMatch(/repostAuthorName \|\| t\(/);
  });

  it('исходящие тексты берут имя правилом для наружного', () => {
    const src = SCREEN();
    expect(src.match(/outwardName\(/g)?.length).toBe(4);
  });

  it('показ берёт имя правилом с пометкой', () => {
    const src = SCREEN();
    expect(src.match(/shownName\(/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe('модуль правила', () => {
  it('опирается только на такие же чистые модули', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'unreadableName.ts'), 'utf8');
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toHaveLength(2);
    expect(imports.join('\n')).toMatch(/unreadableText/);
    expect(imports.join('\n')).toMatch(/contactLabel/);
    expect(imports.join('\n')).not.toMatch(/react|sqlite|expo/i);
  });
});

describe('самые активные в группе (v4.32.592)', () => {
  it('имя читается состоянием, а не строкой с `?? \'?\'`', () => {
    const body = slice(LOCAL(), 'export async function getGroupStats(', '\nexport ');
    expect(body).toMatch(/const cell = readAtRestCell\(s\.sender_name, statsDek\)/);
    expect(body).toMatch(/name: cellTextOrNull\(cell\)/);
    expect(body).toMatch(/unreadable: unreadableFromCellState\(cell\.state\) === true/);
    // `??` не срабатывал на пустой строке, и строка оставалась без имени вовсе.
    expect(body).not.toMatch(/decryptAtRestNullable\(s\.sender_name, statsDek\)/);
  });

  it('строку всегда есть чем подписать: ключ отправителя выбирается запросом', () => {
    const body = slice(LOCAL(), 'export async function getGroupStats(', '\nexport ');
    expect(body).toMatch(/SELECT sender_pub_b64, MAX\(sender_name\) as sender_name, COUNT\(\*\) as cnt/);
    expect(body).toMatch(/pub: s\.sender_pub_b64/);
  });

  it('тип больше не обещает строку там, где имени может не быть', () => {
    expect(LOCAL()).toMatch(
      /topSenders: Array<\{ name: string \| null; pub: string; unreadable: boolean; count: number \}>;/);
  });

  it('экран статистики подписывает строку правилом, а не голым полем', () => {
    const src = STATS();
    expect(src).toMatch(/shownName\(s\.name, s\.unreadable, shortIdentity\(s\.pub\)\)/);
    expect(src).toMatch(/color: s\.unreadable \? colors\.warning : colors\.text/);
    expect(src).not.toMatch(/\{s\.name\}/);
  });

  it('строки списка различаются ключом, а не порядковым номером', () => {
    expect(STATS()).toMatch(/<View key=\{s\.pub\} style=\{styles\.senderRow\}>/);
  });
});

describe('имя отправителя в группе (v4.32.593)', () => {
  it('все четыре чтения имени идут одним правилом', () => {
    const src = LOCAL();
    expect(src).toMatch(/function readNameCell\(stored: string \| null, dek: Uint8Array\)/);
    expect(src.match(/readNameCell\(r\.sender_name, dek\)/g)?.length).toBe(4);
    expect(src.match(/senderUnreadable: sender\.unreadable,/g)?.length).toBe(4);
  });

  it('правило различает «имени нет» и «имя не прочиталось»', () => {
    const body = slice(LOCAL(), 'function readNameCell(', '\n}');
    expect(body).toMatch(/const cell = readAtRestCell\(stored, dek\)/);
    expect(body).toMatch(/name: nameOrNull\(cellTextOrNull\(cell\)\)/);
    expect(body).toMatch(/unreadable: unreadableFromCellState\(cell\.state\)/);
  });

  it('строка сообщения знает про непрочитанное имя', () => {
    expect(LOCAL()).toMatch(/^ {2}senderUnreadable\?: boolean;$/m);
  });

  it('на экране имя не подменяется знаком вопроса', () => {
    const src = GROUPS();
    expect(src).toMatch(/shownName\(item\.senderName, item\.senderUnreadable, shortIdentity\(item\.senderPubB64\)\)/);
    expect(src).not.toMatch(/\{item\.senderName \?\? '\?'\}/);
    expect(src).toMatch(/item\.senderUnreadable \? colors\.warning : identityInk\(item\.senderPubB64, colors\.surface\)/);
  });

  it('наружу уходит короткий ключ, а не пометка и не «?»', () => {
    const src = GROUPS();
    expect(src).not.toMatch(/senderName \?\? '\?'/);
    expect(src.match(/outwardName\(/g)?.length).toBe(5);
  });
});
