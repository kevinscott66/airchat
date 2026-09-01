/**
 * Реплика в списке групп молча теряла автора (v4.32.602).
 *
 * `last_message_sender_name` читался в rowToGroup двумя состояниями:
 * `decryptAtRestNullable` отдаёт на неудаче пустую строку, а строка списка
 * спрашивала `item.lastMessagePreview && senderLabel` — пустая строка ложна, и
 * приставка «Имя: » просто не рисовалась. Отсутствие подписи там законно (у
 * канала, у служебной строки), поэтому неправда получалась незаметной: реплика
 * соседа по группе выглядела как реплика без автора, и ничто не сообщало, что
 * автор есть, а ключ этого устройства его не открывает.
 *
 * Здесь и поведение нового правила, и форма кода: у подписи три исхода, а не
 * два, третье состояние доезжает из строки БД до экрана, и экран не подставляет
 * безымянному автору запасное имя.
 */
import fs from 'fs';
import path from 'path';

import { UNREADABLE_NAME_TEXT } from '../../storage/unreadableText';
import { shownName, shownNameOrNull } from '../unreadableName';

const readNameModule = () =>
  fs.readFileSync(path.join(__dirname, '..', 'unreadableName.ts'), 'utf8');
const readLocal = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const readGroupsScreen = () =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
    'utf8'
  );

/** Кусок файла между двумя якорями: утверждение о теле одной функции. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('у подписи автора три исхода, а не два', () => {
  it('непрочитанная подпись называется, а не исчезает', () => {
    expect(shownNameOrNull('', true)).toBe(UNREADABLE_NAME_TEXT);
  });

  it('непрочитанная подпись перевешивает даже сохранившееся имя', () => {
    expect(shownNameOrNull('Аня', true)).toBe(UNREADABLE_NAME_TEXT);
  });

  it('подписи нет — так и остаётся, без выдуманного «Контакта»', () => {
    expect(shownNameOrNull(null, false)).toBeNull();
    expect(shownNameOrNull(undefined, undefined)).toBeNull();
    expect(shownNameOrNull('', false)).toBeNull();
    expect(shownNameOrNull('   ', false)).toBeNull();
  });

  it('читаемая подпись возвращается как есть', () => {
    expect(shownNameOrNull('Аня', false)).toBe('Аня');
    expect(shownNameOrNull('Аня', undefined)).toBe('Аня');
  });

  it('пометка признаётся только строгим true', () => {
    expect(shownNameOrNull('Аня', 1 as unknown as boolean)).toBe('Аня');
  });

  it('нестроковая подпись не притворяется именем', () => {
    expect(shownNameOrNull(42 as unknown as string, false)).toBeNull();
    expect(shownNameOrNull({} as unknown as string, false)).toBeNull();
  });

  it('отличается от shownName ровно отсутствием запасного значения', () => {
    expect(shownName(null, false, 'Контакт')).toBe('Контакт');
    expect(shownNameOrNull(null, false)).toBeNull();
    expect(shownName(null, true, 'Контакт')).toBe(UNREADABLE_NAME_TEXT);
    expect(shownNameOrNull(null, true)).toBe(UNREADABLE_NAME_TEXT);
  });
});

describe('третье состояние доезжает от строки БД до списка', () => {
  it('GroupRow несёт пометку рядом с самой подписью', () => {
    const row = slice(readLocal(), 'export type GroupRow = {', '\n};');
    expect(row).toMatch(/^ {2}lastMessageSenderName: string \| null;$/m);
    expect(row).toMatch(/^ {2}lastMessageSenderNameUnreadable\?: boolean;$/m);
  });

  it('подпись читается тремя состояниями, а не decryptAtRestNullable', () => {
    const src = readLocal();
    expect(src).toContain(
      '...readLastSenderName((r.last_message_sender_name as string | null) ?? null, dek),'
    );
    expect(src).not.toContain('decryptAtRestNullable((r.last_message_sender_name');
  });

  it('readLastSenderName опирается на общий readNameCell', () => {
    const body = slice(readLocal(), 'function readLastSenderName(', '\n}\n');
    expect(body).toContain('readNameCell(stored, dek)');
    expect(body).toContain('lastMessageSenderName: cell.name');
    expect(body).toContain('lastMessageSenderNameUnreadable: cell.unreadable');
  });

  it('строка списка спрашивает правило, а не поле напрямую', () => {
    const src = readGroupsScreen();
    expect(src).toContain(
      'shownNameOrNull(item.lastMessageSenderName, item.lastMessageSenderNameUnreadable)'
    );
    expect(src).not.toContain("const senderLabel = isOutgoingLast ? 'Вы' : item.lastMessageSenderName;");
  });

  it('правило импортировано из общего модуля имён', () => {
    expect(readGroupsScreen()).toMatch(
      /^import \{[^}]*\bshownNameOrNull\b[^}]*\} from '\.\.\/\.\.\/core\/social\/unreadableName';$/m
    );
  });

  it('«Вы» по-прежнему важнее любой подписи', () => {
    const body = slice(readGroupsScreen(), 'const isOutgoingLast =', 'const draftUnreadable');
    expect(body.indexOf("? 'Вы'")).toBeLessThan(body.indexOf('shownNameOrNull('));
  });
});

describe('модуль имён остался чистым', () => {
  it('без RN, БД и сети — только такие же чистые соседи', () => {
    const imports = readNameModule()
      .split('\n')
      .filter((l) => l.startsWith('import '))
      .join('\n');
    expect(imports).toContain("from '../storage/unreadableText'");
    expect(imports).toContain("from './contactLabel'");
    expect(imports).not.toMatch(/react|sqlite|expo/i);
  });
});
