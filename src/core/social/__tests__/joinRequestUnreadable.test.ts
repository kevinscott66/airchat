/**
 * Заявка на вступление показывалась владельцу неполной и молча (v4.32.594).
 *
 * Заявку принимают или отклоняют, глядя ровно на две вещи: как человек себя
 * назвал и что написал. Обе читались двумя состояниями. Имя проходило через
 * `nameOrNull(decryptAtRestNullable(...))`, и не открывшийся ключом столбец
 * приходил тем же `null`, что и «имени нет», — на экране вместо имени тихо
 * вставал короткий ключ. Сопроводительное сообщение приходило пустой строкой,
 * а рисовалось оно через `item.message ? … : null` — то есть не рисовалось
 * вовсе, неотличимо от заявки без текста.
 *
 * Решение о доступе в группу принималось по неполной картинке, и владельцу об
 * этом не сообщали. Пометка о непрочитанном столбце нужна здесь не для
 * красоты: она единственное, что отличает «человек ничего не написал» от
 * «человек написал, а мы не смогли прочесть».
 */
import fs from 'fs';
import path from 'path';

import { shownName } from '../unreadableName';
import { UNREADABLE_MESSAGE_TEXT, UNREADABLE_NAME_TEXT } from '../../storage/unreadableText';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const MODAL = () => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'groups', 'GroupJoinRequestsModal.tsx'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('чтение заявки', () => {
  it('имя и сообщение читаются состоянием, а не строкой', () => {
    const body = slice(LOCAL(), 'export async function listGroupJoinRequests(', '\nexport ');
    expect(body).toMatch(/const requester = readNameCell\(r\.requester_name, dek\)/);
    expect(body).toMatch(/const messageCell = readAtRestCell\(r\.message, dek\)/);
    expect(body).toMatch(/requesterNameUnreadable: requester\.unreadable/);
    expect(body).toMatch(/messageUnreadable: unreadableFromCellState\(messageCell\.state\)/);
  });

  it('прежнего двухсостоянийного чтения не осталось', () => {
    const body = slice(LOCAL(), 'export async function listGroupJoinRequests(', '\nexport ');
    expect(body).not.toMatch(/nameOrNull\(decryptAtRestNullable\(r\.requester_name, dek\)\)/);
    expect(body).not.toMatch(/message: decryptAtRestNullable\(r\.message, dek\)/);
  });

  it('тип заявки признаёт оба непрочитанных столбца', () => {
    const src = LOCAL();
    expect(src).toMatch(/^ {2}requesterNameUnreadable\?: boolean;$/m);
    expect(src).toMatch(/^ {2}messageUnreadable\?: boolean;$/m);
  });
});

describe('заявка на экране', () => {
  it('имя не подменяется коротким ключом молча', () => {
    const src = MODAL();
    expect(src).toMatch(/shownName\(item\.requesterName, item\.requesterNameUnreadable, shortIdentity\(item\.requesterPubB64\)\)/);
    expect(src).not.toMatch(/\{item\.requesterName \?\? shortIdentity\(item\.requesterPubB64\)\}/);
    expect(src).toMatch(/color: item\.requesterNameUnreadable \? colors\.warning : colors\.text/);
  });

  it('непрочитанное сообщение видно, а не пропущено', () => {
    const src = MODAL();
    expect(src).toMatch(/item\.messageUnreadable \? \(/);
    expect(src).toMatch(/\{UNREADABLE_MESSAGE_TEXT\}/);
  });

  it('пометки берутся из общего списка, а не пишутся тут же строкой', () => {
    const src = MODAL();
    expect(src).toMatch(
      /^import \{[^}]*\bUNREADABLE_MESSAGE_TEXT\b[^}]*\} from '\.\.\/\.\.\/\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
    expect(src).not.toMatch(/'Сообщение не удалось прочитать'/);
  });
});

describe('правило показа имени', () => {
  it('различает «имени нет» и «имя не прочиталось»', () => {
    expect(shownName(null, false, 'AAAA…1234')).toBe('AAAA…1234');
    expect(shownName(null, true, 'AAAA…1234')).toBe(UNREADABLE_NAME_TEXT);
  });

  it('пометки имени и сообщения — разные тексты', () => {
    expect(UNREADABLE_NAME_TEXT).not.toBe(UNREADABLE_MESSAGE_TEXT);
  });
});
