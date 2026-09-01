/**
 * v4.32.559: непрочитанное сообщение больше не выглядит как пустое.
 *
 * Проверяется и само правило, и то, что слой чтения переписки и группы
 * действительно перестал сводить «не открылось» и «нечего показать» к одной
 * пустой строке, а оба экрана научились это различие показывать.
 */
import fs from 'fs';
import path from 'path';

import { classifyAtRestCell } from '../atRestCell';
import {
  isUnreadableMessage,
  mayReuseMessageText,
  unreadableFromCellState,
  UNREADABLE_MESSAGE_TEXT,
} from '../unreadableText';

const read = (...rel: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');

const MODULE = (): string => read('unreadableText.ts');
const LOCAL = (): string => read('local.ts');
const CHAT = (): string => read('..', '..', 'ui', 'screens', 'ChatScreen.tsx');
const GROUPS = (): string => read('..', '..', 'ui', 'screens', 'GroupsScreen.tsx');

describe('признак непрочитанного текста', () => {
  it('непустой шифртекст, который не открылся, — непрочитан', () => {
    expect(unreadableFromCellState('unreadable')).toBe(true);
  });

  it('прочитанное и отсутствующее непрочитанным не считается', () => {
    expect(unreadableFromCellState('plain')).toBe(false);
    expect(unreadableFromCellState('absent')).toBe(false);
  });

  it('пустая подпись к снимку и непрочитанный столбец теперь различимы', () => {
    const empty = classifyAtRestCell('', '');
    const broken = classifyAtRestCell('enc2:AAAA', null);
    expect(unreadableFromCellState(empty.state)).toBe(false);
    expect(unreadableFromCellState(broken.state)).toBe(true);
  });

  it('признак читается только по своему полю, а не по пустому тексту', () => {
    expect(isUnreadableMessage({ unreadable: true })).toBe(true);
    expect(isUnreadableMessage({ unreadable: false })).toBe(false);
    expect(isUnreadableMessage({})).toBe(false);
    expect(isUnreadableMessage(null)).toBe(false);
    expect(isUnreadableMessage(undefined)).toBe(false);
  });
});

describe('пользоваться текстом, которого нет', () => {
  it('непрочитанное нельзя копировать, пересылать и править', () => {
    expect(mayReuseMessageText({ unreadable: true })).toBe(false);
  });

  it('обычное сообщение остаётся пригодным', () => {
    expect(mayReuseMessageText({})).toBe(true);
    expect(mayReuseMessageText({ unreadable: false })).toBe(true);
  });
});

describe('форма исходников', () => {
  it('модуль ни от чего не зависит', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });

  it('текст пометки не подменяет собой текст сообщения', () => {
    // Пометка — отдельное поле рядом с сообщением. Если бы она подменяла
    // текст, её пришлось бы отличать от настоящего текста в пересылке,
    // цитате, поиске и переводе — и рано или поздно она ушла бы в отправку.
    expect(UNREADABLE_MESSAGE_TEXT).toBe('Сообщение не удалось прочитать');
    expect(MODULE()).toContain(`export const UNREADABLE_MESSAGE_TEXT = '${UNREADABLE_MESSAGE_TEXT}';`);
    expect(LOCAL()).not.toContain('UNREADABLE_MESSAGE_TEXT');
  });

  it('оба списка сообщений разводят «не открылось» и «пусто»', () => {
    const src = LOCAL();
    // Признак идёт строкой ниже самого текста — считаем именно пару, а не все
    // упоминания unreadableFromCellState в файле: с v4.32.578 его же читает
    // избранное (см. starredUnreadable), и общий счёт по файлу больше не 2.
    expect((src.match(/text: cell\.state === 'plain' \? cell\.text : '',\n\s+unreadable: unreadableFromCellState\(cell\.state\),/g) ?? []).length).toBe(2);
    expect(src).not.toContain('text: decryptAtRestString(r.text, dek),\n      direction:');
  });

  it('обе строки таблиц несут признак', () => {
    // Проверка привязана к самим типам, а не к счёту по файлу: с v4.32.582
    // тот же признак носит и быстрый ответ (см. templateUnreadable), и общий
    // счёт перестал быть равен двум.
    const src = LOCAL();
    for (const name of ['ChatMessageRow', 'GroupMessageRow']) {
      const a = src.indexOf(`export type ${name} = {`);
      expect(a).toBeGreaterThan(-1);
      const b = src.indexOf('\n};', a);
      expect(b).toBeGreaterThan(a);
      expect(src.slice(a, b)).toContain('unreadable?: boolean;');
    }
  });

  it('переписка показывает пометку вместо пустого пузыря', () => {
    const src = CHAT();
    expect(src).toContain('{isUnreadableMessage(item) ? (');
    expect(src).toContain('{UNREADABLE_MESSAGE_TEXT}</Text>');
    // Пометка стоит раньше всех разборов текста: у непрочитанного сообщения
    // текст пуст, и ни один из них на него не сработает.
    expect(src.indexOf('{isUnreadableMessage(item) ? (')).toBeLessThan(
      src.indexOf(") : (item.text ?? '').startsWith(POLL_PREFIX) ? (")
    );
  });

  it('пересборка пузыря учитывает смену признака', () => {
    expect(CHAT()).toContain('prev.item.unreadable === next.item.unreadable &&');
  });

  it('группа показывает пометку и в подписи к снимку, и вместо текста', () => {
    const src = GROUPS();
    expect((src.match(/isUnreadableMessage\(item\)/g) ?? []).length).toBe(2);
    expect(src).toContain('mayReuseMessageText(item) && !item.text.startsWith(POLL_PREFIX)');
    expect(src).toContain('const canEdit = (isOwn || amAdmin) && mayReuseMessageText(item)');
  });
});
