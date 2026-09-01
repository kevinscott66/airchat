/**
 * Списки диалогов и групп: непрочитанная подпись перестала выдавать себя за
 * «здесь ничего не писали» (v4.32.580).
 *
 * Дефект. Подпись последней реплики хранится отдельным зашифрованным столбцом
 * и читалась через decryptAtRestNullable, а тот при неудачной расшифровке
 * отдаёт пустую строку. В списке диалогов такая переписка показывалась пустой
 * строкой — а если собеседник был онлайн, вместо подписи вставало «в сети», и
 * потеря окончательно переставала быть заметной. В списке групп на её месте
 * печаталось прямое «Нет сообщений» («Нет постов» для канала). То есть первый
 * же экран приложения при разошедшемся ключе данных утверждал, что переписки
 * нет, — вместо того чтобы сказать, что её не удалось прочитать.
 *
 * Что проверяется. Что оба чтения строки разводят «не открылось» и «пусто», и
 * что оба списка показывают пометку, не перебивая ею свой черновик.
 */
import * as fs from 'fs';
import * as path from 'path';
import { cellTextOrNull } from '../atRestCell';
import { readAtRestCell } from '../localEncryption';
import { unreadableFromCellState, UNREADABLE_MESSAGE_TEXT } from '../unreadableText';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const LOCAL = (): string => read('core/storage/local.ts');
const CHAT_LIST = (): string => read('ui/screens/ChatListScreen.tsx');
const GROUPS = (): string => read('ui/screens/GroupsScreen.tsx');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('состояния столбца с подписью', () => {
  const dek = new Uint8Array(32).fill(7);

  it('пустого столбца нет — это законное «подписи не было»', () => {
    const cell = readAtRestCell(null, dek);
    expect(cellTextOrNull(cell)).toBeNull();
    expect(unreadableFromCellState(cell.state)).toBe(false);
  });

  it('чужой шифртекст не открывается и признаётся непрочитанным', () => {
    const cell = readAtRestCell('enc2:0000000000000000000000000000000000000000', dek);
    expect(cellTextOrNull(cell)).toBeNull();
    expect(unreadableFromCellState(cell.state)).toBe(true);
  });

  it('пометка не подменяет подпись, а идёт рядом', () => {
    const cell = readAtRestCell('enc2:0000000000000000000000000000000000000000', dek);
    expect(cellTextOrNull(cell)).not.toBe(UNREADABLE_MESSAGE_TEXT);
  });
});

describe('форма исходников: чтение', () => {
  it('оба списка диалогов читают подпись ячейкой', () => {
    const src = LOCAL();
    expect((src.match(/const prevCell = readAtRestCell\(r\.last_message_preview, dek\);/g) ?? []).length).toBe(2);
    expect(src).not.toContain('lastMessagePreview: decryptAtRestNullable(r.last_message_preview, dek),');
  });

  it('строка группы читает подпись ячейкой', () => {
    const src = LOCAL();
    expect(src).toContain('const prevCell = readAtRestCell((r.last_message_preview as string | null) ?? null, dek);');
    expect(src).not.toContain('lastMessagePreview: decryptAtRestNullable((r.last_message_preview');
  });

  it('признак едет рядом с подписью во всех трёх местах', () => {
    const src = LOCAL();
    expect((src.match(/lastMessagePreview: cellTextOrNull\(prevCell\),/g) ?? []).length).toBe(3);
    expect((src.match(/lastMessagePreviewUnreadable: unreadableFromCellState\(prevCell\.state\),/g) ?? []).length).toBe(3);
  });

  it('оба типа строк объявляют признак', () => {
    expect((LOCAL().match(/^\s+lastMessagePreviewUnreadable\?: boolean;$/gm) ?? []).length).toBe(2);
  });
});

describe('форма исходников: показ', () => {
  it('список диалогов рисует пометку отдельной веткой', () => {
    const src = CHAT_LIST();
    // v4.32.583: рядом в том же импорте появился UNREADABLE_DRAFT_TEXT, поэтому
    // утверждение держится за имя, а не за всю строку целиком.
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_MESSAGE_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
    expect(src).toContain('const previewUnreadable = !item.draftText && item.lastMessagePreviewUnreadable === true;');
    expect(src).toContain(') : previewUnreadable ? (');
  });

  it('«в сети» больше не подменяет собой непрочитанную подпись', () => {
    // Ветка с presence осталась последней: до неё дело доходит только у
    // переписки, подпись которой прочитана.
    const src = CHAT_LIST();
    expect(src.indexOf(') : previewUnreadable ? (')).toBeLessThan(src.indexOf("presence.bucket === 'online' && !preview ? 'в сети' : preview"));
  });

  it('список групп не пишет «Нет сообщений» поверх непрочитанной подписи', () => {
    const src = GROUPS();
    const body = slice(src, 'const previewUnreadable = !item.draftText', 'const isOutgoingLast');
    expect(body).toContain('item.lastMessagePreviewUnreadable === true;');
    expect(body).toContain('? UNREADABLE_MESSAGE_TEXT');
    expect(body.indexOf('UNREADABLE_MESSAGE_TEXT')).toBeLessThan(body.indexOf("'Нет постов'"));
  });

  it('свой черновик пометку перебивает: он читается отдельным столбцом', () => {
    for (const src of [CHAT_LIST(), GROUPS()]) {
      expect(src).toContain('const previewUnreadable = !item.draftText &&');
    }
  });
});
