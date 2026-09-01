/**
 * v4.32.544. Пять мест читали зашифрованный столбец, дополняли прочитанное и
 * писали обратно. Чтение шло через `decryptAtRestString`, а он сводит «столбец
 * пуст» и «столбец не открылся нашим ключом» к одной пустой строке. Во втором
 * случае получалось: разбор пустоты — пустая карта, к ней добавляется одно
 * новое значение, запись поверх — и прежний шифртекст уничтожен. Необратимо:
 * прочитать его не удавалось и до записи, а теперь его нет.
 *
 * Проверяется и поведение (три состояния ячейки), и форма исходников — что
 * ни одно из пяти мест не пишет, не спросив состояние. Одного поведенческого
 * теста мало: чистый модуль можно оставить в дереве и перестать им
 * пользоваться, ничего при этом не сломав.
 */
import fs from 'fs';
import path from 'path';
import { encryptAtRestString, readAtRestCell } from '../localEncryption';
import { classifyAtRestCell, mayOverwrite, cellTextOrNull } from '../atRestCell';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

const CELL = read('core/storage/atRestCell.ts');
const ENC = read('core/storage/localEncryption.ts');
const LOCAL = read('core/storage/local.ts');
const FEED = read('core/storage/feedStorage.ts');

/** Тело функции верхнего уровня: от строки-заголовка до `}` в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

/** Тело метода класса: от заголовка до `}` с отступом в два пробела. */
function methodBody(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n  }\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

const TOGGLE = (): string => bodyOf(LOCAL, 'export async function toggleReaction(');
const SEEN = (): string => bodyOf(LOCAL, 'export async function markGroupMessageSeen(');
const STORY = (): string => bodyOf(LOCAL, 'export async function markStoryViewed(');
const ADD_R = (): string => methodBody(FEED, '  async addReaction(');
const RM_R = (): string => methodBody(FEED, '  async removeReaction(');
const UPD_C = (): string => methodBody(FEED, '  async updateCommentReactions(');

describe('classifyAtRestCell', () => {
  it('столбца нет — absent', () => {
    expect(classifyAtRestCell(null, null)).toEqual({ state: 'absent' });
    expect(classifyAtRestCell(undefined, null)).toEqual({ state: 'absent' });
  });

  it('столбец есть и открылся — plain с текстом', () => {
    expect(classifyAtRestCell('enc2:...', '{"👍":["a"]}')).toEqual({
      state: 'plain',
      text: '{"👍":["a"]}',
    });
  });

  it('пустая строка внутри шифртекста — это plain, а не absent', () => {
    expect(classifyAtRestCell('enc2:...', '')).toEqual({ state: 'plain', text: '' });
  });

  it('столбец есть, но не открылся — unreadable', () => {
    expect(classifyAtRestCell('enc2:мусор', null)).toEqual({ state: 'unreadable' });
  });

  it('различает пустой столбец и нечитаемый — в этом весь смысл', () => {
    expect(classifyAtRestCell(null, null)).not.toEqual(classifyAtRestCell('enc2:x', null));
  });
});

describe('mayOverwrite', () => {
  it('поверх пустоты и поверх прочитанного писать можно', () => {
    expect(mayOverwrite({ state: 'absent' })).toBe(true);
    expect(mayOverwrite({ state: 'plain', text: '{}' })).toBe(true);
  });

  it('поверх нечитаемого — нельзя', () => {
    expect(mayOverwrite({ state: 'unreadable' })).toBe(false);
  });
});

describe('cellTextOrNull', () => {
  it('отдаёт текст только у plain', () => {
    expect(cellTextOrNull({ state: 'plain', text: 'x' })).toBe('x');
    expect(cellTextOrNull({ state: 'absent' })).toBeNull();
    expect(cellTextOrNull({ state: 'unreadable' })).toBeNull();
  });
});

describe('readAtRestCell', () => {
  const dek = new Uint8Array(32).fill(3);
  const other = new Uint8Array(32).fill(4);

  it('NULL в столбце — absent', () => {
    expect(readAtRestCell(null, dek)).toEqual({ state: 'absent' });
  });

  it('свой шифртекст — plain с исходным текстом', () => {
    const stored = encryptAtRestString('{"❤️":["did:x"]}', dek);
    expect(readAtRestCell(stored, dek)).toEqual({ state: 'plain', text: '{"❤️":["did:x"]}' });
  });

  it('чужой ключ — unreadable, а не пустая строка', () => {
    const stored = encryptAtRestString('{"❤️":["did:x"]}', dek);
    expect(readAtRestCell(stored, other)).toEqual({ state: 'unreadable' });
  });

  it('битый шифртекст — unreadable', () => {
    expect(readAtRestCell('enc2:не-шифртекст-вовсе', dek)).toEqual({ state: 'unreadable' });
  });

  it('старый незашифрованный столбец читается как есть, а не как поломка', () => {
    expect(readAtRestCell('{"👍":["did:y"]}', dek)).toEqual({
      state: 'plain',
      text: '{"👍":["did:y"]}',
    });
  });

  it('зашифрованная пустая строка — plain, писать поверх разрешено', () => {
    const cell = readAtRestCell(encryptAtRestString('', dek), dek);
    expect(cell).toEqual({ state: 'plain', text: '' });
    expect(mayOverwrite(cell)).toBe(true);
  });
});

