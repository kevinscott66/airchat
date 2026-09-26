/**
 * v4.32.985: удалить контакт стало откуда.
 *
 * Дефект. «Переименовать», «Заблокировать» и «Удалить» лежат в меню строки, а
 * меню открывалось единственным способом — долгим нажатием на строку. О долгом
 * нажатии не говорило ничего: ни подпись, ни подсказка, ни экран. Нарисован на
 * строке был ровно один значок — чат, — и он обещал обратное: что строка умеет
 * одно, открыть переписку.
 *
 * Цена. Удалить контакт было неоткуда. Ошибочно заведённая строка — опечатка в
 * ключе, чужой did из буфера, человек, с которым разошлись, — оставалась в
 * списке навсегда, а вместе с ней всё, что `deleteContact` снимает: общий
 * симметричный ключ, отметка «был в сети», личная заметка о человеке и корзина
 * удалённых сообщений переписки с ним.
 *
 * Правка. На строке появилась видимая кнопка «…», открывающая то же самое
 * меню. Долгое нажатие оставлено: оно работало и никому не мешает.
 *
 * Границы. Проверка идёт по исходнику: ContactsScreen в jest не поднимается —
 * он тянет Alert, Share, Clipboard и messaging-сервис. Поведение самого
 * удаления проверяют тесты contacts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SCREEN = readFileSync(join(__dirname, '..', 'ContactsScreen.tsx'), 'utf8');

/** Тело строки списка — от объявления до `const ContactRow = memo`. */
const ROW = (() => {
  const from = SCREEN.indexOf('function ContactRowImpl(');
  const to = SCREEN.indexOf('const ContactRow = memo(');
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return SCREEN.slice(from, to);
})();

describe('меню строки открывается не только долгим нажатием', () => {
  it('на строке нарисована кнопка, ведущая в меню', () => {
    expect(ROW).toContain('onPress={handleMenu}');
  });

  it('и это именно кнопка со своим именем, а не значок-украшение', () => {
    expect(ROW).toContain('accessibilityRole="button"');
    expect(ROW).toContain('accessibilityLabel={`Действия с контактом ');
  });

  it('долгое нажатие ведёт туда же — прежний способ не отняли', () => {
    expect(ROW).toContain('onLongPress={handleMenu}');
    expect(ROW).toContain('const handleMenu = useCallback(() => onMenu(item)');
  });

  it('нажатие на саму строку по-прежнему открывает переписку', () => {
    expect(ROW).toContain('const handlePress = useCallback(() => onPress(item.peerPublicKey)');
    expect(ROW).toContain('onPress={handlePress}');
  });

  it('список и правда отдаёт строке это меню', () => {
    expect(SCREEN).toContain('onMenu={openContextMenu}');
    // Прежнего имени свойства не осталось: иначе меню открывал бы кто-то один.
    expect(ROW).not.toContain('onLongPress: (item: Contact)');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: меню и правда умеет удалять', () => {
  it('пункт «Удалить» на месте и переспрашивает', () => {
    expect(SCREEN).toContain("text: 'Удалить',");
    expect(SCREEN).toContain("'Удалить контакт?',");
  });

  it('и доводит дело до самого удаления', () => {
    expect(SCREEN).toContain('await deleteContact(c.peerPublicKey);');
    expect(SCREEN).toContain("showSuccess('Контакт удалён');");
  });

  it('промах удаления человеку показывают, а не гасят', () => {
    expect(SCREEN).toContain("showError(userErrorText(e, 'Не удалось удалить контакт'));");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const CONTACTS = readFileSync(
    join(__dirname, '..', '..', '..', 'core', 'social', 'contacts.ts'),
    'utf8',
  );

  it('удаление по-прежнему единственный способ убрать строку из списка', () => {
    expect(CONTACTS).toContain('export async function deleteContact(peerPublicKeyB64: string): Promise<void> {');
  });

  it('и уносит с собой заметку и корзину — то, ради чего до него надо дойти', () => {
    expect(CONTACTS).toContain('await kvDeleteScoped(pid, contactNoteKey(peerPublicKeyB64));');
    expect(CONTACTS).toContain('await kvDeleteScoped(pid, recentlyDeletedKey(peerPublicKeyB64));');
    expect(CONTACTS).toContain('emitContactsChanged();');
  });
});
