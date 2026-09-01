/**
 * Наследное закрепление группы исчезало вместе с полосой (v4.32.603).
 *
 * У групп, заведённых до появления списка закреплений, объявление лежит в
 * колонке groups.pinned_message_text. Читалась она двумя состояниями:
 * `decryptAtRestNullable` отдаёт на неудаче пустую строку, а экран спрашивал
 * `(pinnedMsgText || grpPinnedList.length > 0)`. Пустая строка ложна — полоса
 * не рисовалась вовсе. То есть закрепление не «показывалось пустым» (это уже
 * разобрано в v4.32.576 для нового списка), а пропадало целиком: вместе с
 * текстом уходила и единственная кнопка, которой его можно было открепить, и
 * группа выглядела как группа без объявления.
 *
 * Здесь: третье состояние доезжает из колонки до полосы, полоса рисуется на
 * одной лишь пометке, наследная пометка гаснет при первом же значении из
 * списка, и — отдельно — в local.ts больше не осталось ни одного
 * двухсостоянийного чтения.
 */
import fs from 'fs';
import path from 'path';

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

describe('третье состояние доезжает от колонки до полосы', () => {
  it('GroupRow несёт пометку рядом с самим текстом', () => {
    const row = slice(readLocal(), 'export type GroupRow = {', '\n};');
    expect(row).toMatch(/^ {2}pinnedMessageText: string \| null;$/m);
    expect(row).toMatch(/^ {2}pinnedMessageTextUnreadable\?: boolean;$/m);
  });

  it('текст читается тремя состояниями, а не decryptAtRestNullable', () => {
    const src = readLocal();
    expect(src).toContain(
      '...readPinnedCell((r.pinned_message_text as string | null) ?? null, dek),'
    );
    expect(src).not.toContain('decryptAtRestNullable((r.pinned_message_text');
  });

  it('readPinnedCell отвечает через общие правила трёх состояний', () => {
    const body = slice(readLocal(), 'function readPinnedCell(', '\n}\n');
    expect(body).toContain('readAtRestCell(stored, dek)');
    expect(body).toContain('pinnedMessageText: cellTextOrNull(cell)');
    expect(body).toContain('pinnedMessageTextUnreadable: unreadableFromCellState(cell.state)');
  });

  it('в local.ts не осталось ни одного двухсостоянийного чтения', () => {
    const src = readLocal();
    // Упоминания в комментариях — это история дефектов, их считать не нужно.
    const codeLines = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    expect(codeLines.filter((l) => l.includes('decryptAtRestNullable(')).length).toBe(0);
    expect(src).not.toMatch(/^ {2}decryptAtRestNullable,$/m);
  });
});

describe('полоса рисуется на одной лишь пометке', () => {
  it('пустой текст с пометкой больше не считается «нечего закреплять»', () => {
    const src = readGroupsScreen();
    expect(src).toContain(
      '{(pinnedMsgText || pinnedMsgUnreadable || grpPinnedList.length > 0) ? (() => {'
    );
    expect(src).not.toContain('{(pinnedMsgText || grpPinnedList.length > 0) ? (() => {');
  });

  it('счётчик закреплений учитывает непрочитанное', () => {
    const src = readGroupsScreen();
    expect(src).toContain(
      'const total = Math.max(grpPinnedList.length, pinnedMsgText || pinnedMsgUnreadable ? 1 : 0);'
    );
  });

  it('у наследного текста своя пометка, а не пометка строки списка', () => {
    const body = slice(
      readGroupsScreen(),
      'const currentPinUnreadable =',
      'const currentPinId ='
    );
    expect(body).toContain('currentPin ? isUnreadableMessage(currentPin) : pinnedMsgUnreadable');
    expect(body).toContain('currentPinUnreadable ? UNREADABLE_MESSAGE_TEXT : pinnedMsgText');
  });

  it('пометка ставится вместо показа: сам текст наружу не подменяется', () => {
    const body = slice(
      readGroupsScreen(),
      'const currentPinUnreadable =',
      'const currentPinId ='
    );
    expect(body).not.toContain('setPinnedMsgText');
  });
});

describe('наследная пометка гаснет при первом значении из списка', () => {
  it('обёртка над сеттером гасит её в одном месте, а не в семи', () => {
    const src = readGroupsScreen();
    expect(src).toContain('const [pinnedMsgText, setPinnedMsgTextRaw] = useState<string | null>(');
    const body = slice(src, 'const setPinnedMsgText = useCallback(', '}, []);');
    expect(body).toContain('setPinnedMsgTextRaw(next);');
    expect(body).toContain('setPinnedMsgUnreadable(false);');
  });

  it('начальное значение пометки берётся из строки группы', () => {
    expect(readGroupsScreen()).toContain('group.pinnedMessageTextUnreadable === true');
  });

  it('прямой сеттер нигде не вызывается в обход обёртки', () => {
    const src = readGroupsScreen();
    // Одно объявление в useState и одно применение внутри обёртки — и всё.
    expect(src.split('setPinnedMsgTextRaw').length - 1).toBe(2);
  });

  it('все прежние вызовы остались на месте — обёртка их не отменяет', () => {
    const src = readGroupsScreen();
    expect(src.split('setPinnedMsgText(').length - 1).toBeGreaterThanOrEqual(7);
  });
});