describe('модуль остаётся чистым', () => {
  it('в atRestCell.ts нет ни одного import', () => {
    expect(CELL.split('\n').filter((l) => l.startsWith('import '))).toEqual([]);
  });

  it('atRestCell.ts не знает ни про SQLite, ни про ключи', () => {
    expect(CELL).not.toMatch(/SQLite|expo-|dek|DEK/);
  });

  it('readAtRestCell живёт в localEncryption и опирается на tryDecryptAtRest', () => {
    const body = bodyOf(ENC, 'export function readAtRestCell(');
    expect(body).toContain('tryDecryptAtRest(');
    expect(body).toContain('classifyAtRestCell(');
    // Именно не decryptAtRestString: он и есть источник склейки состояний.
    expect(body).not.toContain('decryptAtRestString(');
  });
});

describe('места, которые переписывают столбец, сперва спрашивают состояние', () => {
  it('toggleReaction не пишет реакции поверх нечитаемого столбца', () => {
    const b = TOGGLE();
    expect(b).toContain('readAtRestCell(row.reactions, dek)');
    expect(b).toContain('mayOverwrite(');
    expect(b).not.toContain('decryptAtRestNullable(row.reactions');
    expect(b.indexOf('mayOverwrite(')).toBeLessThan(b.indexOf('SET reactions = ?'));
  });

  it('markGroupMessageSeen не переписывает список прочитавших вслепую', () => {
    const b = SEEN();
    expect(b).toContain('readAtRestCell(row.seen_by, dek)');
    expect(b).toContain('mayOverwrite(');
    expect(b).not.toContain('decryptAtRestNullable(row.seen_by');
    expect(b.indexOf('mayOverwrite(')).toBeLessThan(b.indexOf('seen_by = ?'));
  });

  it('markStoryViewed не переписывает список зрителей вслепую', () => {
    const b = STORY();
    expect(b).toContain('readAtRestCell(row.viewed_by, dek)');
    expect(b).toContain('mayOverwrite(');
    expect(b).not.toContain('decryptAtRestNullable(row.viewed_by');
    expect(b.indexOf('mayOverwrite(')).toBeLessThan(b.indexOf('viewed_by = ?'));
  });

  it('addReaction в ленте не пишет поверх нечитаемого столбца', () => {
    const b = ADD_R();
    expect(b).toContain('readAtRestCell(row.reactions, dek)');
    expect(b).toContain('mayOverwrite(');
    expect(b).not.toContain('decryptAtRestNullable(row.reactions');
    expect(b.indexOf('mayOverwrite(')).toBeLessThan(b.indexOf('SET reactions = ?'));
  });

  it('removeReaction в ленте — тоже, и выход записан явно', () => {
    const b = RM_R();
    expect(b).toContain('readAtRestCell(row.reactions, dek)');
    expect(b).toContain('mayOverwrite(');
    expect(b).not.toContain('decryptAtRestNullable(row.reactions');
  });

  it('отказ не молчит: у каждого места есть запись в журнал', () => {
    for (const b of [TOGGLE(), SEEN(), STORY(), ADD_R(), RM_R()]) {
      expect(b).toMatch(/log\.warn\('[a-z_]*unreadable'/);
    }
  });

  it('updateCommentReactions в ленте не пишет карту поверх нечитаемого столбца', () => {
    const b = UPD_C();
    expect(b).toContain('readAtRestCell(row.reactions, dek)');
    expect(b).toContain('mayOverwrite(');
    expect(b.indexOf('mayOverwrite(')).toBeLessThan(b.indexOf('SET reactions = ?'));
    expect(b).toMatch(/log\.warn\('[a-z_]*unreadable'/);
  });

  it('во всём src каждая запись в эти столбцы прикрыта проверкой', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(path.join(__dirname, '..', '..', '..'));
    const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;
    const writes = /SET (?:reactions|seen_by|viewed_by) = \?/g;
    const short: Array<{ file: string; writes: number; guards: number }> = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const w = count(src, writes);
      if (w === 0) continue;
      const g = count(src, /mayOverwrite\(/g);
      if (g < w) short.push({ file: path.basename(f), writes: w, guards: g });
    }
    expect(short).toEqual([]);
    // Пусть проверка не молчит, если места перенесут в третий файл.
    const total = files.reduce((n, f) => n + count(fs.readFileSync(f, 'utf8'), writes), 0);
    expect(total).toBe(6);
  });
});
